/**
 * `audio.transcriptions` — POST /v1/audio/transcriptions.
 *
 * The server accepts **multipart/form-data** with a `file` field plus
 * form-scalar parameters. We accept a broad set of audio input types
 * and normalize them to something `FormData` can hold (a `Blob`):
 *
 *   - `Blob` / `File` — passed through.
 *   - `ArrayBuffer` / `ArrayBufferView` / `Uint8Array` / `Buffer` — wrapped
 *     in a `Blob` (which, on Node 18+, is provided by `buffer.Blob`).
 *   - `NodeJS.ReadableStream` — collected into a `Buffer` first (PRD
 *     §9: streaming STT upload is nice-to-have; sync API is buffered).
 *
 * The sync path (≤25 MiB AND ≤10 min) returns a typed `TranscriptionResult`
 * variant keyed by `response_format`. The server may also return 202
 * with an async acceptance body — we surface that as `kind: 'async_accepted'`.
 */

import type { Transport } from '../transport.js';
import type {
  AudioInput,
  TranscriptionAsyncAccepted,
  TranscriptionJsonResponse,
  TranscriptionRequest,
  TranscriptionResult,
  TranscriptionStreamHandle,
  TranscriptionStreamOptions,
} from '../types.js';
import { DEFAULT_STT_MODEL } from '../types.js';
import { audioInputToBlob } from './to-blob.js';
import { openTranscriptionStream } from './stream.js';

export class TranscriptionsAPI {
  constructor(private readonly transport: Transport) {}

  async create(
    request: TranscriptionRequest,
    opts: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<TranscriptionResult> {
    const responseFormat = request.response_format ?? 'json';
    const acceptByFormat: Record<string, string> = {
      json: 'application/json',
      verbose_json: 'application/json',
      text: 'text/plain, application/json;q=0.9',
      srt: 'application/x-subrip, text/plain;q=0.9, application/json;q=0.8',
      vtt: 'text/vtt, text/plain;q=0.9, application/json;q=0.8',
    };
    const accept = acceptByFormat[responseFormat] ?? 'application/json';

    // URL source → JSON body; the server fetches the audio. Otherwise
    // upload the bytes as multipart/form-data.
    const usesUrl = 'url' in request && typeof request.url === 'string';

    const res = await this.transport.request({
      method: 'POST',
      path: '/v1/audio/transcriptions',
      accept,
      headers: { accept },
      ...(usesUrl
        ? { json: this.buildUrlBody(request, responseFormat) }
        : { formData: await this.buildUploadForm(request, responseFormat) }),
      ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });

    if (res.status === 202) {
      const data = (await res.json()) as TranscriptionAsyncAccepted;
      return { kind: 'async_accepted', data };
    }

    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();

    if (contentType.includes('application/json')) {
      const data = (await res.json()) as TranscriptionJsonResponse;
      return { kind: 'sync_json', data };
    }

    const text = await res.text();
    if (responseFormat === 'srt' || contentType.includes('subrip')) {
      return { kind: 'sync_srt', text };
    }
    if (responseFormat === 'vtt' || contentType.includes('vtt')) {
      return { kind: 'sync_vtt', text };
    }

    return { kind: 'sync_text', text };
  }

  private async buildUploadForm(
    request: TranscriptionRequest,
    responseFormat: string,
  ): Promise<FormData> {
    const filename = request.filename ?? 'audio.bin';
    const blob = await audioInputToBlob((request as { file: AudioInput }).file, filename);
    const form = new FormData();
    form.append('file', blob, filename);
    form.append('model', request.model ?? DEFAULT_STT_MODEL);
    if (request.language !== undefined) form.append('language', request.language);
    form.append('response_format', responseFormat);
    if (request.timestamps !== undefined) form.append('timestamps', request.timestamps);
    if (request.diarize !== undefined) form.append('diarize', String(request.diarize));
    return form;
  }

  private buildUrlBody(
    request: TranscriptionRequest,
    responseFormat: string,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      url: (request as { url: string }).url,
      model: request.model ?? DEFAULT_STT_MODEL,
      response_format: responseFormat,
    };
    if (request.language !== undefined) body.language = request.language;
    if (request.timestamps !== undefined) body.timestamps = request.timestamps;
    if (request.diarize !== undefined) body.diarize = request.diarize;
    return body;
  }

  /** Realtime STT over a WebSocket (`/v1/audio/transcriptions/stream`).
   *  Returns a handle the caller writes audio chunks into and iterates
   *  for `partial` / `final` / `usage` events. See
   *  `TranscriptionStreamHandle` for lifecycle. */
  stream(opts: TranscriptionStreamOptions = {}): TranscriptionStreamHandle {
    return openTranscriptionStream(this.transport, opts);
  }
}
