/**
 * Tests for `audio.transcriptions.create`.
 *   - Multipart body carries the file + scalar form fields.
 *   - Sync 200 JSON → `sync_json` variant.
 *   - Sync 200 plain text → `sync_text` variant.
 *   - Sync 200 SRT → `sync_srt` variant.
 *   - 202 → `async_accepted` variant.
 *   - Accepts Buffer / Uint8Array / ArrayBuffer / Readable stream.
 *   - Rejects unsupported input types.
 */

import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Hakim } from '../client.js';

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function textResponse(status: number, body: string, contentType: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': contentType },
  });
}

describe('audio.transcriptions.create — multipart body', () => {
  it('sends file + form fields via multipart/form-data', async () => {
    let capturedForm: FormData | undefined;
    const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      capturedForm = init?.body as FormData;
      return jsonResponse(200, { text: 'مرحبا', language: 'ar' });
    }) as typeof fetch;

    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const result = await hakim.audio.transcriptions.create({
      file: new Uint8Array([0x52, 0x49, 0x46, 0x46]),
      model: 'hakim-arab-v2',
      language: 'ar',
      response_format: 'json',
      timestamps: 'segment',
      diarize: true,
      filename: 'clip.wav',
    });

    expect(result.kind).toBe('sync_json');
    if (result.kind !== 'sync_json') throw new Error('unreachable');
    expect(result.data.text).toBe('مرحبا');
    expect(capturedForm).toBeInstanceOf(FormData);
    expect(capturedForm!.get('model')).toBe('hakim-arab-v2');
    expect(capturedForm!.get('language')).toBe('ar');
    expect(capturedForm!.get('response_format')).toBe('json');
    expect(capturedForm!.get('timestamps')).toBe('segment');
    expect(capturedForm!.get('diarize')).toBe('true');
    const file = capturedForm!.get('file');
    expect(file).toBeInstanceOf(Blob);
  });

  it('defaults filename to audio.bin when omitted', async () => {
    let capturedForm: FormData | undefined;
    const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      capturedForm = init?.body as FormData;
      return jsonResponse(200, { text: 'x' });
    }) as typeof fetch;
    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    await hakim.audio.transcriptions.create({ file: new Uint8Array([1, 2, 3]) });
    const file = capturedForm!.get('file') as File;
    expect(file.name).toBe('audio.bin');
  });

  it('accepts ArrayBuffer input', async () => {
    const f = (async () => jsonResponse(200, { text: 'ok' })) as typeof fetch;
    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const buf = new ArrayBuffer(8);
    const res = await hakim.audio.transcriptions.create({ file: buf });
    expect(res.kind).toBe('sync_json');
  });

  it('accepts Node Readable stream input (collects chunks first)', async () => {
    const f = (async () => jsonResponse(200, { text: 'ok' })) as typeof fetch;
    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const stream = Readable.from([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
    const res = await hakim.audio.transcriptions.create({ file: stream });
    expect(res.kind).toBe('sync_json');
  });

  it('rejects unsupported input with an invalid_request_error', async () => {
    const f = (async () => jsonResponse(200, {})) as typeof fetch;
    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    await expect(
      hakim.audio.transcriptions.create({ file: 42 as unknown as Uint8Array }),
    ).rejects.toThrow(/unsupported file input/);
  });
});

describe('audio.transcriptions.create — response variants', () => {
  it('sync JSON → kind: sync_json', async () => {
    const f = (async () => jsonResponse(200, { text: 'hi', language: 'en' })) as typeof fetch;
    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const r = await hakim.audio.transcriptions.create({ file: new Uint8Array([1]) });
    expect(r.kind).toBe('sync_json');
    if (r.kind === 'sync_json') expect(r.data.text).toBe('hi');
  });

  it('sync plain text → kind: sync_text', async () => {
    const f = (async () => textResponse(200, 'مرحبا', 'text/plain')) as typeof fetch;
    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const r = await hakim.audio.transcriptions.create({
      file: new Uint8Array([1]),
      response_format: 'text',
    });
    expect(r.kind).toBe('sync_text');
    if (r.kind === 'sync_text') expect(r.text).toBe('مرحبا');
  });

  it('sync SRT subtitles → kind: sync_srt', async () => {
    const body =
      '1\n00:00:00,000 --> 00:00:01,000\nHello\n\n2\n00:00:01,000 --> 00:00:02,000\nWorld\n';
    const f = (async () => textResponse(200, body, 'application/x-subrip')) as typeof fetch;
    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const r = await hakim.audio.transcriptions.create({
      file: new Uint8Array([1]),
      response_format: 'srt',
    });
    expect(r.kind).toBe('sync_srt');
    if (r.kind === 'sync_srt') expect(r.text).toContain('-->');
  });

  it('202 → kind: async_accepted', async () => {
    const body = {
      id: 'job_abc',
      status: 'queued',
      type: 'stt_batch',
      reason: 'size_gt_25mb',
      poll_url: '/v1/jobs/job_abc',
    };
    const f = (async () => jsonResponse(202, body)) as typeof fetch;
    const hakim = new Hakim({ apiKey: 'hk_test_x', fetchImpl: f });
    const r = await hakim.audio.transcriptions.create({ file: new Uint8Array([1]) });
    expect(r.kind).toBe('async_accepted');
    if (r.kind === 'async_accepted') {
      expect(r.data.id).toBe('job_abc');
      expect(r.data.reason).toBe('size_gt_25mb');
    }
  });
});
