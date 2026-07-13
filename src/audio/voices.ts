/**
 * `audio.voices` — list + create + retrieve + delete.
 *
 *   GET    /v1/audio/voices        → list presets + cloned voices
 *   POST   /v1/audio/voices        → create (clone) a new voice
 *   GET    /v1/audio/voices/:id    → fetch one (fresh preview URL)
 *   DELETE /v1/audio/voices/:id    → soft-delete a cloned voice
 *
 * Cloned voices return `status: 'processing'` immediately; the server
 * runs the clone pipeline async and flips the row to `ready` (or
 * `failed`) later. Callers should poll `retrieve(id)` or subscribe to
 * `voice.ready` / `voice.failed` webhooks instead of busy-polling.
 */

import type { Transport } from '../transport.js';
import type { Voice, VoiceCreateRequest, VoicesListQuery, VoicesListResponse } from '../types.js';
import { audioInputToBlob } from './to-blob.js';

export class VoicesAPI {
  constructor(private readonly transport: Transport) {}

  async list(
    query: VoicesListQuery = {},
    opts: { signal?: AbortSignal } = {},
  ): Promise<VoicesListResponse> {
    const res = await this.transport.request({
      method: 'GET',
      path: '/v1/audio/voices',
      query: toQueryParams(query),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    const body = (await res.json()) as VoicesListResponse;
    return body;
  }

  /** Convenience: iterate every voice (presets first, then clones).
   *  Today the server returns the full set in one page, so this just
   *  wraps `list()`. When pagination lands this method absorbs it. */
  async *iter(
    query: VoicesListQuery = {},
    opts: { signal?: AbortSignal } = {},
  ): AsyncIterable<Voice> {
    const { data } = await this.list(query, opts);
    for (const v of data) yield v;
  }

  /** Clone a voice. Returns the Voice row in `status: 'processing'`;
   *  poll `retrieve(id)` or listen for a `voice.ready` webhook to
   *  learn when the clone is usable. */
  async create(
    request: VoiceCreateRequest,
    opts: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<Voice> {
    const filename = request.filename ?? 'sample.bin';
    const blob = await audioInputToBlob(request.sample, filename);

    const form = new FormData();
    form.append('file', blob, filename);
    form.append('name', request.name);
    if (request.description !== undefined) {
      form.append('description', request.description);
    }
    form.append('language', request.language);
    form.append('consent_confirmed', 'true');

    const res = await this.transport.request({
      method: 'POST',
      path: '/v1/audio/voices',
      formData: form,
      accept: 'application/json',
      headers: { accept: 'application/json' },
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return (await res.json()) as Voice;
  }

  async retrieve(id: string, opts: { signal?: AbortSignal } = {}): Promise<Voice> {
    const res = await this.transport.request({
      method: 'GET',
      path: `/v1/audio/voices/${encodeURIComponent(id)}`,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return (await res.json()) as Voice;
  }

  async delete(
    id: string,
    opts: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<{ object: 'voice'; id: string; deleted: true }> {
    const res = await this.transport.request({
      method: 'DELETE',
      path: `/v1/audio/voices/${encodeURIComponent(id)}`,
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return (await res.json()) as { object: 'voice'; id: string; deleted: true };
  }
}

function toQueryParams(q: VoicesListQuery): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (q.language !== undefined) out.language = q.language;
  if (q.gender !== undefined) out.gender = q.gender;
  if (q.kind !== undefined) out.kind = q.kind;
  return out;
}
