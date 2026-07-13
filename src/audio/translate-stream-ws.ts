/**
 * Realtime translate over WebSocket (`WSS /v1/audio/translate/stream`).
 *
 * The SDK chains caller-supplied source audio (`sendAudio()` → base64
 * `input_audio_buffer.append`) into the proxy and translates server
 * frames into friendly `TranslateStreamEvent`s — STT partials + finals,
 * LLM partials + finals, TTS started + binary audio + done, and a
 * cross-modality `session.usage` rollup.
 *
 * Same dependency posture as the STT/TTS helpers: prefer
 * `globalThis.WebSocket` when present (Node 22+, Bun, Deno, browsers).
 * On Node 18/20 the global isn't there — we dynamically import `ws`
 * at runtime and surface a helpful error if it's missing.
 *
 * The handle is lazy: the socket opens on the first `sendAudio` /
 * iteration / `close`. This keeps the hot path fast and avoids
 * dangling connections when a caller constructs a handle but bails
 * before using it.
 */

import { ConnectionError, HakimError } from '../errors.js';
import type { Transport } from '../transport.js';
import type {
  TranslateStreamEvent,
  TranslateStreamHandle,
  TranslateStreamOptions,
  UsageBlock,
} from '../types.js';
import { SDK_NAME, SDK_VERSION } from '../version.js';

interface MinimalSocket {
  readonly readyState: number;
  binaryType?: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener?(type: string, listener: (ev: unknown) => void): void;
  on?(event: string, listener: (...args: unknown[]) => void): void;
}

type SocketCtor = new (url: string, options?: unknown) => MinimalSocket;

