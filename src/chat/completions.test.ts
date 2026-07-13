/**
 * Tests for `chat.completions`.
 *
 *   - create(): forwards messages + stream=false, decodes the JSON
 *     body, decodes `x-hakim-*` observability headers into
 *     `usage_headers` + `limits`.
 *   - create(): preserves `reasoning: { enabled: true }` on the
 *     payload (opt-in CoT for non-stream).
 *   - create(): overrides caller-supplied `stream: true` to false.
 *   - stream(): forces `stream: true`, parses SSE frames in order,
 *     terminates on `data: [DONE]`, surfaces `event: error`
 *     envelopes as a `HakimError`.
 *   - stream(): decodes the preflight `x-hakim-*` headers
 *     (kind / unit-type / model) into `usage_preflight`.
 *   - SSE parser: skips heartbeat comments, handles partial chunks
 *     split across `read()` boundaries, tolerates a trailing
 *     event without the spec-mandated blank line.
 */

import { describe, expect, it } from 'vitest';
import { Hakim } from '../client.js';
import { HakimError, ServiceUnavailableError } from '../errors.js';
import type { ChatCompletionChunk, ChatCompletionResponse } from '../types.js';

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-request-id': 'srv-1', ...headers },
  });
}

function sseResponse(frames: string[], headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'srv-1', ...headers },
  });
}

const OBS_HEADERS = {
  'x-hakim-usage-kind': 'llm_chat',
  'x-hakim-usage-units': '120',
  'x-hakim-usage-unit-type': 'tokens',
  'x-hakim-usage-credits': '120',
  'x-hakim-usage-cost-usd': '0.0006',
  'x-hakim-period-start': '2026-05-01T00:00:00Z',
  'x-hakim-period-end': '2026-06-01T00:00:00Z',
  'x-hakim-model': 'hakim-chat-v1',
  'x-hakim-plan-id': 'pro',
  'x-hakim-credits-included': '1000000',
  'x-hakim-credits-used': '120',
  'x-hakim-credits-remaining': '999880',
  'x-hakim-credits-effective-limit': '1000000',
  'x-hakim-concurrency-limit': '10',
  'x-hakim-concurrency-current': '1',
};

const SAMPLE_BODY: ChatCompletionResponse = {
  id: 'chatcmpl-abc',
  object: 'chat.completion',
  created: 1748400000,
  model: 'hakim-chat-v1',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Marhaba!' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
};

describe('chat.completions.create', () => {
  it('returns the JSON body + decoded observability headers', async () => {
    let seenBody: { stream: boolean; messages: unknown[] } | undefined;
    const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      seenBody = JSON.parse(init?.body as string);
      return jsonResponse(SAMPLE_BODY, OBS_HEADERS);
    }) as typeof fetch;

    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const result = await hakim.chat.completions.create({
      model: 'hakim-chat-v1',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(result.id).toBe('chatcmpl-abc');
    expect(result.choices[0]?.message.content).toBe('Marhaba!');
    expect(result.usage.total_tokens).toBe(8);
    expect(result.usage_headers).toMatchObject({
      kind: 'llm_chat',
      unit_type: 'tokens',
      units: 120,
      credits: 120,
      cost_usd: '0.0006',
      model: 'hakim-chat-v1',
    });
    expect(result.limits?.credits.remaining).toBe(999880);
    expect(result.limits?.concurrency.current).toBe(1);
    expect(result.meta.requestId).toBe('srv-1');
    expect(seenBody?.stream).toBe(false);
  });

  it('forwards reasoning: { enabled: true } verbatim on non-stream', async () => {
    let seenBody: { reasoning?: { enabled: boolean } } | undefined;
    const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      seenBody = JSON.parse(init?.body as string);
      return jsonResponse({
        ...SAMPLE_BODY,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Marhaba!',
              reasoning: 'User greeted me, I should greet back politely.',
            },
            finish_reason: 'stop',
          },
        ],
      });
    }) as typeof fetch;

    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const result = await hakim.chat.completions.create({
      model: 'hakim-chat-v1',
      messages: [{ role: 'user', content: 'Hi' }],
      reasoning: { enabled: true },
    });

    expect(seenBody?.reasoning).toEqual({ enabled: true });
    expect(result.choices[0]?.message.reasoning).toMatch(/greeted/);
    expect(result.choices[0]?.message.content).toBe('Marhaba!');
  });

  it('overrides caller-supplied stream:true to false', async () => {
    let seenBody: { stream: boolean } | undefined;
    const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      seenBody = JSON.parse(init?.body as string);
      return jsonResponse(SAMPLE_BODY);
    }) as typeof fetch;

    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    await hakim.chat.completions.create({
      model: 'hakim-chat-v1',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
    expect(seenBody?.stream).toBe(false);
  });
});

