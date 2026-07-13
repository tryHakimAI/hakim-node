/**
 * Tests for `audio.speech`.
 *   - create(): buffers Uint8Array, decodes X-Usage-Characters + X-Duration-Ms.
 *   - create(): always sends stream=false.
 *   - stream(): always sends stream=true, yields chunks as they arrive.
 *   - Error mapping is handled at the transport layer; here we assert
 *     that the route helpers pass through the fetch response correctly.
 */

import { describe, expect, it } from 'vitest';
import { Hakim } from '../client.js';

function binaryResponse(body: Uint8Array, headers: Record<string, string> = {}): Response {
  const buf = new ArrayBuffer(body.byteLength);
  new Uint8Array(buf).set(body);
  return new Response(buf, {
    status: 200,
    headers: { 'content-type': 'audio/mpeg', ...headers },
  });
}

function streamingResponse(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'audio/mpeg', ...headers },
  });
}

describe('audio.speech.create', () => {
  it('returns audio bytes + decoded headers', async () => {
    let seenBody: string | undefined;
    const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      seenBody = init?.body as string;
      return binaryResponse(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), {
        'x-usage-characters': '42',
        'x-duration-ms': '1200',
        'x-request-id': 'srv-1',
      });
    }) as typeof fetch;

    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const result = await hakim.audio.speech.create({
      model: 'hakim-fast-v1',
      input: 'hello',
      voice: 'omar',
    });

    expect(result.audio).toBeInstanceOf(Uint8Array);
    expect(result.audio.length).toBe(4);
    expect(result.contentType).toBe('audio/mpeg');
    expect(result.usageCharacters).toBe(42);
    expect(result.durationMs).toBe(1200);
    expect(result.meta.requestId).toBe('srv-1');
    expect(JSON.parse(seenBody!)).toMatchObject({ stream: false });
  });

  it('overrides caller-supplied `stream: true` to buffered', async () => {
    let sentBody: unknown;
    const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string);
      return binaryResponse(new Uint8Array([1, 2, 3]));
    }) as typeof fetch;
    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    await hakim.audio.speech.create({
      model: 'hakim-fast-v1',
      input: 'x',
      voice: 'omar',
      stream: true,
    });
    expect((sentBody as { stream: boolean }).stream).toBe(false);
  });
});

describe('audio.speech.stream', () => {
  it('yields chunks from the server stream in order', async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4]), new Uint8Array([5])];
    const f = (async () =>
      streamingResponse(chunks, { 'x-usage-characters': '10' })) as typeof fetch;

    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const res = await hakim.audio.speech.stream({
      model: 'hakim-fast-v1',
      input: 'streaming',
      voice: 'omar',
    });
    expect(res.usageCharacters).toBe(10);

    const collected: number[] = [];
    for await (const c of res.stream) collected.push(...c);
    expect(collected).toEqual([1, 2, 3, 4, 5]);
  });

  it('forces stream=true in the body even if caller says false', async () => {
    let seenBody: unknown;
    const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      seenBody = JSON.parse(init?.body as string);
      return streamingResponse([new Uint8Array([0])]);
    }) as typeof fetch;

    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const res = await hakim.audio.speech.stream({
      model: 'hakim-fast-v1',
      input: 'x',
      voice: 'omar',
      stream: false,
    });
    // consume the stream
    for await (const _c of res.stream) {
      void _c;
    }
    expect((seenBody as { stream: boolean }).stream).toBe(true);
  });
});