export function openTranslateStream(
  transport: Transport,
  opts: TranslateStreamOptions = {},
): TranslateStreamHandle {
  const url = buildWsUrl(transport.baseURL);
  const apiKey = transport.apiKey;

  const pending: string[] = [];
  let socket: MinimalSocket | null = null;
  let openPromise: Promise<MinimalSocket> | null = null;

  const queue: TranslateStreamEvent[] = [];
  let waiter: ((v: IteratorResult<TranslateStreamEvent>) => void) | null = null;
  const audioQueue: Uint8Array[] = [];
  let audioWaiter: ((v: IteratorResult<Uint8Array>) => void) | null = null;
  let streamClosed = false;
  let closedResolve!: () => void;
  const closedPromise = new Promise<void>((r) => {
    closedResolve = r;
  });

  function emit(ev: TranslateStreamEvent): void {
    if (streamClosed) return;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w({ value: ev, done: false });
    } else {
      queue.push(ev);
    }
    if (ev.type === 'speech.audio') {
      if (audioWaiter) {
        const w = audioWaiter;
        audioWaiter = null;
        w({ value: ev.chunk, done: false });
      } else {
        audioQueue.push(ev.chunk);
      }
    }
  }

  function finishStream(): void {
    if (streamClosed) return;
    streamClosed = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w({ value: undefined as unknown as TranslateStreamEvent, done: true });
    }
    if (audioWaiter) {
      const w = audioWaiter;
      audioWaiter = null;
      w({ value: undefined as unknown as Uint8Array, done: true });
    }
    closedResolve();
  }

  async function ensureOpen(): Promise<MinimalSocket> {
    if (socket) return socket;
    if (openPromise) return openPromise;

    openPromise = (async () => {
      const Ctor = await resolveSocketCtor();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': `${SDK_NAME}/${SDK_VERSION}`,
      };
      const s = new Ctor(url, { headers });
      try {
        s.binaryType = 'arraybuffer';
      } catch {
        /* soft-fail · some socket impls reject the assignment */
      }

      await new Promise<void>((resolve, reject) => {
        const onOpen = (): void => {
          detach();
          resolve();
        };
        const onError = (err: unknown): void => {
          detach();
          reject(
            new ConnectionError({
              message:
                'Hakim SDK: could not open WebSocket to ' +
                `${url}. Is HAKIM_API_KEY valid and the network reachable?` +
                (err instanceof Error ? ` Cause: ${err.message}` : ''),
              requestId: undefined,
            }),
          );
        };
        const detach = (): void => {
          removeListener(s, 'open', onOpen);
          removeListener(s, 'error', onError as (...args: unknown[]) => void);
        };
        addListener(s, 'open', onOpen);
        addListener(s, 'error', onError);
      });

      attachSocketHandlers(s, emit, finishStream);
      socket = s;

      const sessionUpdate = buildSessionUpdate(opts);
      if (sessionUpdate) {
        s.send(JSON.stringify(sessionUpdate));
      }
      for (const frame of pending.splice(0)) {
        s.send(frame);
      }
      return s;
    })();

    return openPromise;
  }

  function enqueueFrame(frame: string): void {
    if (socket && socket.readyState === 1 /* OPEN */) {
      socket.send(frame);
    } else {
      pending.push(frame);
      ensureOpen().catch((err) => {
        if (err instanceof HakimError || err instanceof ConnectionError) {
          emit({
            type: 'error',
            code: (err as { code?: string }).code ?? 'connection_error',
            message: err.message,
            retryable: false,
            fatal: true,
          });
        }
        finishStream();
      });
    }
  }

  function sendAudio(chunk: Uint8Array | ArrayBuffer | ArrayBufferView | Buffer): void {
    if (streamClosed) {
      throw new HakimError({
        type: 'invalid_request_error',
        code: 'stream_closed',
        message: 'Hakim SDK: cannot send audio; stream is closed.',
        status: 400,
        requestId: undefined,
      });
    }
    const bytes = toUint8Array(chunk);
    const frame: Record<string, unknown> = {
      type: 'input_audio_buffer.append',
      audio: bufferToBase64(bytes),
    };
    const durationMs = estimateAudioMs(
      bytes.byteLength,
      opts.input_sample_rate ?? 16000,
      opts.input_audio_format ?? 'pcm16',
    );
    if (durationMs !== undefined) frame.audio_ms = durationMs;
    enqueueFrame(JSON.stringify(frame));
  }

  function commitAudio(): void {
    if (streamClosed) {
      throw new HakimError({
        type: 'invalid_request_error',
        code: 'stream_closed',
        message: 'Hakim SDK: cannot commit audio; stream is closed.',
        status: 400,
        requestId: undefined,
      });
    }
    enqueueFrame(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  }

  function updateSession(session: Partial<TranslateStreamOptions>): void {
    if (streamClosed) {
      throw new HakimError({
        type: 'invalid_request_error',
        code: 'stream_closed',
        message: 'Hakim SDK: cannot update session; stream is closed.',
        status: 400,
        requestId: undefined,
      });
    }
    for (const key of [
      'target_language',
      'source_language',
      'voice',
      'gender',
      'model_stt',
      'model_llm',
      'model_tts',
      'cfg',
      'input_audio_format',
      'input_sample_rate',
      'partials',
      'system_prompt',
    ] as const) {
      const value = session[key];
      if (value !== undefined) {
        (opts as Record<string, unknown>)[key] = value;
      }
    }
    const upd = buildSessionUpdate(session);
    if (upd) enqueueFrame(JSON.stringify(upd));
  }

  async function close(): Promise<void> {
    if (streamClosed) return;
    enqueueFrame(JSON.stringify({ type: 'session.close' }));
    await closedPromise;
  }

  if (opts.signal) {
    if (opts.signal.aborted) {
      Promise.resolve()
        .then(() => close())
        .catch(() => undefined);
    } else {
      opts.signal.addEventListener(
        'abort',
        () => {
          close().catch(() => undefined);
        },
        { once: true },
      );
    }
  }

  const events: AsyncIterable<TranslateStreamEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<TranslateStreamEvent> {
      return {
        next(): Promise<IteratorResult<TranslateStreamEvent>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (streamClosed) {
            return Promise.resolve({
              value: undefined as unknown as TranslateStreamEvent,
              done: true,
            });
          }
          return new Promise((resolve) => {
            waiter = resolve;
            if (!socket && !openPromise) {
              ensureOpen().catch((err) => {
                if (!streamClosed) {
                  emit({
                    type: 'error',
                    code: (err as { code?: string })?.code ?? 'connection_error',
                    message: err instanceof Error ? err.message : 'connection error',
                    retryable: false,
                    fatal: true,
                  });
                  finishStream();
                }
              });
            }
          });
        },
        return(): Promise<IteratorResult<TranslateStreamEvent>> {
          close().catch(() => undefined);
          return Promise.resolve({
            value: undefined as unknown as TranslateStreamEvent,
            done: true,
          });
        },
      };
    },
  };

  const audio: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          if (audioQueue.length > 0) {
            return Promise.resolve({ value: audioQueue.shift()!, done: false });
          }
          if (streamClosed) {
            return Promise.resolve({
              value: undefined as unknown as Uint8Array,
              done: true,
            });
          }
          return new Promise((resolve) => {
            audioWaiter = resolve;
            if (!socket && !openPromise) {
              ensureOpen().catch((err) => {
                if (!streamClosed) {
                  emit({
                    type: 'error',
                    code: (err as { code?: string })?.code ?? 'connection_error',
                    message: err instanceof Error ? err.message : 'connection error',
                    retryable: false,
                    fatal: true,
                  });
                  finishStream();
                }
              });
            }
          });
        },
        return(): Promise<IteratorResult<Uint8Array>> {
          close().catch(() => undefined);
          return Promise.resolve({
            value: undefined as unknown as Uint8Array,
            done: true,
          });
        },
      };
    },
  };

  return {
    sendAudio,
    commitAudio,
    updateSession,
    events,
    audio,
    close,
    closed: closedPromise,
  };
}

