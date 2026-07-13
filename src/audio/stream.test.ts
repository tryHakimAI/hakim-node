/**
 * Tests for the realtime STT stream helper. We exercise the pure
 * frame-translation + session-update + URL-building internals here
 * (no live WebSocket). A full round-trip against a fake server would
 * need a real `ws` binding which the SDK intentionally doesn't depend
 * on, so that coverage lives in integration tests instead.
 */

import { describe, expect, it } from 'vitest';
import { __internals } from './stream.js';

const { translateFrame, buildSessionUpdate, buildWsUrl, estimateAudioMs } = __internals;

describe('stream.translateFrame', () => {
  it('maps transcription.delta (is_final=false) to a partial event', () => {
    const ev = translateFrame({
      type: 'transcription.delta',
      event_id: 3,
      text: 'hello wor',
      is_final: false,
    });
    expect(ev).toEqual({ type: 'partial', text: 'hello wor', seq: 3 });
  });

  it('maps transcription.delta (is_final=true) to a final event with ms→s conversion', () => {
    const ev = translateFrame({
      type: 'transcription.delta',
      event_id: 4,
      text: 'hello world',
      is_final: true,
      start_ms: 1000,
      end_ms: 2500,
    });
    expect(ev).toEqual({
      type: 'final',
      text: 'hello world',
      seq: 4,
      start: 1,
      end: 2.5,
    });
  });

  it('maps transcription.done to a committed final event', () => {
    const ev = translateFrame({
      type: 'transcription.done',
      event_id: 7,
      text: 'committed snapshot',
      audio_ms: 1200,
      language: 'en',
    });
    expect(ev).toEqual({
      type: 'final',
      text: 'committed snapshot',
      seq: 7,
      language: 'en',
    });
  });

  it('maps a usage frame to a usage event (seconds from audio_ms fallback)', () => {
    const ev = translateFrame({ type: 'usage', audio_ms: 1500 });
    expect(ev).toEqual({ type: 'usage', seconds: 1.5 });
  });

  it('passes through an error frame', () => {
    const ev = translateFrame({
      type: 'error',
      code: 'quota_exceeded',
      message: 'monthly stt quota hit',
    });
    expect(ev).toEqual({
      type: 'error',
      code: 'quota_exceeded',
      message: 'monthly stt quota hit',
    });
  });

  it('suppresses informational session.created frames', () => {
    const ev = translateFrame({ type: 'session.created', event_id: 0 });
    expect(ev).toBeNull();
  });

  it('returns null for unknown frame types', () => {
    expect(translateFrame({ type: 'weird' })).toBeNull();
    expect(translateFrame(null)).toBeNull();
    expect(translateFrame('not an object')).toBeNull();
  });
});

describe('stream.buildSessionUpdate', () => {
  it('returns null when no options are set', () => {
    expect(buildSessionUpdate({})).toBeNull();
  });

  it('maps caller options to the server schema field names', () => {
    const frame = buildSessionUpdate({
      model: 'hakim-arab-v2',
      language: 'ar',
      sample_rate: 24000,
      audio_format: 'pcm16',
    });
    expect(frame).toEqual({
      type: 'session.update',
      session: {
        model: 'hakim-arab-v2',
        language: 'ar',
        input_sample_rate: 24000,
        input_audio_format: 'pcm16',
      },
    });
  });
});

describe('stream.buildWsUrl', () => {
  it('converts https:// to wss:// and appends the stream path', () => {
    expect(buildWsUrl('https://api.tryhakim.ai')).toBe(
      'wss://api.tryhakim.ai/v1/audio/transcriptions/stream',
    );
  });
  it('converts http:// to ws:// for local dev', () => {
    expect(buildWsUrl('http://localhost:8787')).toBe(
      'ws://localhost:8787/v1/audio/transcriptions/stream',
    );
  });
  it('preserves a non-root basePath', () => {
    expect(buildWsUrl('https://api.example.com/prefix')).toBe(
      'wss://api.example.com/prefix/v1/audio/transcriptions/stream',
    );
  });
});

describe('stream.estimateAudioMs', () => {
  it('computes ms from byte length + sample rate for pcm16', () => {
    // 16000 Hz * 2 bytes/sample = 32000 bytes/s → 1600 bytes = 50 ms.
    expect(estimateAudioMs(1600, 16000, 'pcm16')).toBe(50);
    // 24000 Hz * 2 bytes/sample = 48000 bytes/s → 4800 bytes = 100 ms.
    expect(estimateAudioMs(4800, 24000, 'pcm16')).toBe(100);
  });
});
