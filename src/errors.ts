/**
 * SDK error hierarchy (mirrors `@hakim/schemas` `ApiError.type` values).
 *
 * Every HTTP-level failure surfaces as a `HakimError` subclass so callers
 * can `instanceof` on either the base class or a specific subclass:
 *
 *   try {
 *     await hakim.audio.speech.create({ … });
 *   } catch (err) {
 *     if (err instanceof RateLimitError) await sleep(err.retryAfterMs);
 *     else if (err instanceof HakimError) console.error(err.requestId, err);
 *     else throw err;
 *   }
 *
 * Transport-level failures (DNS, connection reset, AbortError) are
 * wrapped in `ConnectionError` so the caller never has to distinguish
 * them from Node's own error strings.
 */

export type HakimErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found'
  | 'rate_limit_error'
  | 'quota_exceeded'
  | 'api_error'
  | 'service_unavailable'
  | 'idempotency_conflict'
  | 'connection_error';

export interface HakimApiErrorPayload {
  type: HakimErrorType;
  code: string;
  message: string;
  param?: string;
  request_id?: string;
  // M3 Phase 10 — quota-specific fields. Only 402 `quota_exceeded`
  // responses populate these; the SDK surfaces them on
  // `QuotaExceededError` so consumers can drive a backoff /
  // deep-link UX without re-parsing the payload.
  retry_after_seconds?: number;
  upgrade_url?: string;
  docs_url?: string;
}

export interface HakimErrorInit {
  type: HakimErrorType;
  code: string;
  message: string;
  status: number;
  requestId: string | undefined;
  param?: string;
  cause?: unknown;
  retryAfterMs?: number;
  retryAfterSeconds?: number;
  upgradeUrl?: string;
  docsUrl?: string;
}

export class HakimError extends Error {
  readonly type: HakimErrorType;
  readonly code: string;
  readonly status: number;
  readonly requestId: string | undefined;
  readonly param: string | undefined;
  override readonly cause: unknown;
  /** For 429 / 503: milliseconds the server asked us to wait. */
  readonly retryAfterMs: number | undefined;

  constructor(init: HakimErrorInit) {
    super(init.message);
    this.name = 'HakimError';
    this.type = init.type;
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId;
    this.param = init.param;
    this.cause = init.cause;
    this.retryAfterMs = init.retryAfterMs;
  }
}

export class InvalidRequestError extends HakimError {
  constructor(init: HakimErrorInit) {
    super(init);
    this.name = 'InvalidRequestError';
  }
}

export class AuthenticationError extends HakimError {
  constructor(init: HakimErrorInit) {
    super(init);
    this.name = 'AuthenticationError';
  }
}

export class PermissionError extends HakimError {
  /**
   * M3 Phase 11 — set when the caller hit the Free-tier paywall
   * (code === 'feature_requires_paid_plan'). Consumers can deep-link
   * users to the billing page without re-parsing the payload.
   */
  readonly upgradeUrl: string | undefined;
  /** Docs link explaining the specific restriction. */
  readonly docsUrl: string | undefined;

  constructor(init: HakimErrorInit) {
    super(init);
    this.name = 'PermissionError';
    this.upgradeUrl = init.upgradeUrl;
    this.docsUrl = init.docsUrl;
  }
}

export class NotFoundError extends HakimError {
  constructor(init: HakimErrorInit) {
    super(init);
    this.name = 'NotFoundError';
  }
}

export class QuotaExceededError extends HakimError {
  /** Server-suggested seconds until retry. Mirrors `Retry-After`. */
  readonly retryAfterSeconds: number | undefined;
  /** Dashboard link to upgrade plan / update payment method. */
  readonly upgradeUrl: string | undefined;
  /** Docs link explaining the specific 402 reason code. */
  readonly docsUrl: string | undefined;

  constructor(init: HakimErrorInit) {
    super(init);
    this.name = 'QuotaExceededError';
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.upgradeUrl = init.upgradeUrl;
    this.docsUrl = init.docsUrl;
  }
}

export class RateLimitError extends HakimError {
  constructor(init: HakimErrorInit) {
    super(init);
    this.name = 'RateLimitError';
  }
}

export class IdempotencyConflictError extends HakimError {
  constructor(init: HakimErrorInit) {
    super(init);
    this.name = 'IdempotencyConflictError';
  }
}

export class ServiceUnavailableError extends HakimError {
  constructor(init: HakimErrorInit) {
    super(init);
    this.name = 'ServiceUnavailableError';
  }
}

export class ConnectionError extends HakimError {
  constructor(init: Omit<HakimErrorInit, 'type' | 'code' | 'status'> & { code?: string }) {
    super({
      type: 'connection_error',
      code: init.code ?? 'connection_failed',
      message: init.message,
      status: 0,
      requestId: init.requestId,
      cause: init.cause,
    });
    this.name = 'ConnectionError';
  }
}

/** Factory: construct the right subclass from the wire payload. */
export function errorFromPayload(
  payload: HakimApiErrorPayload,
  status: number,
  requestId: string | undefined,
  retryAfterMs?: number,
): HakimError {
  const init: HakimErrorInit = {
    type: payload.type,
    code: payload.code,
    message: payload.message,
    status,
    requestId: payload.request_id ?? requestId,
    ...(payload.param !== undefined ? { param: payload.param } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(payload.retry_after_seconds !== undefined
      ? { retryAfterSeconds: payload.retry_after_seconds }
      : {}),
    ...(payload.upgrade_url !== undefined ? { upgradeUrl: payload.upgrade_url } : {}),
    ...(payload.docs_url !== undefined ? { docsUrl: payload.docs_url } : {}),
  };
  switch (payload.type) {
    case 'invalid_request_error':
      return new InvalidRequestError(init);
    case 'authentication_error':
      return new AuthenticationError(init);
    case 'permission_error':
      return new PermissionError(init);
    case 'not_found':
      return new NotFoundError(init);
    case 'quota_exceeded':
      return new QuotaExceededError(init);
    case 'rate_limit_error':
      return new RateLimitError(init);
    case 'idempotency_conflict':
      return new IdempotencyConflictError(init);
    case 'service_unavailable':
      return new ServiceUnavailableError(init);
    case 'api_error':
    default:
      return new HakimError(init);
  }
}