function attachSocketHandlers(
  s: MinimalSocket,
  emit: (ev: TranslateStreamEvent) => void,
  finishStream: () => void,
): void {
  // Track the last utterance_id seen on the wire so we can attach it
  // to binary audio frames (which carry no envelope of their own).
  // The proxy guarantees `speech.started` always precedes the first
  // audio chunk for an utterance.
  let currentUtteranceId: string | null = null;

  const onMessage = (raw: unknown, maybeIsBinary?: unknown): void => {
    const binary = decodeBinary(raw, maybeIsBinary);
    if (binary !== null) {
      if (currentUtteranceId === null) return;
      emit({ type: 'speech.audio', utterance_id: currentUtteranceId, chunk: binary });
      return;
    }
    const text = extractMessageText(raw);
    if (text === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const translated = translateFrame(parsed);
    if (!translated) return;
    if (translated.type === 'speech.started') {
      currentUtteranceId = translated.utterance_id;
    }
    emit(translated);
  };
  const onClose = (): void => {
    finishStream();
  };
  addListener(s, 'message', onMessage);
  addListener(s, 'close', onClose);
}

function decodeBinary(raw: unknown, maybeIsBinary?: unknown): Uint8Array | null {
  if (maybeIsBinary === true) {
    if (raw instanceof Uint8Array) return raw;
    if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
    if (Array.isArray(raw)) {
      const total = raw.reduce<number>(
        (n, b: unknown) => n + ((b as Uint8Array)?.byteLength ?? 0),
        0,
      );
      const out = new Uint8Array(total);
      let off = 0;
      for (const b of raw as Uint8Array[]) {
        out.set(b, off);
        off += b.byteLength;
      }
      return out;
    }
  }
  if (raw && typeof raw === 'object' && 'data' in raw) {
    const d = (raw as { data: unknown }).data;
    if (d instanceof ArrayBuffer) return new Uint8Array(d);
    if (ArrayBuffer.isView(d) && d instanceof Uint8Array) return d;
  }
  return null;
}

function extractMessageText(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && 'data' in raw) {
    const d = (raw as { data: unknown }).data;
    if (typeof d === 'string') return d;
    return null;
  }
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  if (Array.isArray(raw)) {
    try {
      const parts = raw as Uint8Array[];
      const total = parts.reduce<number>((n, b) => n + b.byteLength, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const b of parts) {
        out.set(b, off);
        off += b.byteLength;
      }
      return new TextDecoder().decode(out);
    } catch {
      return null;
    }
  }
  return null;
}

