/**
 * Server-Sent Events (`text/event-stream`) parser for the chat
 * completions streaming surface.
 *
 * Splits a `ReadableStream<Uint8Array>` from `fetch` into discrete
 * SSE events (delimited by `\n\n`), then for each event:
 *
 *   - skips heartbeat comments (`: …`)
 *   - parses the `data: …` payload into the caller-supplied chunk
 *     shape (`ChatCompletionChunk` in practice)
 *   - terminates on `data: [DONE]`
 *   - surfaces `event: error\ndata: {…}` payloads as a thrown
 *     `HakimError` so a mid-stream upstream failure doesn't get
 *     swallowed by the iterator
 *
 * Kept generic on the chunk type so we can reuse it for any future
 * SSE surface (e.g. a server-events stream on a webhook console)
 * without copy-paste.
 */
import { errorFromPayload, type HakimApiErrorPayload, HakimError } from '../errors.js';

/**
 * Iterate the SSE wire and yield parsed chunks of type `T`.
 *
 * Terminates cleanly on `data: [DONE]` or when the underlying
 * `ReadableStream` closes. Throws when the wire carries an
 * `event: error` envelope whose `data` is a Hakim error JSON
 * payload.
 */
export async function* parseSseStream<T>(
  body: ReadableStream<Uint8Array>,
  opts: { requestId?: string | undefined } = {},
): AsyncIterable<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffered = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // Flush any tail event the server emitted without the
        // trailing blank line. Spec-lenient.
        if (buffered.trim().length > 0) {
          const tail = parseSseEvent<T>(buffered, opts.requestId);
          if (tail === DONE_SENTINEL) return;
          if (tail !== undefined) yield tail;
        }
        return;
      }
      if (value) buffered += decoder.decode(value, { stream: true });

      // SSE frames are blank-line-delimited (`\n\n`). Slice them
      // out one at a time so the inner parser sees one frame per
      // call.
      let sep = buffered.indexOf('\n\n');
      while (sep !== -1) {
        const frame = buffered.slice(0, sep);
        buffered = buffered.slice(sep + 2);
        const parsed = parseSseEvent<T>(frame, opts.requestId);
        if (parsed === DONE_SENTINEL) return;
        if (parsed !== undefined) yield parsed;
        sep = buffered.indexOf('\n\n');
      }
    }
  } finally {
    // Release the lock so the underlying stream can be GC'd or
    // re-used when the caller bails out (e.g. an `await break`
    // out of the loop or a thrown error).
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

/**
 * Returned in place of a chunk when the frame was the terminal
 * `data: [DONE]` marker — signals the outer loop to stop iterating
 * without yielding `undefined` (which a consumer might mistake for
 * a real value).
 */
const DONE_SENTINEL = Symbol('hakim-sse-done');
type Sentinel = typeof DONE_SENTINEL;

function parseSseEvent<T>(frame: string, requestId: string | undefined): T | Sentinel | undefined {
  let eventType: string | undefined;
  const dataLines: string[] = [];

  for (const rawLine of frame.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.length === 0) continue;
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
      continue;
    }
  }

  if (dataLines.length === 0) return undefined;
  const payload = dataLines.join('\n');
  if (payload === '[DONE]') return DONE_SENTINEL;

  if (eventType === 'error') {
    let body: HakimApiErrorPayload | undefined;
    try {
      const parsed = JSON.parse(payload) as { error?: HakimApiErrorPayload };
      body = parsed.error;
    } catch {
      /* fall through to the unstructured path below */
    }
    if (body) {
      throw errorFromPayload(body, 500, requestId);
    }
    throw new HakimError({
      type: 'service_unavailable',
      code: 'upstream_error',
      message: `Hakim SDK: streaming error envelope was not JSON-parseable (${payload.slice(0, 200)}).`,
      status: 500,
      requestId,
    });
  }

  try {
    return JSON.parse(payload) as T;
  } catch (err) {
    throw new HakimError({
      type: 'api_error',
      code: 'malformed_sse_chunk',
      message: `Hakim SDK: failed to parse SSE chunk JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
      status: 500,
      requestId,
      cause: err,
    });
  }
}
