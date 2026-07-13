/**
 * Tests for the `jobs` namespace.
 */

import { describe, expect, it } from 'vitest';
import { Hakim } from './client.js';

function makeJob(id: string, status: string = 'succeeded') {
  return {
    id,
    type: 'batch_stt',
    status,
    progress_pct: status === 'succeeded' ? 100 : 50,
    result_url: status === 'succeeded' ? 'https://example.com/out.json?sig=x' : null,
    error_message: null,
    error_code: null,
    created_at: new Date(0).toISOString(),
    finished_at: status === 'succeeded' ? new Date(0).toISOString() : null,
  };
}

describe('jobs API', () => {
  it('list forwards status / type / limit / cursor as query params', async () => {
    let seenUrl: string | undefined;
    const f = (async (u: RequestInfo | URL) => {
      seenUrl = u.toString();
      return new Response(
        JSON.stringify({
          object: 'list',
          data: [makeJob('j1')],
          has_more: false,
          next_cursor: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    await hakim.jobs.list({
      status: 'succeeded',
      type: 'batch_stt',
      limit: 10,
      cursor: 'j_prev',
    });
    expect(seenUrl).toMatch(/status=succeeded/);
    expect(seenUrl).toMatch(/type=batch_stt/);
    expect(seenUrl).toMatch(/limit=10/);
    expect(seenUrl).toMatch(/cursor=j_prev/);
  });

  it('retrieve URL-encodes the id', async () => {
    let seenPath: string | undefined;
    const f = (async (u: RequestInfo | URL) => {
      seenPath = new URL(u.toString()).pathname;
      return new Response(JSON.stringify(makeJob('j 1')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const job = await hakim.jobs.retrieve('j 1');
    expect(seenPath).toBe('/v1/jobs/j%201');
    expect(job.id).toBe('j 1');
  });

  it('iter walks every page via next_cursor', async () => {
    const pages = [
      { object: 'list', data: [makeJob('j1'), makeJob('j2')], has_more: true, next_cursor: 'cur1' },
      { object: 'list', data: [makeJob('j3')], has_more: false, next_cursor: null },
    ];
    let call = 0;
    const f = (async () =>
      new Response(JSON.stringify(pages[call++]!), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const out: string[] = [];
    for await (const j of hakim.jobs.iter()) out.push(j.id);
    expect(out).toEqual(['j1', 'j2', 'j3']);
  });
});
