/**
 * Realtime STT over WebSocket (`WSS /v1/audio/transcriptions/stream`).
 *
 * The SDK translates the server's `session.created` / `transcription.delta`
 * / `transcription.done` / `error` frames into friendly
 * `TranscriptionStreamEvent`s and translates caller audio chunks into
 * base64-encoded `input_audio_buffer.append` frames.
 *
 * The SDK stays dependency-free. We prefer `globalThis.WebSocket` when
 * present (Node 22+, Bun, Deno, browsers). On Node 18/20 the global
 * isn't there — we dynamically import `ws` at runtime. Consumers on
 * those engines must install `ws` alongside `@tryhakim/voice`; we surface
 * a helpful error if it's missing instead of blowing up with an
 * opaque module-not-found trace.
 *
 * The handle is lazy: the WebSocket opens on the first call to
 * `sendAudio` / `close` / the first consumer iteration of `events`.
 * This keeps the hot path fast and avoids dangling connections when a
 * caller creates a handle but bails before sending anything.
 */

import { ConnectionError, HakimError } from '../errors.js';
import type { Transport } from '../transport.js';
import type {
  TranscriptionFinalEvent,
  TranscriptionPartialEvent,
  TranscriptionStreamEvent,
  TranscriptionStreamHandle,
  TranscriptionStreamOptions,
  TranscriptionUsageEvent,
} from '../types.js';
import { SDK_NAME, SDK_VERSION } from '../version.js';

// Subset of the native WebSocket surface we need. Keeping it minimal
// means both `globalThis.WebSocket` and `ws` satisfy the contract.
interface MinimalSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener?(type: string, listener: (ev: unknown) => void): void;
  on?(event: string, listener: (...args: unknown[]) => void): void;
}

type SocketCtor = new (url: string, options?: unknown) => MinimalSocket;

