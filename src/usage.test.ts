/**
 * Tests for `usage.summary`, `usage.events`, `usage.eventsIter`.
 */

import { describe, expect, it } from 'vitest';
import { Hakim } from './client.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('usage.summary', () => {
  it('returns the typed summary', async () => {
    const summary = {
      period: { start: '2026-04-01T00:00:00.000Z', end: '2026-05-01T00:00:00.000Z' },
      tts: { characters: 100, included: 50_000, overage_chars: 0 },
      stt: { seconds: 30, included: 3_600, overage_seconds: 0 },
      estimated_overage_usd: 0,
    };
    const f = (async () => jsonResponse(200, summary)) as typeof fetch;
    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const s = await hakim.usage.summary();
    expect(s.tts.characters).toBe(100);
    expect(s.estimated_overage_usd).toBe(0);
  });
});

describe('usage.events + eventsIter', () => {
  it('lists a single page', async () => {
    const page = {
      data: [
        {
          id: 'ue_1',
          kind: 'tts',
          units: 42,
          api_key_id: 'ak_1',
          request_id: 'req_1',
          status_code: 200,
          latency_ms: 123,
          created_at: '2026-04-17T10:00:00.000Z',
        },
      ],
      has_more: false,
      next_cursor: null,
    };
    let seenUrl: string | undefined;
    const f = (async (u: RequestInfo | URL) => {
      seenUrl = u.toString();
      return jsonResponse(200, page);
    }) as typeof fetch;
    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const res = await hakim.usage.events({ kind: 'tts', limit: 25 });
    expect(res.data.length).toBe(1);
    expect(seenUrl).toMatch(/kind=tts/);
    expect(seenUrl).toMatch(/limit=25/);
  });

  it('auto-paginates with eventsIter when has_more is true', async () => {
    const page1 = {
      data: [
        {
          id: 'e1',
          kind: 'tts',
          units: 1,
          api_key_id: null,
          request_id: null,
          status_code: 200,
          latency_ms: 10,
          created_at: '2026-04-17T10:00:00.000Z',
        },
      ],
      has_more: true,
      next_cursor: 'cursor-2',
    };
    const page2 = {
      data: [
        {
          id: 'e2',
          kind: 'tts',
          units: 2,
          api_key_id: null,
          request_id: null,
          status_code: 200,
          latency_ms: 12,
          created_at: '2026-04-17T10:00:01.000Z',
        },
      ],
      has_more: false,
      next_cursor: null,
    };
    const pages = [page1, page2];
    let i = 0;
    const urls: string[] = [];
    const f = (async (u: RequestInfo | URL) => {
      urls.push(u.toString());
      const p = pages[Math.min(i++, pages.length - 1)];
      return jsonResponse(200, p);
    }) as typeof fetch;
    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const ids: string[] = [];
    for await (const ev of hakim.usage.eventsIter({ limit: 1 })) ids.push(ev.id);
    expect(ids).toEqual(['e1', 'e2']);
    expect(urls[1]).toMatch(/cursor=cursor-2/);
  });
});
