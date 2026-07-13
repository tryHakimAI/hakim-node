/**
 * `usage` — GET /v1/usage + GET /v1/usage/events.
 *
 * `summary()` returns the current billing-period rollup. `events()`
 * returns a cursor-paginated page of raw events. `eventsIter()` walks
 * every page automatically — stop early by `break`ing out of the loop.
 */

import type { Transport } from './transport.js';
import type {
  LimitsSnapshot,
  UsageEvent,
  UsageEventDetail,
  UsageEventsList,
  UsageEventsQuery,
  UsageSummary,
} from './types.js';

export class UsageAPI {
  constructor(private readonly transport: Transport) {}

  async summary(opts: { signal?: AbortSignal } = {}): Promise<UsageSummary> {
    const res = await this.transport.request({
      method: 'GET',
      path: '/v1/usage',
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return (await res.json()) as UsageSummary;
  }

  /**
   * Point-in-time snapshot of every limit the org is subject to ·
   * plan, billing period, credits, concurrency, and rate-limit. Stable
   * enough for a dashboard tile but cheap enough to poll every 30 s.
   * Maps to `GET /v1/limits`.
   */
  async limits(opts: { signal?: AbortSignal } = {}): Promise<LimitsSnapshot> {
    const res = await this.transport.request({
      method: 'GET',
      path: '/v1/limits',
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return (await res.json()) as LimitsSnapshot;
  }

  async events(
    query: UsageEventsQuery = {},
    opts: { signal?: AbortSignal } = {},
  ): Promise<UsageEventsList> {
    const res = await this.transport.request({
      method: 'GET',
      path: '/v1/usage/events',
      query: toQueryParams(query),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return (await res.json()) as UsageEventsList;
  }

  /**
   * Look up a single event by id · the typical use is dereferencing
   * the `x-request-id` scraped from a TTS / STT response into the
   * row's metadata (`credits`, `cost_usd`, `model`). Maps to
   * `GET /v1/usage/events/:id`.
   */
  async event(id: string, opts: { signal?: AbortSignal } = {}): Promise<UsageEventDetail> {
    const res = await this.transport.request({
      method: 'GET',
      path: `/v1/usage/events/${encodeURIComponent(id)}`,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return (await res.json()) as UsageEventDetail;
  }

  /** Auto-paginate usage events. `limit` controls the page size (not
   *  the total returned). Stop by breaking out of the loop. */
  async *eventsIter(
    query: UsageEventsQuery = {},
    opts: { signal?: AbortSignal } = {},
  ): AsyncIterable<UsageEvent> {
    let cursor: string | null | undefined = query.cursor;
    while (true) {
      const page: UsageEventsList = await this.events(
        {
          ...query,
          ...(cursor !== undefined && cursor !== null ? { cursor } : {}),
        },
        opts,
      );
      for (const ev of page.data) yield ev;
      if (!page.has_more || !page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }
}

function toQueryParams(q: UsageEventsQuery): Record<string, string | number | undefined> {
  const out: Record<string, string | number | undefined> = {};
  if (q.kind !== undefined) out.kind = q.kind;
  if (q.limit !== undefined) out.limit = q.limit;
  if (q.cursor !== undefined) out.cursor = q.cursor;
  return out;
}