export function translateFrame(frame: unknown): TranslateStreamEvent | null {
  if (!frame || typeof frame !== 'object') return null;
  const f = frame as { type?: unknown };
  switch (f.type) {
    case 'session.created': {
      const d = frame as {
        session_id?: unknown;
        voice_id?: unknown;
        voice_slug?: unknown;
        model_stt?: unknown;
        model_llm?: unknown;
        model_tts?: unknown;
      };
      if (
        typeof d.session_id !== 'string' ||
        typeof d.voice_id !== 'string' ||
        typeof d.voice_slug !== 'string' ||
        typeof d.model_stt !== 'string' ||
        typeof d.model_llm !== 'string' ||
        typeof d.model_tts !== 'string'
      ) {
        return null;
      }
      return {
        type: 'session.created',
        session_id: d.session_id,
        voice_id: d.voice_id,
        voice_slug: d.voice_slug,
        model_stt: d.model_stt,
        model_llm: d.model_llm,
        model_tts: d.model_tts,
      };
    }
    case 'transcription.delta': {
      const d = frame as { utterance_id?: unknown; text?: unknown; is_final?: unknown };
      if (typeof d.utterance_id !== 'string' || typeof d.text !== 'string') return null;
      return {
        type: 'transcription.delta',
        utterance_id: d.utterance_id,
        text: d.text,
        is_final: d.is_final === true,
      };
    }
    case 'transcription.done': {
      const d = frame as {
        utterance_id?: unknown;
        text?: unknown;
        language?: unknown;
        audio_ms?: unknown;
        usage?: unknown;
      };
      if (typeof d.utterance_id !== 'string' || typeof d.text !== 'string') return null;
      const out: TranslateStreamEvent = {
        type: 'transcription.done',
        utterance_id: d.utterance_id,
        text: d.text,
        audio_ms: typeof d.audio_ms === 'number' ? d.audio_ms : 0,
        usage: d.usage as UsageBlock,
      };
      if (typeof d.language === 'string') {
        (out as { language?: string }).language = d.language;
      }
      return out;
    }
    case 'translation.delta': {
      const d = frame as { utterance_id?: unknown; text?: unknown };
      if (typeof d.utterance_id !== 'string' || typeof d.text !== 'string') return null;
      return { type: 'translation.delta', utterance_id: d.utterance_id, text: d.text };
    }
    case 'translation.done': {
      const d = frame as { utterance_id?: unknown; text?: unknown; usage?: unknown };
      if (typeof d.utterance_id !== 'string' || typeof d.text !== 'string') return null;
      return {
        type: 'translation.done',
        utterance_id: d.utterance_id,
        text: d.text,
        usage: d.usage as UsageBlock,
      };
    }
    case 'speech.started': {
      const d = frame as {
        utterance_id?: unknown;
        characters?: unknown;
        sample_rate?: unknown;
        voice_id?: unknown;
      };
      if (typeof d.utterance_id !== 'string') return null;
      return {
        type: 'speech.started',
        utterance_id: d.utterance_id,
        characters: typeof d.characters === 'number' ? d.characters : 0,
        sample_rate: typeof d.sample_rate === 'number' ? d.sample_rate : 24000,
        encoding: 'pcm_s16le',
        channels: 1,
        voice_id: typeof d.voice_id === 'string' ? d.voice_id : 'unknown',
      };
    }
    case 'speech.done': {
      const d = frame as { utterance_id?: unknown; duration_ms?: unknown; usage?: unknown };
      if (typeof d.utterance_id !== 'string') return null;
      return {
        type: 'speech.done',
        utterance_id: d.utterance_id,
        duration_ms: typeof d.duration_ms === 'number' ? d.duration_ms : 0,
        usage: d.usage as UsageBlock,
      };
    }
    case 'session.usage': {
      const d = frame as { session_id?: unknown; totals?: unknown };
      if (typeof d.session_id !== 'string' || !d.totals || typeof d.totals !== 'object') {
        return null;
      }
      const t = d.totals as Record<string, unknown>;
      return {
        type: 'session.usage',
        session_id: d.session_id,
        totals: {
          stt_audio_ms: typeof t.stt_audio_ms === 'number' ? t.stt_audio_ms : 0,
          llm_tokens: typeof t.llm_tokens === 'number' ? t.llm_tokens : 0,
          tts_characters: typeof t.tts_characters === 'number' ? t.tts_characters : 0,
          credits: typeof t.credits === 'number' ? t.credits : 0,
          cost_usd: typeof t.cost_usd === 'string' ? t.cost_usd : '0',
        },
      };
    }
    case 'error': {
      const d = frame as {
        code?: unknown;
        message?: unknown;
        retryable?: unknown;
        fatal?: unknown;
        utterance_id?: unknown;
      };
      const out: TranslateStreamEvent = {
        type: 'error',
        code: typeof d.code === 'string' ? d.code : 'unknown_error',
        message: typeof d.message === 'string' ? d.message : 'unknown error',
        retryable: d.retryable === true,
        fatal: d.fatal === true,
      };
      if (typeof d.utterance_id === 'string') {
        (out as { utterance_id?: string }).utterance_id = d.utterance_id;
      }
      return out;
    }
    default:
      return null;
  }
}

