/**
 * Tests for `voices.list` + `voices.iter`.
 */

import { describe, expect, it } from 'vitest';
import { Hakim } from '../client.js';

const SAMPLE_VOICES = {
  object: 'list' as const,
  data: [
    {
      id: 'v_1',
      slug: 'omar',
      name: 'Omar',
      kind: 'preset',
      language: 'ar',
      gender: 'male',
      description: null,
      preview_url: null,
      status: 'ready',
    },
    {
      id: 'v_2',
      slug: 'layla',
      name: 'Layla',
      kind: 'preset',
      language: 'ar',
      gender: 'female',
      description: null,
      preview_url: null,
      status: 'ready',
    },
  ],
};

describe('voices.list', () => {
  it('returns the list envelope and forwards query params', async () => {
    let seenUrl: string | undefined;
    const f = (async (u: RequestInfo | URL) => {
      seenUrl = u.toString();
      return new Response(JSON.stringify(SAMPLE_VOICES), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const res = await hakim.audio.voices.list({ language: 'ar', kind: 'preset' });
    expect(res.object).toBe('list');
    expect(res.data.length).toBe(2);
    expect(seenUrl).toMatch(/language=ar/);
    expect(seenUrl).toMatch(/kind=preset/);
  });

  it('alias hakim.voices === hakim.audio.voices', async () => {
    const f = (async () =>
      new Response(JSON.stringify(SAMPLE_VOICES), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    expect(hakim.voices).toBe(hakim.audio.voices);
  });

  it('iter() yields every voice', async () => {
    const f = (async () =>
      new Response(JSON.stringify(SAMPLE_VOICES), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const collected: string[] = [];
    for await (const v of hakim.voices.iter()) collected.push(v.slug);
    expect(collected).toEqual(['omar', 'layla']);
  });
});

describe('voices.create (clone)', () => {
  const CLONE_RESPONSE = {
    id: 'v_cloned_1',
    slug: 'my-voice',
    name: 'My Voice',
    kind: 'cloned',
    language: 'ar',
    gender: 'neutral',
    description: null,
    preview_url: null,
    status: 'processing',
  };

  it('POSTs multipart/form-data with the expected fields', async () => {
    let seenMethod: string | undefined;
    let seenPath: string | undefined;
    let seenBody: FormData | undefined;

    const f = (async (u: RequestInfo | URL, init?: RequestInit) => {
      seenMethod = init?.method;
      seenPath = new URL(u.toString()).pathname;
      seenBody = init?.body as FormData;
      return new Response(JSON.stringify(CLONE_RESPONSE), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const sample = new Uint8Array([1, 2, 3, 4]);
    const voice = await hakim.voices.create({
      sample,
      name: 'My Voice',
      language: 'ar',
      consent_confirmed: true,
      filename: 'sample.wav',
    });

    expect(seenMethod).toBe('POST');
    expect(seenPath).toBe('/v1/audio/voices');
    expect(voice.status).toBe('processing');
    expect(voice.kind).toBe('cloned');

    const fd = seenBody as FormData;
    expect(fd).toBeInstanceOf(FormData);
    expect(fd.get('name')).toBe('My Voice');
    expect(fd.get('language')).toBe('ar');
    expect(fd.get('consent_confirmed')).toBe('true');
    expect(fd.get('file')).toBeInstanceOf(Blob);
  });

  it('omits description when not provided', async () => {
    let fd: FormData | undefined;
    const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      fd = init?.body as FormData;
      return new Response(JSON.stringify(CLONE_RESPONSE), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    await hakim.voices.create({
      sample: new Uint8Array([0]),
      name: 'X',
      language: 'en',
      consent_confirmed: true,
    });
    expect(fd!.get('description')).toBeNull();
  });
});

describe('voices.retrieve / voices.delete', () => {
  it('retrieves a voice by id and URL-encodes the id', async () => {
    let seenPath: string | undefined;
    const f = (async (u: RequestInfo | URL) => {
      seenPath = new URL(u.toString()).pathname;
      return new Response(JSON.stringify({ ...SAMPLE_VOICES.data[0]! }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const v = await hakim.voices.retrieve('v_with slash/?&');
    expect(v.id).toBe('v_1');
    expect(seenPath).toBe('/v1/audio/voices/v_with%20slash%2F%3F%26');
  });

  it('deletes a voice', async () => {
    let seenMethod: string | undefined;
    const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      seenMethod = init?.method;
      return new Response(JSON.stringify({ object: 'voice', id: 'v_1', deleted: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const res = await hakim.voices.delete('v_1');
    expect(seenMethod).toBe('DELETE');
    expect(res.deleted).toBe(true);
  });
});