export function openTranscriptionStream(
  transport: Transport,
  opts: TranscriptionStreamOptions,
): TranscriptionStreamHandle {
  const url = buildWsUrl(transport.baseURL);
  const apiKey = transport.apiKey;

  // Accumulated audio chunks / control frames queued before the socket
  // is OPEN. Flushed in-order on open.
  const pending: string[] = [];
  let socket: MinimalSocket | null = null;
  let openPromise: Promise<MinimalSocket> | null = null;

  const queue: TranscriptionStreamEvent[] = [];
  let waiter: ((v: IteratorResult<TranscriptionStreamEvent>) => void) | null = null;
  let streamClosed = false;
  let closedResolve!: () => void;
  const closedPromise = new Promise<void>((r) => {
    closedResolve = r;
  });

  function emit(ev: TranscriptionStreamEvent): void {
    if (streamClosed) return;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w({ value: ev, done: false });
    } else {
      queue.push(ev);
    }
  }

  function finishStream(): void {
    if (streamClosed) return;
    streamClosed = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w({ value: undefined as unknown as TranscriptionStreamEvent, done: true });
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
      // `ws` on Node takes `{ headers }` as second arg; the browser
      // `WebSocket` ignores extra args — in the browser the auth has
      // to come from a subprotocol token. For the SDK-in-Node path we
      // always have headers available; for custom browser usage, the
      // caller should pre-construct a socket (future extension point).
      const s = new Ctor(url, { headers });

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
      // Send the initial session.update using the caller's opts.
      const sessionUpdate = buildSessionUpdate(opts);
      if (sessionUpdate) {
        s.send(JSON.stringify(sessionUpdate));
      }
      // Flush anything queued while we were connecting.
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
      // Fire-and-forget the open; errors surface on the iterator.
      ensureOpen().catch((err) => {
        if (err instanceof HakimError || err instanceof ConnectionError) {
          emit({
            type: 'error',
            code: (err as { code?: string }).code ?? 'connection_error',
            message: err.message,
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
      opts.sample_rate ?? 16000,
      opts.audio_format ?? 'pcm16',
    );
    if (durationMs !== undefined) frame.audio_ms = durationMs;
    enqueueFrame(JSON.stringify(frame));
  }

  async function close(): Promise<void> {
    if (streamClosed) return;
    // Commit any buffered audio, then ask the server to close.
    enqueueFrame(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    enqueueFrame(JSON.stringify({ type: 'session.close' }));
    // Wait for the server to emit `usage` + close the socket.
    await closedPromise;
  }

  // Wire the caller-supplied AbortSignal to a clean close.
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

  const events: AsyncIterable<TranscriptionStreamEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<TranscriptionStreamEvent> {
      return {
        next(): Promise<IteratorResult<TranscriptionStreamEvent>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (streamClosed) {
            return Promise.resolve({
              value: undefined as unknown as TranscriptionStreamEvent,
              done: true,
            });
          }
          return new Promise((resolve) => {
            waiter = resolve;
            // Opening lazily: if the caller started by iterating
            // events (without any sendAudio yet), kick the socket
            // open so `session.created` / `error` can land.
            if (!socket && !openPromise) {
              ensureOpen().catch((err) => {
                if (!streamClosed) {
                  emit({
                    type: 'error',
                    code: (err as { code?: string })?.code ?? 'connection_error',
                    message: err instanceof Error ? err.message : 'connection error',
                  });
                  finishStream();
                }
              });
            }
          });
        },
        return(): Promise<IteratorResult<TranscriptionStreamEvent>> {
          close().catch(() => undefined);
          return Promise.resolve({
            value: undefined as unknown as TranscriptionStreamEvent,
            done: true,
          });
        },
      };
    },
  };

  return {
    sendAudio,
    events,
    close,
    closed: closedPromise,
  };
}

function attachSocketHandlers(
  s: MinimalSocket,
  emit: (ev: TranscriptionStreamEvent) => void,
  finishStream: () => void,
): void {
  const onMessage = (raw: unknown): void => {
    // In `ws` Node, raw is a Buffer-like; in browsers, raw.data is a
    // string. Normalise.
    const text = extractMessageText(raw);
    if (text === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const translated = translateFrame(parsed);
    if (translated) emit(translated);
  };
  const onClose = (): void => {
    finishStream();
  };
  addListener(s, 'message', onMessage);
  addListener(s, 'close', onClose);
}

function extractMessageText(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  // Browser MessageEvent: `{ data: string | ArrayBuffer | Blob }`.
  if (raw && typeof raw === 'object' && 'data' in raw) {
    const d = (raw as { data: unknown }).data;
    if (typeof d === 'string') return d;
    if (d instanceof ArrayBuffer) return new TextDecoder().decode(d);
    if (ArrayBuffer.isView(d)) {
      return new TextDecoder().decode(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
    }
    return null;
  }
  // `ws` Node 'message' listener receives (data, isBinary) — Buffer.
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  return null;
}

function translateFrame(frame: unknown): TranscriptionStreamEvent | null {
  if (!frame || typeof frame !== 'object') return null;
  const f = frame as { type?: unknown };
  switch (f.type) {
    case 'transcription.delta': {
      const d = frame as {
        text?: unknown;
        is_final?: unknown;
        event_id?: unknown;
        start_ms?: unknown;
        end_ms?: unknown;
      };
      if (typeof d.text !== 'string') return null;
      const seq = typeof d.event_id === 'number' ? d.event_id : 0;
      if (d.is_final === true) {
        const ev: TranscriptionFinalEvent = {
          type: 'final',
          text: d.text,
          seq,
        };
        if (typeof d.start_ms === 'number') ev.start = d.start_ms / 1000;
        if (typeof d.end_ms === 'number') ev.end = d.end_ms / 1000;
        return ev;
      }
      const partial: TranscriptionPartialEvent = {
        type: 'partial',
        text: d.text,
        seq,
      };
      return partial;
    }
    case 'transcription.done': {
      const d = frame as {
        audio_ms?: unknown;
        language?: unknown;
        text?: unknown;
        event_id?: unknown;
      };
      // `transcription.done` carries the final stitched text; expose it
      // as a `final` event so callers see a single committed snapshot
      // per commit window.
      if (typeof d.text === 'string') {
        const ev: TranscriptionFinalEvent = {
          type: 'final',
          text: d.text,
          seq: typeof d.event_id === 'number' ? d.event_id : 0,
        };
        if (typeof d.language === 'string') ev.language = d.language;
        return ev;
      }
      return null;
    }
    case 'session.usage':
    case 'usage': {
      const d = frame as { seconds?: unknown; audio_ms?: unknown };
      const seconds =
        typeof d.seconds === 'number'
          ? d.seconds
          : typeof d.audio_ms === 'number'
            ? d.audio_ms / 1000
            : null;
      if (seconds === null) return null;
      const ev: TranscriptionUsageEvent = { type: 'usage', seconds };
      return ev;
    }
    case 'error': {
      const d = frame as { code?: unknown; message?: unknown };
      return {
        type: 'error',
        code: typeof d.code === 'string' ? d.code : 'unknown_error',
        message: typeof d.message === 'string' ? d.message : 'unknown error',
      };
    }
    case 'session.created':
      // Informational — don't surface to callers.
      return null;
    default:
      return null;
  }
}

function buildSessionUpdate(
  opts: TranscriptionStreamOptions,
): { type: 'session.update'; session: Record<string, unknown> } | null {
  const session: Record<string, unknown> = {};
  if (opts.model !== undefined) session.model = opts.model;
  if (opts.language !== undefined) session.language = opts.language;
  if (opts.sample_rate !== undefined) session.input_sample_rate = opts.sample_rate;
  if (opts.audio_format !== undefined) session.input_audio_format = opts.audio_format;
  if (Object.keys(session).length === 0) return null;
  return { type: 'session.update', session };
}

function buildWsUrl(baseURL: string): string {
  const u = new URL(baseURL);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = u.pathname.replace(/\/$/, '') + '/v1/audio/transcriptions/stream';
  return u.toString();
}

function estimateAudioMs(
  byteLength: number,
  sampleRate: number,
  format: 'pcm16',
): number | undefined {
  if (format === 'pcm16' && sampleRate > 0) {
    return Math.round((byteLength / 2 / sampleRate) * 1000);
  }
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
  // Node + Bun have Buffer; browsers have btoa. Handle both.
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function addListener(socket: MinimalSocket, type: string, listener: (ev: unknown) => void): void {
  if (socket.addEventListener) {
    socket.addEventListener(type, listener);
  } else if (socket.on) {
    socket.on(type, listener);
  }
}

function removeListener(
  socket: MinimalSocket,
  type: string,
  listener: (ev: unknown) => void,
): void {
  // `ws` supports .off() on EventEmitter; browser WebSocket supports
  // .removeEventListener(). Support both.
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
      // Dynamic import so a bundler building for the browser doesn't
      // try to statically resolve `ws`.
      // Dynamic import with a computed specifier so `tsc` doesn't
      // try to resolve `ws`'s types at compile time (the SDK ships
      // zero deps; `ws` is only resolved at runtime on older Node).
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
          'Hakim SDK: realtime STT requires a WebSocket implementation. On Node 22+ / Bun / Deno / browsers it is built in. On Node 18 / 20, run `npm install ws` alongside @tryhakim/voice. ' +
          (err instanceof Error ? `(cause: ${err.message})` : ''),
        status: 0,
        requestId: undefined,
      });
    }
  })();
  return _socketCtorPromise;
}

export const __internals = { translateFrame, buildSessionUpdate, buildWsUrl, estimateAudioMs };
