/**
 * `chat.completions` — POST /v1/chat/completions.
 *
 * Two entry points, mirroring `audio.speech`:
 *
 *   - `create(request)` — buffers the full response and returns a
 *     `ChatCompletionResponse` with usage block + decoded
 *     observability headers. Forces `stream: false` regardless of
 *     what the caller passed, so a stale flag in a saved request
 *     can't drag a buffered call into SSE mode.
 *
 *   - `stream(request)` — returns an `AsyncIterable<ChatCompletionChunk>`
 *     plus the upfront observability headers (kind / unit-type /
 *     model / plan / period / credits). The final per-request usage
 *     numbers (`credits`, `cost_usd`, `units`) ride the terminal
 *     SSE chunk's `usage` block — OpenAI convention — and are not
 *     emitted as headers since `reply.hijack()` already flushed
 *     the response head before they're known.
 *
 * Reasoning policy: off by default, opt-in for
 * non-stream via `reasoning: { enabled: true }`, and forbidden for
 * streaming. The route rejects the stream-with-reasoning combo at
 * the schema layer with a 400 — we do not pre-validate here so
 * the server stays the single source of truth.
 */

import type { Transport } from '../transport.js';
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
} from '../types.js';
import { ConnectionError } from '../errors.js';
import { parseLimitsFromHeaders, parseUsageBlockFromHeaders } from '../observability.js';
import type { ResponseMeta, SpeechResponseLimits, UsageBlock } from '../types.js';
import { parseSseStream } from './sse.js';

/** Returned by `chat.completions.create`. The shape extends the
 *  OpenAI response with Hakim-specific observability fields. */
export interface ChatCompletionCreateResponse extends ChatCompletionResponse {
  /** Decoded `x-hakim-usage-*` headers. Same data as the embedded
   *  `hakim_usage` block (the wire echoes it for log integrators
   *  that strip headers). */
  usage_headers?: UsageBlock;
  /** Decoded snapshot of plan / period / credits / concurrency. */
  limits?: SpeechResponseLimits;
  meta: ResponseMeta;
}

/** Returned by `chat.completions.stream`. The `stream` yields one
 *  `ChatCompletionChunk` per SSE frame. The final chunk carries
 *  the `usage` block; consumers that want a single roll-up should
 *  iterate to completion and read `lastChunk.usage`. */
export interface ChatCompletionStreamResponse {
  stream: AsyncIterable<ChatCompletionChunk>;
  /** `kind` / `unit_type` / `model` from the streaming preflight.
   *  Final per-request `credits` / `cost_usd` / `units` are not
   *  knowable before the upstream closes the stream and ride the
   *  terminal chunk's `usage` block instead. */
  usage_preflight?: StreamingUsagePreflight;
  limits?: SpeechResponseLimits;
  meta: ResponseMeta;
}

export interface StreamingUsagePreflight {
  kind: 'llm_chat';
  unit_type: 'tokens';
  model: string | null;
}

export class ChatCompletionsAPI {
  constructor(private readonly transport: Transport) {}

  /** Non-streaming chat completion. Returns the full response
   *  body plus decoded observability headers. */
  async create(
    request: ChatCompletionRequest,
    opts: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<ChatCompletionCreateResponse> {
    const res = await this.transport.request({
      method: 'POST',
      path: '/v1/chat/completions',
      json: { ...request, stream: false },
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });

    const body = (await res.json()) as ChatCompletionResponse;
    const usageHeaders = parseUsageBlockFromHeaders(res.headers);
    const limits = parseLimitsFromHeaders(res.headers);

    return {
      ...body,
      ...(usageHeaders !== undefined ? { usage_headers: usageHeaders } : {}),
      ...(limits !== undefined ? { limits } : {}),
      meta: {
        requestId: res.headers.get('x-request-id') ?? undefined,
        status: res.status,
        headers: res.headers,
      },
    };
  }

  /** Streaming chat completion (SSE). Returns an async iterable
   *  of chunks. Always sends `stream: true` regardless of what
   *  the caller passed on the request body. */
  async stream(
    request: ChatCompletionRequest,
    opts: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<ChatCompletionStreamResponse> {
    const res = await this.transport.request({
      method: 'POST',
      path: '/v1/chat/completions',
      json: { ...request, stream: true },
      accept: 'text/event-stream',
      headers: { accept: 'text/event-stream' },
      stream: true,
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });

    if (!res.body) {
      throw new ConnectionError({
        message: 'Hakim SDK: chat streaming response has no body',
        requestId: res.headers.get('x-request-id') ?? undefined,
      });
    }

    return {
      stream: parseSseStream<ChatCompletionChunk>(res.body, {
        requestId: res.headers.get('x-request-id') ?? undefined,
      }),
      ...(parsePreflight(res.headers) !== undefined
        ? { usage_preflight: parsePreflight(res.headers) as StreamingUsagePreflight }
        : {}),
      ...(parseLimitsFromHeaders(res.headers) !== undefined
        ? { limits: parseLimitsFromHeaders(res.headers) as SpeechResponseLimits }
        : {}),
      meta: {
        requestId: res.headers.get('x-request-id') ?? undefined,
        status: res.status,
        headers: res.headers,
      },
    };
  }
}

/**
 * On streaming responses the route stamps a reduced header set
 * before `reply.hijack()` — kind, unit-type, model — and embeds
 * final per-request usage on the terminal SSE chunk. We expose
 * those preflight values so callers don't have to crack open
 * `meta.headers`.
 */
function parsePreflight(headers: Headers): StreamingUsagePreflight | undefined {
  const kind = headers.get('x-hakim-usage-kind');
  const unitType = headers.get('x-hakim-usage-unit-type');
  if (kind !== 'llm_chat' || unitType !== 'tokens') return undefined;
  return {
    kind: 'llm_chat',
    unit_type: 'tokens',
    model: headers.get('x-hakim-model'),
  };
}
