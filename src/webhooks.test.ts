/**
 * Tests for the `webhooks` namespace + `verifyWebhookSignature`.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { Hakim } from './client.js';
import { verifyWebhookSignature } from './webhooks.js';

function makeSigHeader(secret: string, body: string, timestamp: number): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

const WH = {
  id: 'wh_1',
  url: 'https://example.com/hook',
  events: ['job.completed'],
  active: true,
  created_at: new Date(0).toISOString(),
};

describe('webhooks API', () => {
  it('create returns the secret exactly as the server sends it', async () => {
    let seenMethod: string | undefined;
    let seenPath: string | undefined;
    let seenBody: string | undefined;

    const f = (async (u: RequestInfo | URL, init?: RequestInit) => {
      seenMethod = init?.method;
      seenPath = new URL(u.toString()).pathname;
      seenBody = init?.body as string;
      return new Response(JSON.stringify({ ...WH, secret: 'whsec_' + 'a'.repeat(32) }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const created = await hakim.webhooks.create({
      url: 'https://example.com/hook',
      events: ['job.completed'],
    });
    expect(seenMethod).toBe('POST');
    expect(seenPath).toBe('/v1/webhooks');
    expect(JSON.parse(seenBody!)).toEqual({
      url: 'https://example.com/hook',
      events: ['job.completed'],
    });
    expect(created.secret).toMatch(/^whsec_/);
  });

  it('list / retrieve / update / delete hit the expected paths', async () => {
    const calls: Array<{ method: string | undefined; path: string }> = [];
    const f = (async (u: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        method: init?.method,
        path: new URL(u.toString()).pathname,
      });
      if (init?.method === 'DELETE') {
        return new Response(JSON.stringify({ object: 'webhook', id: 'wh_1', deleted: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (init?.method === undefined || init.method === 'GET') {
        // list vs retrieve
        const isList = new URL(u.toString()).pathname === '/v1/webhooks';
        return new Response(JSON.stringify(isList ? { object: 'list', data: [WH] } : WH), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ...WH, active: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const list = await hakim.webhooks.list();
    expect(list.data).toHaveLength(1);
    const got = await hakim.webhooks.retrieve('wh_1');
    expect(got.id).toBe('wh_1');
    const updated = await hakim.webhooks.update('wh_1', { active: false });
    expect(updated.active).toBe(false);
    const del = await hakim.webhooks.delete('wh_1');
    expect(del.deleted).toBe(true);

    expect(calls.map((c) => (c.method ?? 'GET') + ' ' + c.path)).toEqual([
      'GET /v1/webhooks',
      'GET /v1/webhooks/wh_1',
      'PATCH /v1/webhooks/wh_1',
      'DELETE /v1/webhooks/wh_1',
    ]);
  });

  it('iterDeliveries walks every page via next_cursor', async () => {
    let call = 0;
    const pages = [
      {
        object: 'list',
        data: [makeDelivery('d1'), makeDelivery('d2')],
        has_more: true,
        next_cursor: 'cur_1',
      },
      {
        object: 'list',
        data: [makeDelivery('d3')],
        has_more: false,
        next_cursor: null,
      },
    ];
    const seenCursors: Array<string | null> = [];
    const f = (async (u: RequestInfo | URL) => {
      const url = new URL(u.toString());
      seenCursors.push(url.searchParams.get('cursor'));
      const body = pages[call++]!;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const collected: string[] = [];
    for await (const d of hakim.webhooks.iterDeliveries('wh_1')) {
      collected.push(d.id);
    }
    expect(collected).toEqual(['d1', 'd2', 'd3']);
    expect(seenCursors).toEqual([null, 'cur_1']);
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'whsec_' + 'a'.repeat(40);
  const body = JSON.stringify({ event: 'job.completed', id: 'evt_1' });

  it('accepts a well-formed recent signature', () => {
    const ts = 1_700_000_000;
    const header = makeSigHeader(secret, body, ts);
    const res = verifyWebhookSignature({
      secret,
      body,
      signature: header,
      now: () => ts,
    });
    expect(res.valid).toBe(true);
  });

  it('rejects a signature mismatch', () => {
    const ts = 1_700_000_000;
    const header = makeSigHeader('whsec_other', body, ts);
    const res = verifyWebhookSignature({
      secret,
      body,
      signature: header,
      now: () => ts,
    });
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.reason).toBe('signature_mismatch');
  });

  it('rejects a timestamp outside the tolerance window', () => {
    const signedAt = 1_700_000_000;
    const header = makeSigHeader(secret, body, signedAt);
    const res = verifyWebhookSignature({
      secret,
      body,
      signature: header,
      now: () => signedAt + 10 * 60, // 10 minutes later
    });
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.reason).toBe('timestamp_out_of_tolerance');
  });

  it('rejects a malformed header', () => {
    const res = verifyWebhookSignature({
      secret,
      body,
      signature: 'not-even-close',
      now: () => 1_700_000_000,
    });
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.reason).toBe('malformed_header');
  });

  it('disables replay check when toleranceSeconds=0', () => {
    const header = makeSigHeader(secret, body, 1_000_000);
    const res = verifyWebhookSignature({
      secret,
      body,
      signature: header,
      toleranceSeconds: 0,
      now: () => 9_999_999,
    });
    expect(res.valid).toBe(true);
  });

  it('uses constant-time equality (length mismatch rejected cleanly)', () => {
    const ts = 1_700_000_000;
    const res = verifyWebhookSignature({
      secret,
      body,
      signature: `t=${ts},v1=deadbeef`,
      now: () => ts,
    });
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.reason).toBe('malformed_header');
  });
});

function makeDelivery(id: string) {
  return {
    id,
    webhook_id: 'wh_1',
    event: 'job.completed',
    status: 'succeeded',
    status_code: 200,
    attempts: 1,
    next_retry_at: null,
    delivered_at: new Date(0).toISOString(),
    created_at: new Date(0).toISOString(),
  };
}
