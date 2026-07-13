/**
 * `audio.speech` — POST /v1/audio/speech.
 *
 * Two entry points:
 *
 *   - `create(request)` — buffers the full audio into memory and
 *     returns it with decoded headers. Use for short outputs or when
 *     you need `usageCharacters` / `durationMs` immediately.
 *
 *   - `stream(request)` — returns an AsyncIterable of `Uint8Array`
 *     chunks so the caller can start playback / uploading before the
 *     server finishes synthesis. `stream` forces `stream: true` on the
 *     request payload regardless of what the caller passed.
 */

import type { Transport } from '../transport.js';
import type {
  SpeechRequest,
  SpeechResponse,
  SpeechStreamHandle,
  SpeechStreamOptions,
  SpeechStreamResponse,
} from '../types.js';
import { ConnectionError } from '../errors.js';
import { parseLimitsFromHeaders, parseUsageBlockFromHeaders } from '../observability.js';
import { openSpeechStream } from './speech-stream-ws.js';

export class SpeechAPI {
  constructor(private readonly transport: Transport) {}

  /** Realtime TTS over a WebSocket (`/v1/audio/speech/stream`).
   *
   *  Trades the per-request TCP/TLS/HTTP-header setup of the HTTP
   *  path (~7 ms per call cross-region) for a long-lived socket that
   *  can serve many utterances back-to-back. The persistent surface
   *  is the right pick for LLM-→-TTS pipelines (synthesise the next
   *  sentence while the LLM is still generating tokens) and embed
   *  widgets that make many TTS calls per session.
   *
   *  Returns a `SpeechStreamHandle` — call `sendSpeech({...})` to
   *  request an utterance, iterate `audio` (raw PCM-S16LE @ 24 kHz
   *  mono) or `events` (started / audio / done / usage / error), and
   *  `close()` when finished. */
  streamWs(opts: SpeechStreamOptions = {}): SpeechStreamHandle {
    return openSpeechStream(this.transport, opts);
  }

  /** Non-streaming TTS. Returns the complete audio body as a Uint8Array. */
  async create(
    request: SpeechRequest,
    opts: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<SpeechResponse> {
    const res = await this.transport.request({
      method: 'POST',
      path: '/v1/audio/speech',
      json: { ...request, stream: false },
      accept: 'audio/*',
      headers: { accept: 'audio/*' },
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });

    const buffer = await res.arrayBuffer();
    return {
      audio: new Uint8Array(buffer),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      usageCharacters: parsePositiveInt(res.headers.get('x-usage-characters')),
      durationMs: parsePositiveInt(res.headers.get('x-duration-ms')),
      usage: parseUsageBlockFromHeaders(res.headers),
      limits: parseLimitsFromHeaders(res.headers),
      meta: {
        requestId: res.headers.get('x-request-id') ?? undefined,
        status: res.status,
        headers: res.headers,
      },
    };
  }

  /** Streaming TTS. Starts yielding chunks as soon as the server writes
   *  them, without buffering the whole response. */
  async stream(
    request: SpeechRequest,
    opts: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<SpeechStreamResponse> {
    const res = await this.transport.request({
      method: 'POST',
      path: '/v1/audio/speech',
      json: { ...request, stream: true },
      accept: 'audio/*',
      headers: { accept: 'audio/*' },
      stream: true,
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });

    if (!res.body) {
      throw new ConnectionError({
        message: 'Hakim SDK: TTS streaming response has no body',
        requestId: res.headers.get('x-request-id') ?? undefined,
      });
    }

    return {
      stream: iterateReader(res.body),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      usageCharacters: parsePositiveInt(res.headers.get('x-usage-characters')),
      usage: parseUsageBlockFromHeaders(res.headers),
      limits: parseLimitsFromHeaders(res.headers),
      meta: {
        requestId: res.headers.get('x-request-id') ?? undefined,
        status: res.status,
        headers: res.headers,
      },
    };
  }
}

/** Convert a `ReadableStream<Uint8Array>` (returned by fetch on Node 18+)
 *  to an `AsyncIterable<Uint8Array>` so callers can `for await …`. */
async function* iterateReader(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    // Release the reader lock so the stream can be GC'd if the caller
    // bailed out mid-iteration.
    reader.releaseLock();
  }
}

function parsePositiveInt(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}
