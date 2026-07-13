# @hakim/voice

Official Node.js / TypeScript client for the [Hakim](https://tryhakim.ai) API.

> **Status:** `1.0.0` — stable.

## Install

```bash
npm install @hakim/voice
```

Requires Node.js **>= 18** (uses native `fetch`, `AbortController`,
`FormData`, `Blob`). Works on Bun and Deno too.

## Quickstart

```ts
import { Hakim } from '@hakim/voice';
import { writeFile } from 'node:fs/promises';

const hakim = new Hakim({
  apiKey: process.env.HAKIM_API_KEY!,
});

// 0. Discover available voices. Each row carries an `id` (stable,
//    unique — recommended for production traffic) and a `slug` (e.g.
//    `priya-hi`) for readability.
const voices = await hakim.audio.voices.list();
const priya = voices.find((v) => v.slug === 'priya-hi');
if (!priya) throw new Error('voice not provisioned');

// 1. Synthesize speech (buffered). Pass `id` rather than `slug` —
//    slugs may collide between a preset and an org clone with the
//    same name, and they shift if a voice is renamed.
const speech = await hakim.audio.speech.create({
  model: 'hakim-fast-v1',
  input: 'مرحبا بك في منصتنا',
  voice: priya.id,
  response_format: 'mp3',
});
await writeFile('out.mp3', speech.audio);
console.log('billed', speech.usageCharacters, 'characters');

// 2. Streaming synthesis (low-latency start).
const { stream } = await hakim.audio.speech.stream({
  model: 'hakim-fast-v1',
  input: 'مرحبا',
  voice: priya.id,
});
for await (const chunk of stream) {
  process.stdout.write(chunk);
}

// 3. Transcribe audio.
import { readFile } from 'node:fs/promises';
const audio = await readFile('clip.wav');
const result = await hakim.audio.transcriptions.create({
  file: audio,
  model: 'hakim-arab-v2',
  language: 'ar',
  response_format: 'json',
});
if (result.kind === 'sync_json') console.log(result.data.text);

// 4. List voices.
const { data: voices } = await hakim.audio.voices.list({ language: 'ar' });

// 5. Usage summary.
const summary = await hakim.usage.summary();
console.log(`${summary.tts.characters} / ${summary.tts.included} TTS characters used`);
```

## Chat completions (`hakim.chat.completions`)

OpenAI-compatible chat API backed by Hakim's Arabic-first LLM
(`hakim-chat-v1`). Drop-in compatible with any code that targets
the OpenAI Chat Completions reference — swap the base URL and key
and you're done.

```ts
// Non-streaming.
const completion = await hakim.chat.completions.create({
  model: 'hakim-chat-v1',
  messages: [
    { role: 'system', content: 'أنت مساعد عربي مفيد.' },
    { role: 'user', content: 'اكتب قصيدة قصيرة عن البحر.' },
  ],
  temperature: 0.7,
});
console.log(completion.choices[0].message.content);
console.log('billed', completion.usage_headers?.credits, 'credits');

// Streaming (SSE). Stream replies token-by-token; the final chunk
// carries the rolled-up `usage` block.
const { stream } = await hakim.chat.completions.stream({
  model: 'hakim-chat-v1',
  messages: [{ role: 'user', content: 'مرحبا!' }],
});
for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta.content;
  if (delta) process.stdout.write(delta);
  if (chunk.usage) console.log('\n[usage]', chunk.usage);
}
```

### Reasoning / chain-of-thought

`hakim-chat-v1` is a thinking-capable model. The chain-of-thought
trace is **off by default** — it adds 10–50× latency and burns
completion tokens that don't reach your UI in time.

Opt in on **non-streaming** requests only:

```ts
const completion = await hakim.chat.completions.create({
  model: 'hakim-chat-v1',
  messages: [{ role: 'user', content: 'حلّ ٢٤ × ١٧ خطوة بخطوة.' }],
  reasoning: { enabled: true },
});
console.log(completion.choices[0].message.reasoning); // chain-of-thought
console.log(completion.choices[0].message.content); // final answer
```

Streaming requests with `reasoning: { enabled: true }` are
rejected with a `400 invalid_request_error` — real-time agents
cannot afford the latency cost. Make a non-streaming request if
you need CoT.

## Configuration

```ts
new Hakim({
  apiKey: 'hk_live_...', // or HAKIM_API_KEY env
  baseURL: 'https://api.tryhakim.ai', // or HAKIM_BASE_URL env
  timeoutMs: 120_000, // per-request; TTS can be slow
  maxRetries: 2, // on 5xx / 429 / connection errors
  userAgentSuffix: 'my-app/1.0.0', // appended to the SDK UA
});
```

## Feature highlights

- **Native `fetch`** — no `axios` / `undici` dependency; bundle stays small.
- **Typed request/response shapes** mirroring the Hakim API schema.
- **Uniform error model**: every non-2xx surfaces as a `HakimError`
  subclass (`AuthenticationError`, `RateLimitError`, `QuotaExceededError`,
  `IdempotencyConflictError`, …). All errors carry `status`, `type`,
  `code`, and `requestId` for support tickets.
- **Automatic retries** with jittered exponential backoff on `5xx`,
  `429`, `408`, and low-level connection errors. Honors `Retry-After`.
- **Auto-`Idempotency-Key`** on mutating JSON calls (can be overridden
  per call via `{ idempotencyKey: '…' }`).
- **`X-Request-Id`** generated per call and echoed back on both
  success (`response.meta.requestId`) and failure (`err.requestId`).
- **Streaming TTS** via `AsyncIterable<Uint8Array>` — no need to touch
  the raw `ReadableStream`.
- **AbortSignal support** on every call.
- **Cursor pagination** auto-walked by `usage.eventsIter`.

## Errors

```ts
import {
  Hakim,
  HakimError,
  RateLimitError,
  QuotaExceededError,
} from '@hakim/voice';

try {
  await hakim.audio.speech.create({ ... });
} catch (err) {
  if (err instanceof RateLimitError && err.retryAfterMs) {
    await new Promise((r) => setTimeout(r, err.retryAfterMs));
  } else if (err instanceof QuotaExceededError) {
    console.error('plan exhausted — upgrade at /app/settings/billing');
  } else if (err instanceof HakimError) {
    console.error(`[${err.requestId}] ${err.type}/${err.code}: ${err.message}`);
  } else {
    throw err;
  }
}
```

## License

MIT — see [LICENSE](./LICENSE).