export function buildSessionUpdate(
  session: Partial<TranslateStreamOptions>,
): { type: 'session.update'; session: Record<string, unknown> } | null {
  const out: Record<string, unknown> = {};
  if (session.target_language !== undefined) out.target_language = session.target_language;
  if (session.source_language !== undefined) out.source_language = session.source_language;
  if (session.voice !== undefined) out.voice = session.voice;
  if (session.gender !== undefined) out.gender = session.gender;
  if (session.model_stt !== undefined) out.model_stt = session.model_stt;
  if (session.model_llm !== undefined) out.model_llm = session.model_llm;
  if (session.model_tts !== undefined) out.model_tts = session.model_tts;
  if (session.cfg !== undefined) out.cfg = session.cfg;
  if (session.input_audio_format !== undefined) out.input_audio_format = session.input_audio_format;
  if (session.input_sample_rate !== undefined) out.input_sample_rate = session.input_sample_rate;
  if (session.partials !== undefined) out.partials = session.partials;
  if (session.system_prompt !== undefined) out.system_prompt = session.system_prompt;
  if (Object.keys(out).length === 0) return null;
  return { type: 'session.update', session: out };
}

function buildWsUrl(baseURL: string): string {
  const u = new URL(baseURL);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = u.pathname.replace(/\/$/, '') + '/v1/audio/translate/stream';
  return u.toString();
}

function estimateAudioMs(
  byteLength: number,
  sampleRate: number,
  format: 'pcm16' | 'opus' | 'mulaw',
): number | undefined {
  if (format === 'pcm16' && sampleRate > 0) {
    return Math.round((byteLength / 2 / sampleRate) * 1000);
  }
  // Opus + mulaw frame sizing is codec-dependent; let the server's
  // byte-derived floor take over rather than guess.
  return undefined;
}

function toUint8Array(chunk: Uint8Array | ArrayBuffer | ArrayBufferView | Buffer): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new HakimError({
    type: 'invalid_request_error',
    code: 'invalid_audio_chunk',
    message: `Hakim SDK: unsupported audio chunk type (${typeof chunk}). Pass a Uint8Array, Buffer, ArrayBuffer, or ArrayBufferView.`,
    status: 400,
    requestId: undefined,
  });
}

function bufferToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function addListener(
  socket: MinimalSocket,
  type: string,
  listener: (ev: unknown, maybeIsBinary?: unknown) => void,
): void {
  if (socket.addEventListener) {
    socket.addEventListener(type, listener as (ev: unknown) => void);
  } else if (socket.on) {
    socket.on(type, listener as (...args: unknown[]) => void);
  }
}

function removeListener(
  socket: MinimalSocket,
  type: string,
  listener: (ev: unknown) => void,
): void {
  const s = socket as {
    removeEventListener?: (t: string, l: (ev: unknown) => void) => void;
    off?: (t: string, l: (ev: unknown) => void) => void;
  };
  if (s.removeEventListener) s.removeEventListener(type, listener);
  else if (s.off) s.off(type, listener);
}

let _socketCtor: SocketCtor | null = null;
let _socketCtorPromise: Promise<SocketCtor> | null = null;

async function resolveSocketCtor(): Promise<SocketCtor> {
  if (_socketCtor) return _socketCtor;
  if (_socketCtorPromise) return _socketCtorPromise;

  const globalWs = (globalThis as { WebSocket?: SocketCtor }).WebSocket;
  if (globalWs) {
    _socketCtor = globalWs;
    return globalWs;
  }

  _socketCtorPromise = (async () => {
    try {
      const mod = await (
        new Function('s', 'return import(s)') as (
          s: string,
        ) => Promise<{ default?: SocketCtor; WebSocket?: SocketCtor }>
      )('ws');
      const Ctor = mod.default ?? mod.WebSocket;
      if (!Ctor) throw new Error('ws module did not export a WebSocket class');
      _socketCtor = Ctor;
      return Ctor;
    } catch (err) {
      throw new HakimError({
        type: 'invalid_request_error',
        code: 'websocket_impl_missing',
        message:
          'Hakim SDK: realtime translate requires a WebSocket implementation. On Node 22+ / Bun / Deno / browsers it is built in. On Node 18 / 20, run `npm install ws` alongside @hakim/voice. ' +
          (err instanceof Error ? `(cause: ${err.message})` : ''),
        status: 0,
        requestId: undefined,
      });
    }
  })();
  return _socketCtorPromise;
}

export const __internals = { translateFrame, buildSessionUpdate, buildWsUrl, estimateAudioMs };