describe('chat.completions.stream', () => {
  function chunk(content?: string, finish?: ChatCompletionChunk['choices'][0]['finish_reason']) {
    const delta: ChatCompletionChunk['choices'][0]['delta'] = {};
    if (content !== undefined) delta.content = content;
    const c: ChatCompletionChunk = {
      id: 'chatcmpl-abc',
      object: 'chat.completion.chunk',
      created: 1748400000,
      model: 'hakim-chat-v1',
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    };
    return `data: ${JSON.stringify(c)}\n\n`;
  }

  it('forces stream:true on body and yields parsed chunks', async () => {
    let seenBody: { stream: boolean } | undefined;
    const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      seenBody = JSON.parse(init?.body as string);
      return sseResponse(
        [': heartbeat\n\n', chunk('Mar'), chunk('haba'), chunk('!', 'stop'), 'data: [DONE]\n\n'],
        OBS_HEADERS,
      );
    }) as typeof fetch;

    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const res = await hakim.chat.completions.stream({
      model: 'hakim-chat-v1',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: false,
    });

    expect(seenBody?.stream).toBe(true);
    expect(res.usage_preflight).toEqual({
      kind: 'llm_chat',
      unit_type: 'tokens',
      model: 'hakim-chat-v1',
    });

    const collected: string[] = [];
    for await (const c of res.stream) {
      const d = c.choices[0]?.delta.content;
      if (d !== undefined) collected.push(d);
    }
    expect(collected.join('')).toBe('Marhaba!');
  });

  it('rejoins SSE frames split across read() boundaries', async () => {
    const f = (async () => {
      const a = `data: ${JSON.stringify({
        id: 'chatcmpl-a',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'hakim-chat-v1',
        choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }],
      })}`;
      const b = `\n\ndata: ${JSON.stringify({
        id: 'chatcmpl-a',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'hakim-chat-v1',
        choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }],
      })}\n\ndata: [DONE]\n\n`;
      return sseResponse([a, b]);
    }) as typeof fetch;

    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const res = await hakim.chat.completions.stream({
      model: 'hakim-chat-v1',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    const collected: string[] = [];
    for await (const c of res.stream) {
      const d = c.choices[0]?.delta.content;
      if (d !== undefined) collected.push(d);
    }
    expect(collected.join('')).toBe('Hello');
  });

  it('surfaces an `event: error` envelope as a HakimError', async () => {
    const errFrame =
      'event: error\n' +
      'data: ' +
      JSON.stringify({
        error: {
          type: 'service_unavailable',
          code: 'upstream_overloaded',
          message: 'Together returned 503 mid-stream',
        },
      }) +
      '\n\n';

    const f = (async () =>
      sseResponse([chunk('Hi'), errFrame, 'data: [DONE]\n\n'])) as typeof fetch;

    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const res = await hakim.chat.completions.stream({
      model: 'hakim-chat-v1',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    await expect(async () => {
      for await (const _c of res.stream) {
        void _c;
      }
    }).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it('throws on a malformed (non-JSON) data frame', async () => {
    const f = (async () => sseResponse(['data: {not-json\n\n'])) as typeof fetch;
    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const res = await hakim.chat.completions.stream({
      model: 'hakim-chat-v1',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    await expect(async () => {
      for await (const _c of res.stream) {
        void _c;
      }
    }).rejects.toBeInstanceOf(HakimError);
  });
});
