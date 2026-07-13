/**
 * `jobs` — public `/v1/jobs` list + retrieve.
 *
 *   GET /v1/jobs            → paginated list for the caller's org
 *   GET /v1/jobs/:id        → fetch one job (result_url on success)
 *
 * The server cursor-paginates on `(createdAt desc, id desc)` so
 * `has_more` + `next_cursor` ride alongside the data array.
 *
 * The SDK does NOT auto-download `result_url`. Callers get a fresh
 * signed URL on every `retrieve()` call (TTL is 24 h server-side);
 * downloading is a plain `fetch(result_url)` away. The `iter()`
 * helper below walks all pages and is the canonical "fetch everything
 * newer than my bookmark" affordance.
 */

import type { Transport } from './transport.js';
import type { Job, JobsListQuery, JobsListResponse } from './types.js';

export class JobsAPI {
  constructor(private readonly transport: Transport) {}

  async list(
    query: JobsListQuery = {},
    opts: { signal?: AbortSignal } = {},
  ): Promise<JobsListResponse> {
    const q: Record<string, string | number | undefined> = {};
    if (query.status !== undefined) q.status = query.status;
    if (query.type !== undefined) q.type = query.type;
    if (query.limit !== undefined) q.limit = query.limit;
    if (query.cursor !== undefined) q.cursor = query.cursor;

    const res = await this.transport.request({
      method: 'GET',
      path: '/v1/jobs',
      query: q,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return (await res.json()) as JobsListResponse;
  }

  async retrieve(id: string, opts: { signal?: AbortSignal } = {}): Promise<Job> {
    const res = await this.transport.request({
      method: 'GET',
      path: `/v1/jobs/${encodeURIComponent(id)}`,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return (await res.json()) as Job;
  }

  /** Walk every job page-by-page. Stops once the server reports
   *  `has_more: false`. Passes the original filter + limit through
   *  unchanged; only `cursor` advances. */
  async *iter(query: JobsListQuery = {}, opts: { signal?: AbortSignal } = {}): AsyncIterable<Job> {
    let cursor = query.cursor;
    while (true) {
      const page = await this.list({ ...query, ...(cursor !== undefined ? { cursor } : {}) }, opts);
      for (const j of page.data) yield j;
      if (!page.has_more || !page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }
}
