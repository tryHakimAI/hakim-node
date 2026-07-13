/**
 * Client construction + env-var resolution + UA tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hakim } from './client.js';

describe('Hakim constructor', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      HAKIM_API_KEY: process.env.HAKIM_API_KEY,
      HAKIM_API_TOKEN: process.env.HAKIM_API_TOKEN,
      HAKIM_BASE_URL: process.env.HAKIM_BASE_URL,
    };
    delete process.env.HAKIM_API_KEY;
    delete process.env.HAKIM_API_TOKEN;
    delete process.env.HAKIM_BASE_URL;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('throws when no API key is provided or available via env', () => {
    expect(() => new Hakim()).toThrow(/missing API key/);
  });

  it('reads HAKIM_API_KEY from env when `apiKey` option is absent', async () => {
    process.env.HAKIM_API_KEY = 'hk_test_env';
    const calls: Array<RequestInit | undefined> = [];
    const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const hakim = new Hakim({ fetchImpl: f });
    await hakim.usage.summary();
    const headers = calls[0]!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer hk_test_env');
  });

  it('respects explicit baseURL override', async () => {
    const calls: string[] = [];
    const f = (async (u: RequestInfo | URL) => {
      calls.push(u.toString());
      return new Response(
        JSON.stringify({
          period: { start: 'x', end: 'y' },
          tts: { characters: 0, included: 0, overage_chars: 0 },
          stt: { seconds: 0, included: 0, overage_seconds: 0 },
          estimated_overage_usd: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const hakim = new Hakim({
      apiKey: 'hk_test_x',
      baseURL: 'https://staging.api.tryhakim.ai',
      fetchImpl: f,
    });
    await hakim.usage.summary();
    expect(calls[0]).toBe('https://staging.api.tryhakim.ai/v1/usage');
  });

  it('appends userAgentSuffix to the SDK UA', async () => {
    let ua: string | undefined;
    const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      ua = (init?.headers as Record<string, string>)['user-agent'];
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const hakim = new Hakim({
      apiKey: 'hk_test_x',
      fetchImpl: f,
      userAgentSuffix: 'my-app/2.0.0',
    });
    await hakim.usage.summary();
    expect(ua).toMatch(/hakim-voice\/.*my-app\/2\.0\.0$/);
  });
});
