/**
 * HTTP transport for the SDK.
 *
 * Contract:
 *   - Uses native `fetch` (Node 18+ builds it in). No `axios` / `undici`
 *     dependency so the SDK bundle stays small.
 *   - Every call attaches Authorization + User-Agent + X-Request-Id.
 *   - Mutating calls (POST) auto-generate an `Idempotency-Key` unless
 *     the caller supplied one (T39).
 *   - Retries on transient failures: 5xx, 429, 408, 503, and low-level
 *     connection errors. Back-off is exponential with jitter, honoring
 *     the server's `Retry-After` when present. Max 3 attempts by default.
 *   - 4xx (except 408 / 429) is NOT retried — those are caller errors.
 *   - Stream responses (TTS streaming, raw binary) are returned as a
 *     `Response` object so callers can `body.getReader()` or iterate
 *     via our adapter without us buffering the entire audio in memory.
 *
 * Error shape: every non-2xx raises a `HakimError` subclass built from
 * the server's uniform `ApiError` JSON body. Network-level
 * failures raise `ConnectionError`.
 */

import {
  ConnectionError,
  errorFromPayload,
  HakimError,
  type HakimApiErrorPayload,
} from './errors.js';
import { SDK_NAME, SDK_VERSION } from './version.js';

export interface TransportOptions {
  apiKey: string;
  baseURL: string;
  timeoutMs: number;
  maxRetries: number;
  userAgentSuffix?: string | undefined;
  /** Injected for tests — defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests — overrides the Math.random used for jitter. */
  random?: () => number;
  /** Injected for tests — overrides setTimeout used between retries. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests — overrides idempotency key generation. */
  generateIdempotencyKey?: () => string;
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  /** JSON body. Mutually exclusive with `formData` / `body`. */
  json?: unknown;
  /** Multipart body. Mutually exclusive with `json` / `body`. */
  formData?: FormData;
  /** Raw body. Mutually exclusive with `json` / `formData`. */
  body?: BodyInit | undefined;
  query?: Record<string, string | number | boolean | undefined> | undefined;
  headers?: Record<string, string> | undefined;
  /** Client-supplied idempotency key. Overrides auto-generation. */
  idempotencyKey?: string | undefined;
  /** When true the response body is returned untouched for the caller
   *  to stream. The transport still validates the HTTP status + parses
   *  error bodies for non-2xx. */
  stream?: boolean;
  /** Override the request timeout on a per-call basis. */
  timeoutMs?: number;
  /** When set, the server returned `Accept` header. Default:
   *  `application/json` for non-stream, omitted for stream/binary. */
  accept?: string;
  /** External AbortSignal. When aborted, the in-flight request is cancelled. */
  signal?: AbortSignal;
}

