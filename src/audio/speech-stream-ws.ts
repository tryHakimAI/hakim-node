/**
 * Realtime TTS over WebSocket (`WSS /v1/audio/speech/stream`).
 *
 * The SDK translates server frames into friendly `SpeechStreamEvent`s
 * and emits caller `sendSpeech({...})` requests as `speech.create`
 * frames upstream.
 *
 * Like the STT counterpart in `./stream.ts`, this helper stays
 * dependency-free. We prefer `globalThis.WebSocket` when present
 * (Node 22+, Bun, Deno, browsers). On Node 18/20 the global isn't
 * there — we dynamically import `ws` at runtime and surface a
 * helpful error if it's missing.
 *
 * The handle is lazy: the socket opens on the first `sendSpeech` /
 * iteration of `events` / `audio` / `close`. This keeps the hot
 * path fast and avoids dangling connections when a caller
 * constructs a handle but bails before using it.
 *
 * Binary chunks coming back from the server are surfaced as
 * `speech.audio` events (each carries a `chunk: Uint8Array`) so
 * consumers can iterate a single stream of events instead of
 * juggling a separate audio channel. The companion `audio` iterable
 * filters to those chunks for callers who only want raw PCM.
 */

import { ConnectionError, HakimError } from '../errors.js';
import type { Transport } from '../transport.js';
import type {
  SpeechStreamCreateRequest,
  SpeechStreamEvent,
  SpeechStreamHandle,
  SpeechStreamOptions,
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

export function openSpeechStream(
  transport: Transport,
  opts: SpeechStreamOptions = {},
): SpeechStreamHandle {
  const url = buildWsUrl(transport.baseURL);
  const apiKey = transport.apiKey;

  const pending: string[] = [];
  let socket: MinimalSocket | null = null;
  let openPromise: Promise<MinimalSocket> | null = null;

  const queue: SpeechStreamEvent[] = [];
  let waiter: ((v: IteratorResult<SpeechStreamEvent>) => void) | null = null;
  const audioQueue: Uint8Array[] = [];
  let audioWaiter: ((v: IteratorResult<Uint8Array>) => void) | null = null;
  let streamClosed = false;
  let closedResolve!: () => void;
  const closedPromise = new Promise<void>((r) => {
    closedResolve = r;
  });

  let requestSeq = 0;

  function emit(ev: SpeechStreamEvent): void {
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
      w({ value: undefined as unknown as SpeechStreamEvent, done: true });
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
      // Browser WebSocket: ask for arraybuffer so the message handler
      // sees ArrayBuffer rather than Blob (Node `ws` ignores this and
      // delivers Buffer regardless).
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

      // Send the initial session.update for any defaults the caller
      // pinned. The server applies these to every subsequent
      // speech.create that doesn't override the field per request.
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

  function sendSpeech(request: SpeechStreamCreateRequest): string {
    if (streamClosed) {
      throw new HakimError({
        type: 'invalid_request_error',
        code: 'stream_closed',
        message: 'Hakim SDK: cannot send speech; stream is closed.',
        status: 400,
        requestId: undefined,
      });
    }
    if (typeof request.input !== 'string' || request.input.length === 0) {
      throw new HakimError({
        type: 'invalid_request_error',
        code: 'input_required',
        message: 'Hakim SDK: sendSpeech({ input }) must be a non-empty string.',
        status: 400,
        requestId: undefined,
      });
    }
    const requestId = request.request_id ?? `wst_local_${(requestSeq++).toString(36)}`;
    const frame: Record<string, unknown> = {
      type: 'speech.create',
      input: request.input,
      request_id: requestId,
    };
    if (request.voice !== undefined) frame.voice = request.voice;
    if (request.model !== undefined) frame.model = request.model;
    if (request.cfg !== undefined) frame.cfg = request.cfg;
    if (request.voice_prompt !== undefined) frame.voice_prompt = request.voice_prompt;
    enqueueFrame(JSON.stringify(frame));
    return requestId;
  }

  function updateSession(session: Partial<SpeechStreamOptions>): void {
    if (streamClosed) {
      throw new HakimError({
        type: 'invalid_request_error',
        code: 'stream_closed',
        message: 'Hakim SDK: cannot update session; stream is closed.',
        status: 400,
        requestId: undefined,
      });
    }
    // Merge into the local defaults so a later lazy open picks them up
    // even if the socket wasn't open yet when updateSession was called.
    if (session.model !== undefined) opts.model = session.model;
    if (session.voice !== undefined) opts.voice = session.voice;
    if (session.cfg !== undefined) opts.cfg = session.cfg;
    if (session.voice_prompt !== undefined) opts.voice_prompt = session.voice_prompt;
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

  const events: AsyncIterable<SpeechStreamEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<SpeechStreamEvent> {
      return {
        next(): Promise<IteratorResult<SpeechStreamEvent>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (streamClosed) {
            return Promise.resolve({
              value: undefined as unknown as SpeechStreamEvent,
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
        return(): Promise<IteratorResult<SpeechStreamEvent>> {
          close().catch(() => undefined);
          return Promise.resolve({
            value: undefined as unknown as SpeechStreamEvent,
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
    sendSpeech,
    updateSession,
    events,
    audio,
    close,
    closed: closedPromise,
  };
}

function attachSocketHandlers(
  s: MinimalSocket,
  emit: (ev: SpeechStreamEvent) => void,
  finishStream: () => void,
): void {
  // Track the last request_id seen on the wire so we can attach it
  // to binary audio frames (which carry no envelope of their own).
  // The server always emits `speech.started` before any audio chunk
  // for that utterance, so this is a safe single-cursor approach.
  let currentRequestId: string | null = null;

  const onMessage = (raw: unknown, maybeIsBinary?: unknown): void => {
    const binary = decodeBinary(raw, maybeIsBinary);
    if (binary !== null) {
      if (currentRequestId === null) return;
      emit({ type: 'speech.audio', request_id: currentRequestId, chunk: binary });
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
      currentRequestId = translated.request_id;
    }
    emit(translated);
    if (translated.type === 'speech.done' || (translated.type === 'error' && translated.fatal)) {
      // Don't reset on .done — the next .started arrives with its
      // own request_id and overwrites cleanly. Resetting here would
      // race with a follow-up binary frame the engine queued before
      // we processed the .done text frame.
    }
  };
  const onClose = (): void => {
    finishStream();
  };
  addListener(s, 'message', onMessage);
  addListener(s, 'close', onClose);
}

/** Try to extract binary payload from the on('message', ...) raw arg.
 *  Returns null when the frame is text. */
function decodeBinary(raw: unknown, maybeIsBinary?: unknown): Uint8Array | null {
  // Node `ws` emits (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean)
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
  // Browser MessageEvent: `{ data: string | ArrayBuffer | Blob }`.
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
    // Node `ws` fragmented text frames arrive as Buffer[].
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

export function translateFrame(frame: unknown): SpeechStreamEvent | null {
  if (!frame || typeof frame !== 'object') return null;
  const f = frame as { type?: unknown };
  switch (f.type) {
    case 'speech.started': {
      const d = frame as {
        request_id?: unknown;
        characters?: unknown;
        sample_rate?: unknown;
        encoding?: unknown;
        channels?: unknown;
        model?: unknown;
        voice?: unknown;
      };
      if (typeof d.request_id !== 'string') return null;
      return {
        type: 'speech.started',
        request_id: d.request_id,
        characters: typeof d.characters === 'number' ? d.characters : 0,
        sample_rate: typeof d.sample_rate === 'number' ? d.sample_rate : 24000,
        encoding: 'pcm_s16le',
        channels: 1,
        model: typeof d.model === 'string' ? d.model : 'hakim-fast-v1',
        voice: typeof d.voice === 'string' ? d.voice : 'unknown',
      };
    }
    case 'speech.done': {
      const d = frame as { request_id?: unknown; duration_ms?: unknown; usage?: unknown };
      if (typeof d.request_id !== 'string') return null;
      return {
        type: 'speech.done',
        request_id: d.request_id,
        duration_ms: typeof d.duration_ms === 'number' ? d.duration_ms : 0,
        usage: d.usage as UsageBlock,
      };
    }
    case 'session.usage': {
      const d = frame as { session_characters?: unknown; usage?: unknown };
      return {
        type: 'session.usage',
        session_characters: typeof d.session_characters === 'number' ? d.session_characters : 0,
        usage: d.usage as UsageBlock,
      };
    }
    case 'error': {
      const d = frame as {
        code?: unknown;
        message?: unknown;
        retryable?: unknown;
        fatal?: unknown;
        request_id?: unknown;
      };
      const out: SpeechStreamEvent = {
        type: 'error',
        code: typeof d.code === 'string' ? d.code : 'unknown_error',
        message: typeof d.message === 'string' ? d.message : 'unknown error',
        retryable: d.retryable === true,
        fatal: d.fatal === true,
      };
      if (typeof d.request_id === 'string') out.request_id = d.request_id;
      return out;
    }
    case 'session.created':
      // Informational — surfaces session ids + limits in the server
      // log; SDK consumers don't need to branch on it.
      return null;
    default:
      return null;
  }
}

export function buildSessionUpdate(
  session: Partial<SpeechStreamOptions>,
): { type: 'session.update'; session: Record<string, unknown> } | null {
  const out: Record<string, unknown> = {};
  if (session.model !== undefined) out.model = session.model;
  if (session.voice !== undefined) out.voice = session.voice;
  if (session.cfg !== undefined) out.cfg = session.cfg;
  if (session.voice_prompt !== undefined) out.voice_prompt = session.voice_prompt;
  if (Object.keys(out).length === 0) return null;
  return { type: 'session.update', session: out };
}

function buildWsUrl(baseURL: string): string {
  const u = new URL(baseURL);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = u.pathname.replace(/\/$/, '') + '/v1/audio/speech/stream';
  return u.toString();
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
      // Computed specifier so `tsc` doesn't try to resolve `ws`'s
      // types at compile time (the SDK ships zero deps; `ws` is
      // only resolved at runtime on older Node).
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
          'Hakim SDK: realtime TTS requires a WebSocket implementation. On Node 22+ / Bun / Deno / browsers it is built in. On Node 18 / 20, run `npm install ws` alongside @hakim/voice. ' +
          (err instanceof Error ? `(cause: ${err.message})` : ''),
        status: 0,
        requestId: undefined,
      });
    }
  })();
  return _socketCtorPromise;
}

export const __internals = { translateFrame, buildSessionUpdate, buildWsUrl };
