/**
 * Tests for the realtime TTS stream helper. We exercise the pure
 * frame-translation + session-update + URL-building internals here
 * (no live WebSocket). A full round-trip against a fake server needs a real `ws` binding,
 * which the SDK intentionally doesn't depend on, so that coverage
 * lives in integration tests instead.
 */
import { describe, expect, it } from 'vitest';
import { __internals } from './speech-stream-ws.js';

const { translateFrame, buildSessionUpdate, buildWsUrl } = __internals;

describe('speech-stream-ws.translateFrame', () => {
  it('maps speech.started to a started event with format defaults', () => {
    const ev = translateFrame({
      type: 'speech.started',
      event_id: 1,
      request_id: 'utt_1',
      characters: 12,
      sample_rate: 24000,
      encoding: 'pcm_s16le',
      channels: 1,
      model: 'hakim-fast-v1',
      voice: 'rashed-ar',
    });
    expect(ev).toEqual({
      type: 'speech.started',
      request_id: 'utt_1',
      characters: 12,
      sample_rate: 24000,
      encoding: 'pcm_s16le',
      channels: 1,
      model: 'hakim-fast-v1',
      voice: 'rashed-ar',
    });
  });

  it('maps speech.done with duration_ms + usage block', () => {
    const ev = translateFrame({
      type: 'speech.done',
      event_id: 2,
      request_id: 'utt_1',
      duration_ms: 1250,
      usage: {
        request_id: 'req_1',
        kind: 'tts',
        units: 12,
        unit_type: 'characters',
        credits: 12,
        cost_usd: '0.00',
        model: 'hakim-fast-v1',
        billing_period_start: '2026-05-01T00:00:00.000Z',
        billing_period_end: '2026-06-01T00:00:00.000Z',
      },
    });
    expect(ev).toMatchObject({ type: 'speech.done', request_id: 'utt_1', duration_ms: 1250 });
  });

  it('maps session.usage with cumulative characters', () => {
    const ev = translateFrame({
      type: 'session.usage',
      event_id: 9,
      session_id: 'wst_abc',
      session_characters: 240,
      usage: {
        request_id: 'req_1',
        kind: 'tts',
        units: 240,
        unit_type: 'characters',
        credits: 240,
        cost_usd: '0.00',
        model: 'hakim-fast-v1',
        billing_period_start: '2026-05-01T00:00:00.000Z',
        billing_period_end: '2026-06-01T00:00:00.000Z',
      },
    });
    expect(ev?.type).toBe('session.usage');
    if (ev?.type === 'session.usage') {
      expect(ev.session_characters).toBe(240);
    }
  });

  it('passes through an error frame with fatal + retryable flags', () => {
    const ev = translateFrame({
      type: 'error',
      event_id: 0,
      code: 'voice_not_found',
      message: 'no such voice',
      retryable: false,
      fatal: false,
      request_id: 'utt_x',
    });
    expect(ev).toEqual({
      type: 'error',
      code: 'voice_not_found',
      message: 'no such voice',
      retryable: false,
      fatal: false,
      request_id: 'utt_x',
    });
  });

  it('suppresses informational session.created frames', () => {
    const ev = translateFrame({ type: 'session.created', event_id: 0 });
    expect(ev).toBeNull();
  });

  it('returns null for unknown / malformed frames', () => {
    expect(translateFrame({ type: 'speech.weird' })).toBeNull();
    expect(translateFrame(null)).toBeNull();
    expect(translateFrame('not an object')).toBeNull();
    expect(translateFrame({ type: 'speech.started' })).toBeNull();
  });
});

describe('speech-stream-ws.buildSessionUpdate', () => {
  it('returns null when no defaults are pinned', () => {
    expect(buildSessionUpdate({})).toBeNull();
  });

  it('maps caller options to the server schema field names', () => {
    const frame = buildSessionUpdate({
      model: 'hakim-fast-v1',
      voice: 'rashed-ar',
      cfg: 3,
      voice_prompt: 'whispering Arabic narrator',
    });
    expect(frame).toEqual({
      type: 'session.update',
      session: {
        model: 'hakim-fast-v1',
        voice: 'rashed-ar',
        cfg: 3,
        voice_prompt: 'whispering Arabic narrator',
      },
    });
  });
});

describe('speech-stream-ws.buildWsUrl', () => {
  it('converts https:// to wss:// and appends the stream path', () => {
    expect(buildWsUrl('https://api.tryhakim.ai')).toBe(
      'wss://api.tryhakim.ai/v1/audio/speech/stream',
    );
  });
  it('converts http:// to ws:// for local dev', () => {
    expect(buildWsUrl('http://localhost:8787')).toBe('ws://localhost:8787/v1/audio/speech/stream');
  });
  it('preserves a non-root basePath', () => {
    expect(buildWsUrl('https://api.example.com/prefix')).toBe(
      'wss://api.example.com/prefix/v1/audio/speech/stream',
    );
  });
});