/** HTTP methods considered mutating for auto-idempotency. GET / HEAD
 *  don't get an auto key; POST / PUT / PATCH / DELETE do. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class Transport {
  /** Exposed for the realtime WSS helper which needs to build a `wss://`
   *  URL and set the Authorization header on a raw WebSocket. Treat as
   *  read-only; regular HTTP calls should never touch this directly. */
  readonly apiKey: string;
  readonly baseURL: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly generateIdempotencyKey: () => string;

  constructor(options: TransportOptions) {
    if (!options.apiKey) {
      throw new TypeError('Hakim SDK: `apiKey` is required. Set it when constructing Hakim().');
    }

    this.apiKey = options.apiKey;
    this.baseURL = trimTrailingSlash(options.baseURL);
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries;
    this.userAgent = buildUserAgent(options.userAgentSuffix);
    this.fetchImpl =
      options.fetchImpl ??
      (typeof fetch === 'function' ? (fetch as typeof fetch) : (undefined as never));
    if (!this.fetchImpl) {
      throw new TypeError(
        'Hakim SDK: global `fetch` is not available. Upgrade to Node >= 18 or pass a `fetchImpl` option.',
      );
    }
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
    this.generateIdempotencyKey = options.generateIdempotencyKey ?? defaultIdempotencyKey;
  }

  async request(opts: RequestOptions): Promise<Response> {
    const url = this.buildURL(opts.path, opts.query);
    const headers = this.buildHeaders(opts);

    // Build the body. We serialize JSON here (rather than relying on
    // fetch's coercion) so the Content-Length header is correct and the
    // body survives a retry — fetch consumes the body on each attempt.
    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      if (!headers['content-type']) headers['content-type'] = 'application/json';
    } else if (opts.formData !== undefined) {
      body = opts.formData;
      // Let fetch set the multipart boundary — do NOT set content-type.
    } else if (opts.body !== undefined) {
      body = opts.body;
    }

    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    let attempt = 0;
    let lastErr: unknown;

    while (attempt <= this.maxRetries) {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (opts.signal) {
        if (opts.signal.aborted) controller.abort();
        else opts.signal.addEventListener('abort', onAbort);
      }
      const timer = setTimeout(() => controller.abort(new Error('request_timeout')), timeoutMs);

      try {
        const init: RequestInit = {
          method: opts.method,
          headers,
          signal: controller.signal,
        };
        if (body !== undefined) init.body = body;

        const res = await this.fetchImpl(url, init);

        if (res.ok) {
          return res;
        }

        // Non-2xx: decide whether to retry. Retryable statuses mirror
        // connection errors + 5xx + 429.
        const shouldRetry = isRetryableStatus(res.status) && attempt < this.maxRetries;
        if (shouldRetry) {
          const retryAfterMs = readRetryAfterMs(res.headers);
          const waitMs = retryAfterMs ?? this.backoffMs(attempt);
          attempt++;
          // Consume body to free the connection before retrying.
          await res.arrayBuffer().catch(() => undefined);
          await this.sleep(waitMs);
          continue;
        }

        throw await parseErrorResponse(res);
      } catch (err) {
        if (err instanceof HakimError) throw err;

        lastErr = err;

        const code = classifyTransportError(err);
        if (code && attempt < this.maxRetries) {
          attempt++;
          await this.sleep(this.backoffMs(attempt - 1));
          continue;
        }

        throw new ConnectionError({
          message: toErrorMessage(err),
          requestId: headers['x-request-id'],
          cause: err,
          ...(code !== undefined ? { code } : {}),
        });
      } finally {
        clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      }
    }

    // Loop exited without `return`/`throw`, meaning retries exhausted on
    // a transient failure. Surface the last error.
    throw new ConnectionError({
      message: `Hakim SDK: request failed after ${this.maxRetries} retries`,
      requestId: headers['x-request-id'],
      cause: lastErr,
    });
  }

  private buildURL(path: string, query?: RequestOptions['query']): string {
    const url = new URL(path.replace(/^\/+/, ''), this.baseURL + '/');
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private buildHeaders(opts: RequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      'user-agent': this.userAgent,
      ...(opts.headers ?? {}),
    };

    // X-Request-Id: always send; the server will echo it back. Not
    // regenerated on retry — that would defeat idempotency if the server
    // already saw it.
    if (!headers['x-request-id']) {
      headers['x-request-id'] = generateRequestId();
    }

    // Accept header defaults. Stream / binary callers override.
    if (!headers['accept']) {
      headers['accept'] = opts.accept ?? 'application/json';
    }

    // Auto-idempotency (T39). Only attach on mutating methods that carry
    // a JSON body — multipart STT uploads are single-shot writes where
    // `Idempotency-Key` would be silently ignored by the server anyway.
    if (MUTATING_METHODS.has(opts.method) && opts.json !== undefined) {
      headers['idempotency-key'] = opts.idempotencyKey ?? this.generateIdempotencyKey();
    } else if (opts.idempotencyKey !== undefined) {
      headers['idempotency-key'] = opts.idempotencyKey;
    }

    return headers;
  }

  /** Base backoff: 200ms, 600ms, 1400ms; with ±25% jitter. Cap at 10s. */
  private backoffMs(attempt: number): number {
    const base = Math.min(200 * Math.pow(3, attempt), 10_000);
    const jitter = base * (this.random() - 0.5) * 0.5;
    return Math.max(0, Math.round(base + jitter));
  }
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function buildUserAgent(suffix?: string): string {
  const nodeVersion =
    typeof process !== 'undefined' && process.versions
      ? `node/${process.versions.node}`
      : 'node/unknown';
  const base = `${SDK_NAME.replace('@', '').replace('/', '-')}/${SDK_VERSION} (${nodeVersion})`;
  return suffix ? `${base} ${suffix}` : base;
}

function isRetryableStatus(status: number): boolean {
  // 408 Request Timeout, 425 Too Early, 429 Too Many Requests,
  // 5xx (transient server-side failures). 501 / 505 are not retried —
  // those are "your request will never succeed" errors.
  if (status === 408 || status === 425 || status === 429) return true;
  if (status === 501 || status === 505) return false;
  return status >= 500 && status <= 599;
}

function readRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const num = Number(raw);
  if (Number.isFinite(num) && num >= 0) return num * 1000;
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

async function parseErrorResponse(res: Response): Promise<HakimError> {
  const requestId = res.headers.get('x-request-id') ?? undefined;
  const retryAfterMs = readRetryAfterMs(res.headers);

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      const json = (await res.json()) as { error?: HakimApiErrorPayload };
      if (json && json.error && json.error.type && json.error.message) {
        return errorFromPayload(json.error, res.status, requestId, retryAfterMs);
      }
    } catch {
      // fall through to generic handling
    }
  }

  let text = '';
  try {
    text = await res.text();
  } catch {
    text = res.statusText;
  }
  return errorFromPayload(
    {
      type: res.status >= 500 ? 'api_error' : 'invalid_request_error',
      code: `http_${res.status}`,
      message: text || res.statusText || `HTTP ${res.status}`,
    },
    res.status,
    requestId,
    retryAfterMs,
  );
}

function classifyTransportError(err: unknown): string | undefined {
  if (err instanceof HakimError) return undefined;
  if (err instanceof Error) {
    const name = err.name;
    const msg = err.message;
    if (name === 'AbortError' && /request_timeout/.test(msg)) return 'request_timeout';
    if (name === 'AbortError') return 'aborted';
    if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(msg)) {
      return 'network_error';
    }
  }
  return 'network_error';
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'unknown transport error';
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function defaultIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: timestamp + random. We only get here on platforms where
  // `globalThis.crypto` is missing (very old runtimes). Good enough to
  // satisfy the server-side uniqueness check.
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function generateRequestId(): string {
  return `sdk-${defaultIdempotencyKey()}`;
}
