/**
 * Transport tests — cover the SDK quality bar:
 *   - Auth + User-Agent + X-Request-Id always attached.
 *   - Auto-Idempotency-Key on mutating JSON calls (T39).
 *   - Caller-supplied Idempotency-Key takes precedence.
 *   - Retries on 5xx / 429 / network errors with bounded attempts.
 *   - Honors `Retry-After` header on 429 / 503.
 *   - Does NOT retry on 4xx (except 408 / 429).
 *   - 4xx with `ApiError` JSON body maps to the right subclass.
 *   - Timeout aborts and retries.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Transport } from './transport.js';
import {
  AuthenticationError,
  ConnectionError,
  HakimError,
  IdempotencyConflictError,
  InvalidRequestError,
  PermissionError,
  QuotaExceededError,
  RateLimitError,
  ServiceUnavailableError,
} from './errors.js';
import { SDK_VERSION } from './version.js';

type FetchCall = { url: string; init: RequestInit };

function mockFetch(responses: Array<Response | Error | (() => Response | Promise<Response>)>): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let idx = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    const next = responses[idx];
    idx = Math.min(idx + 1, responses.length - 1);
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return await next();
    if (!next) throw new Error('mockFetch: out of programmed responses');
    return next;
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function buildTransport(overrides: {
  fetchImpl: typeof fetch;
  maxRetries?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  generateIdempotencyKey?: () => string;
}): Transport {
  return new Transport({
    apiKey: 'hk_test_secret',
    baseURL: 'https://api.example.com',
    timeoutMs: 5_000,
    maxRetries: overrides.maxRetries ?? 2,
    fetchImpl: overrides.fetchImpl,
    random: overrides.random ?? (() => 0.5),
    sleep: overrides.sleep ?? (async () => undefined),
    generateIdempotencyKey: overrides.generateIdempotencyKey ?? (() => 'auto-idem-key'),
  });
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('Transport — headers + idempotency', () => {
  it('attaches Authorization, User-Agent, X-Request-Id on every call', async () => {
    const { fetch: f, calls } = mockFetch([jsonResponse(200, { ok: true })]);
    const t = buildTransport({ fetchImpl: f });
    await t.request({ method: 'GET', path: '/v1/usage' });

    const [call] = calls;
    const headers = call!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer hk_test_secret');
    expect(headers['user-agent']).toContain(SDK_VERSION);
    expect(headers['x-request-id']).toMatch(/^sdk-/);
  });

  it('auto-generates an Idempotency-Key on mutating JSON calls', async () => {
    const { fetch: f, calls } = mockFetch([jsonResponse(200, { ok: true })]);
    const t = buildTransport({
      fetchImpl: f,
      generateIdempotencyKey: () => 'abc-123',
    });
    await t.request({ method: 'POST', path: '/v1/audio/speech', json: { x: 1 } });

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('abc-123');
  });

  it('lets the caller override Idempotency-Key', async () => {
    const { fetch: f, calls } = mockFetch([jsonResponse(200, { ok: true })]);
    const t = buildTransport({ fetchImpl: f });
    await t.request({
      method: 'POST',
      path: '/v1/audio/speech',
      json: { x: 1 },
      idempotencyKey: 'caller-key',
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('caller-key');
  });

  it('does NOT attach Idempotency-Key on GET requests', async () => {
    const { fetch: f, calls } = mockFetch([jsonResponse(200, { ok: true })]);
    const t = buildTransport({ fetchImpl: f });
    await t.request({ method: 'GET', path: '/v1/usage' });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBeUndefined();
  });

  it('does NOT auto-generate Idempotency-Key for multipart uploads (server ignores it)', async () => {
    const { fetch: f, calls } = mockFetch([jsonResponse(200, { text: 'hi' })]);
    const t = buildTransport({ fetchImpl: f });
    const form = new FormData();
    form.append('model', 'hakim-arab-v2');
    await t.request({
      method: 'POST',
      path: '/v1/audio/transcriptions',
      formData: form,
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBeUndefined();
  });
});

describe('Transport — retries', () => {
  it('retries on 503 up to maxRetries, then throws ServiceUnavailableError', async () => {
    const { fetch: f, calls } = mockFetch([
      jsonResponse(503, {
        error: { type: 'service_unavailable', code: 'inference_down', message: 'breaker open' },
      }),
      jsonResponse(503, {
        error: { type: 'service_unavailable', code: 'inference_down', message: 'breaker open' },
      }),
      jsonResponse(503, {
        error: { type: 'service_unavailable', code: 'inference_down', message: 'breaker open' },
      }),
    ]);
    const t = buildTransport({ fetchImpl: f, maxRetries: 2 });
    await expect(t.request({ method: 'GET', path: '/v1/usage' })).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    expect(calls.length).toBe(3);
  });

  it('retries on 429 and honors Retry-After (seconds)', async () => {
    const { fetch: f, calls } = mockFetch([
      jsonResponse(
        429,
        { error: { type: 'rate_limit_error', code: 'rate_limited', message: 'slow down' } },
        {
          'retry-after': '1',
        },
      ),
      jsonResponse(200, { ok: true }),
    ]);
    const sleeps: number[] = [];
    const t = buildTransport({
      fetchImpl: f,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const res = await t.request({ method: 'GET', path: '/v1/usage' });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(2);
    expect(sleeps).toEqual([1000]);
  });

  it('does NOT retry on 400 and surfaces InvalidRequestError', async () => {
    const { fetch: f, calls } = mockFetch([
      jsonResponse(400, {
        error: {
          type: 'invalid_request_error',
          code: 'bad_input',
          message: 'nope',
          param: 'voice',
        },
      }),
    ]);
    const t = buildTransport({ fetchImpl: f });
    await expect(
      t.request({ method: 'POST', path: '/v1/audio/speech', json: {} }),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof InvalidRequestError &&
        err.code === 'bad_input' &&
        err.param === 'voice' &&
        err.status === 400
      );
    });
    expect(calls.length).toBe(1);
  });

  it('retries on network error then succeeds', async () => {
    const { fetch: f, calls } = mockFetch([
      new Error('ECONNRESET: connection reset'),
      jsonResponse(200, { ok: true }),
    ]);
    const t = buildTransport({ fetchImpl: f });
    const res = await t.request({ method: 'GET', path: '/v1/usage' });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(2);
  });

  it('wraps persistent network errors in ConnectionError', async () => {
    const { fetch: f } = mockFetch([
      new Error('ECONNRESET'),
      new Error('ECONNRESET'),
      new Error('ECONNRESET'),
    ]);
    const t = buildTransport({ fetchImpl: f, maxRetries: 2 });
    const err = await t.request({ method: 'GET', path: '/v1/usage' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as ConnectionError).code).toBe('network_error');
  });
});

describe('Transport — error mapping', () => {
  it('401 → AuthenticationError', async () => {
    const { fetch: f } = mockFetch([
      jsonResponse(401, {
        error: { type: 'authentication_error', code: 'invalid_api_key', message: 'bad key' },
      }),
    ]);
    const t = buildTransport({ fetchImpl: f });
    await expect(t.request({ method: 'GET', path: '/v1/usage' })).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it('402 → QuotaExceededError', async () => {
    const { fetch: f } = mockFetch([
      jsonResponse(402, {
        error: { type: 'quota_exceeded', code: 'monthly_cap', message: 'limit hit' },
      }),
    ]);
    const t = buildTransport({ fetchImpl: f });
    await expect(
      t.request({ method: 'POST', path: '/v1/audio/speech', json: {} }),
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('402 surfaces retry_after_seconds + upgrade/docs URLs on QuotaExceededError', async () => {
    // M3 Phase 10 — the server stamps these fields on hard-cap 402s
    // so SDK consumers can schedule a backoff / link users to
    // billing without parsing the raw payload.
    const { fetch: f } = mockFetch([
      jsonResponse(402, {
        error: {
          type: 'quota_exceeded',
          code: 'hard_cap',
          message: 'TTS hard cap reached.',
          retry_after_seconds: 1800,
          upgrade_url: 'https://app.tryhakim.ai/app/billing/plan',
          docs_url: 'https://docs.tryhakim.ai/billing/hard-caps',
        },
      }),
    ]);
    const t = buildTransport({ fetchImpl: f });
    try {
      await t.request({ method: 'POST', path: '/v1/audio/speech', json: {} });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError);
      const q = err as QuotaExceededError;
      expect(q.code).toBe('hard_cap');
      expect(q.retryAfterSeconds).toBe(1800);
      expect(q.upgradeUrl).toBe('https://app.tryhakim.ai/app/billing/plan');
      expect(q.docsUrl).toBe('https://docs.tryhakim.ai/billing/hard-caps');
    }
  });

  it('403 → PermissionError', async () => {
    const { fetch: f } = mockFetch([
      jsonResponse(403, {
        error: { type: 'permission_error', code: 'scope_missing', message: 'tts:write' },
      }),
    ]);
    const t = buildTransport({ fetchImpl: f });
    await expect(
      t.request({ method: 'POST', path: '/v1/audio/speech', json: {} }),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it('403 feature_requires_paid_plan surfaces upgrade_url + docs_url on PermissionError', async () => {
    // M3 Phase 11 — Free-tier paywall. The SDK mirrors the 402
    // enrichment so consumers can distinguish "you are missing a
    // scope" from "you need a paid plan" with the same class.
    const { fetch: f } = mockFetch([
      jsonResponse(403, {
        error: {
          type: 'permission_error',
          code: 'feature_requires_paid_plan',
          message: 'STT is paid-plan only.',
          upgrade_url: 'https://app.tryhakim.ai/app/billing/plan',
          docs_url: 'https://docs.tryhakim.ai/billing/free-tier-limits',
        },
      }),
    ]);
    const t = buildTransport({ fetchImpl: f });
    try {
      await t.request({ method: 'POST', path: '/v1/audio/transcriptions', json: {} });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PermissionError);
      const p = err as PermissionError;
      expect(p.code).toBe('feature_requires_paid_plan');
      expect(p.upgradeUrl).toBe('https://app.tryhakim.ai/app/billing/plan');
      expect(p.docsUrl).toBe('https://docs.tryhakim.ai/billing/free-tier-limits');
    }
  });

  it('409 → IdempotencyConflictError', async () => {
    const { fetch: f } = mockFetch([
      jsonResponse(409, {
        error: {
          type: 'idempotency_conflict',
          code: 'body_differs',
          message: 'same key, diff body',
        },
      }),
    ]);
    const t = buildTransport({ fetchImpl: f });
    await expect(
      t.request({ method: 'POST', path: '/v1/audio/speech', json: {} }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('429 exhausted → RateLimitError with retryAfterMs', async () => {
    const { fetch: f } = mockFetch([
      jsonResponse(
        429,
        { error: { type: 'rate_limit_error', code: 'rl', message: 'throttle' } },
        {
          'retry-after': '2',
        },
      ),
      jsonResponse(
        429,
        { error: { type: 'rate_limit_error', code: 'rl', message: 'throttle' } },
        {
          'retry-after': '2',
        },
      ),
      jsonResponse(
        429,
        { error: { type: 'rate_limit_error', code: 'rl', message: 'throttle' } },
        {
          'retry-after': '2',
        },
      ),
    ]);
    const t = buildTransport({ fetchImpl: f, maxRetries: 2 });
    const err = (await t
      .request({ method: 'GET', path: '/v1/usage' })
      .catch((e: unknown) => e)) as HakimError;
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBe(2000);
  });

  it('surfaces the server X-Request-Id on error', async () => {
    const { fetch: f } = mockFetch([
      new Response(
        JSON.stringify({
          error: {
            type: 'invalid_request_error',
            code: 'bad',
            message: 'nope',
            request_id: 'srv-req-id',
          },
        }),
        {
          status: 400,
          headers: { 'content-type': 'application/json', 'x-request-id': 'srv-req-id' },
        },
      ),
    ]);
    const t = buildTransport({ fetchImpl: f });
    const err = (await t
      .request({ method: 'POST', path: '/v1/audio/speech', json: {} })
      .catch((e: unknown) => e)) as HakimError;
    expect(err.requestId).toBe('srv-req-id');
  });

  it('falls back to generic shape when the server returns non-JSON', async () => {
    const { fetch: f } = mockFetch([
      new Response('<html>500 oops</html>', {
        status: 500,
        headers: { 'content-type': 'text/html' },
      }),
    ]);
    const t = buildTransport({ fetchImpl: f });
    const err = (await t
      .request({ method: 'GET', path: '/v1/usage' })
      .catch((e: unknown) => e)) as HakimError;
    expect(err).toBeInstanceOf(HakimError);
    expect(err.status).toBe(500);
    expect(err.type).toBe('api_error');
  });
});

describe('Transport — URL + query + body', () => {
  it('joins baseURL with path correctly and serializes query', async () => {
    const { fetch: f, calls } = mockFetch([jsonResponse(200, { ok: true })]);
    const t = buildTransport({ fetchImpl: f });
    await t.request({
      method: 'GET',
      path: '/v1/usage/events',
      query: { limit: 10, kind: 'tts', cursor: undefined },
    });
    expect(calls[0]!.url).toBe('https://api.example.com/v1/usage/events?limit=10&kind=tts');
  });

  it('JSON-serializes body and sets content-type', async () => {
    const { fetch: f, calls } = mockFetch([jsonResponse(200, { ok: true })]);
    const t = buildTransport({ fetchImpl: f });
    await t.request({ method: 'POST', path: '/v1/audio/speech', json: { input: 'hi' } });
    const init = calls[0]!.init;
    expect(init.body).toBe('{"input":"hi"}');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
  });
});

describe('Transport — abort', () => {
  let originalAbortSignal: unknown;
  beforeEach(() => {
    originalAbortSignal = globalThis.AbortSignal;
  });
  afterEach(() => {
    globalThis.AbortSignal = originalAbortSignal as typeof AbortSignal;
  });

  it('forwards caller AbortSignal to fetch', async () => {
    const controller = new AbortController();
    const seenSignals: Array<AbortSignal | undefined> = [];
    const f = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenSignals.push(init?.signal ?? undefined);
      return jsonResponse(200, { ok: true });
    }) as typeof fetch;
    const t = buildTransport({ fetchImpl: f });
    await t.request({ method: 'GET', path: '/v1/usage', signal: controller.signal });
    expect(seenSignals[0]).toBeInstanceOf(AbortSignal);
  });

  it('retries after a request_timeout abort, then succeeds', async () => {
    let attempts = 0;
    const f = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      attempts++;
      if (attempts === 1) {
        const err = new Error('request_timeout');
        err.name = 'AbortError';
        throw err;
      }
      return jsonResponse(200, { ok: true });
    }) as typeof fetch;
    const t = buildTransport({ fetchImpl: f });
    const res = await t.request({ method: 'GET', path: '/v1/usage' });
    expect(res.status).toBe(200);
    expect(attempts).toBe(2);
  });
});

describe('Transport — construction', () => {
  it('rejects an empty api key at construction time', () => {
    expect(
      () =>
        new Transport({
          apiKey: '',
          baseURL: 'https://api.example.com',
          timeoutMs: 1000,
          maxRetries: 0,
          fetchImpl: (() => Promise.resolve(jsonResponse(200, {}))) as unknown as typeof fetch,
        }),
    ).toThrow(/apiKey/);
  });

  it('drops the trailing slash from baseURL', async () => {
    const { fetch: f, calls } = mockFetch([jsonResponse(200, { ok: true })]);
    const t = new Transport({
      apiKey: 'hk_test_x',
      baseURL: 'https://api.example.com/',
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl: f,
    });
    await t.request({ method: 'GET', path: '/v1/usage' });
    expect(calls[0]!.url).toBe('https://api.example.com/v1/usage');
  });
});
