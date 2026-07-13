/**
 * `webhooks` — public `/v1/webhooks` CRUD + deliveries + signature
 * verification helper.
 *
 * Two surfaces live in this module:
 *
 *   1. `WebhooksAPI` — thin HTTP client for the CRUD + deliveries list
 *      endpoints. Exposed as `hakim.webhooks`.
 *
 *   2. `verifyWebhookSignature(secret, timestamp, body, signature)` —
 *      pure function (no network, no SDK instance required) that
 *      validates the `Hakim-Signature: t=…,v1=…` header receivers see
 *      on every delivery. Designed to be import-only, so a serverless
 *      webhook handler can ship without instantiating `Hakim`.
 *
 * Signature format:
 *
 *     Hakim-Signature: t=<unix_seconds>,v1=<hex(hmac_sha256(secret, t + "." + rawBody))>
 *
 * The timestamp window defaults to ±5 minutes to blunt replay attacks
 * without breaking receivers whose clocks drift by a minute or two.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Transport } from './transport.js';
import type {
  Webhook,
  WebhookCreated,
  WebhookCreateRequest,
  WebhookDelivery,
  WebhookDeliveriesListQuery,
  WebhookDeliveriesListResponse,
  WebhookUpdateRequest,
  WebhooksListResponse,
} from './types.js';

export class WebhooksAPI {
  constructor(private readonly transport: Transport) {}

  async create(
    request: WebhookCreateRequest,
    opts: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<WebhookCreated> {
    const res = await this.transport.request({
      method: 'POST',
      path: '/v1/webhooks',
      json: request,
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return (await res.json()) as WebhookCreated;
  }

  async list(opts: { signal?: AbortSignal } = {}): Promise<WebhooksListResponse> {
    const res = await this.transport.request({
      method: 'GET',
      path: '/v1/webhooks',
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return (await res.json()) as WebhooksListResponse;
  }

  async retrieve(id: string, opts: { signal?: AbortSignal } = {}): Promise<Webhook> {
    const res = await this.transport.request({
      method: 'GET',
      path: `/v1/webhooks/${encodeURIComponent(id)}`,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return (await res.json()) as Webhook;
  }

  async update(
    id: string,
    request: WebhookUpdateRequest,
    opts: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<Webhook> {
    const res = await this.transport.request({
      method: 'PATCH',
      path: `/v1/webhooks/${encodeURIComponent(id)}`,
      json: request,
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return (await res.json()) as Webhook;
  }

  async delete(
    id: string,
    opts: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<{ object: 'webhook'; id: string; deleted: true }> {
    const res = await this.transport.request({
      method: 'DELETE',
      path: `/v1/webhooks/${encodeURIComponent(id)}`,
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return (await res.json()) as { object: 'webhook'; id: string; deleted: true };
  }

  /** List delivery attempts for a subscription. Cursor-paginated on
   *  the server; `next_cursor` is opaque and should be passed back
   *  verbatim to fetch the next page. */
  async listDeliveries(
    id: string,
    query: Omit<WebhookDeliveriesListQuery, 'webhook_id'> = {},
    opts: { signal?: AbortSignal } = {},
  ): Promise<WebhookDeliveriesListResponse> {
    const q: Record<string, string | number | undefined> = {};
    if (query.status !== undefined) q.status = query.status;
    if (query.limit !== undefined) q.limit = query.limit;
    if (query.cursor !== undefined) q.cursor = query.cursor;

    const res = await this.transport.request({
      method: 'GET',
      path: `/v1/webhooks/${encodeURIComponent(id)}/deliveries`,
      query: q,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return (await res.json()) as WebhookDeliveriesListResponse;
  }

  /** Convenience: iterate every delivery across pages. */
  async *iterDeliveries(
    id: string,
    query: Omit<WebhookDeliveriesListQuery, 'webhook_id'> = {},
    opts: { signal?: AbortSignal } = {},
  ): AsyncIterable<WebhookDelivery> {
    let cursor = query.cursor;
    while (true) {
      const page = await this.listDeliveries(
        id,
        { ...query, ...(cursor !== undefined ? { cursor } : {}) },
        opts,
      );
      for (const d of page.data) yield d;
      if (!page.has_more || !page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }
}

// ---------------------------------------------------------------------------
// verifyWebhookSignature — import-only helper, no `Hakim` instance needed.
// ---------------------------------------------------------------------------

export interface VerifyWebhookSignatureOptions {
  /** Per-subscription secret returned by `POST /v1/webhooks`. */
  secret: string;
  /** The raw request body as a UTF-8 string (NOT `JSON.parse`d — the
   *  hash is computed over the exact bytes the server signed). */
  body: string;
  /** Value of the `Hakim-Signature` header — full `t=…,v1=…` string. */
  signature: string;
  /** Tolerance window for the timestamp in seconds. Default 300 (5
   *  minutes). Set to 0 to disable the replay check (NOT recommended
   *  in production). */
  toleranceSeconds?: number;
  /** Optional clock override for tests. Returns a UNIX timestamp in
   *  seconds. Defaults to `Math.floor(Date.now() / 1000)`. */
  now?: () => number;
}

export type WebhookSignatureVerifyResult =
  | { valid: true }
  | {
      valid: false;
      reason: 'malformed_header' | 'timestamp_out_of_tolerance' | 'signature_mismatch';
    };

const DEFAULT_TOLERANCE_SECONDS = 300;

export function verifyWebhookSignature(
  input: VerifyWebhookSignatureOptions,
): WebhookSignatureVerifyResult {
  const { secret, body, signature } = input;
  const toleranceSeconds = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = input.now ?? (() => Math.floor(Date.now() / 1000));

  const parsed = parseSignatureHeader(signature);
  if (!parsed) return { valid: false, reason: 'malformed_header' };

  if (toleranceSeconds > 0) {
    const delta = Math.abs(now() - parsed.timestamp);
    if (delta > toleranceSeconds) {
      return { valid: false, reason: 'timestamp_out_of_tolerance' };
    }
  }

  const expected = createHmac('sha256', secret)
    .update(`${parsed.timestamp}.${body}`, 'utf8')
    .digest('hex');

  if (!constantTimeEqualHex(expected, parsed.v1)) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  return { valid: true };
}

function parseSignatureHeader(raw: string): { timestamp: number; v1: string } | null {
  const parts = raw.split(',').map((p) => p.trim());
  let timestamp: number | null = null;
  let v1: string | null = null;

  for (const part of parts) {
    if (part.startsWith('t=')) {
      const n = Number(part.slice(2));
      if (Number.isFinite(n) && n > 0) timestamp = Math.floor(n);
    } else if (part.startsWith('v1=')) {
      v1 = part.slice(3);
    }
  }

  if (timestamp === null || v1 === null) return null;
  if (!/^[0-9a-f]{64}$/i.test(v1)) return null;
  return { timestamp, v1 };
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
