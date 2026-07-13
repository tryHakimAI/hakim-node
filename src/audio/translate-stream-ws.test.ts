/**
 * Tests for the realtime translate stream helper. Mirrors the
 * pattern of `speech-stream-ws.test.ts` + `stream.test.ts` — pure
 * frame-translation + session-update + URL-building internals. A full round-trip against a fake server needs a real `ws` binding,
 * which the SDK intentionally doesn't depend on, so that coverage
 * lives in integration tests instead.
 */
import { describe, expect, it } from 'vitest';
import { __internals } from './translate-stream-ws.js';

const { translateFrame, buildSessionUpdate, buildWsUrl, estimateAudioMs } = __internals;

describe('translate-stream-ws.translateFrame', () => {
  it('maps session.created to a created event with voice + model trio', () => {
    const ev = translateFrame({
      type: 'session.created',
      event_id: 0,
      session_id: 'wst_01',
      session: { target_language: 'en' },
      voice_id: 'voice_db_1',
      voice_slug: 'layla-en',
      model_stt: 'hakim-arab-v2',
      model_llm: 'hakim-chat-v1',
      model_tts: 'hakim-fast-v1',
      limits: {},
      usage_snapshot: {},
    });
    expect(ev).toEqual({
      type: 'session.created',
      session_id: 'wst_01',
      voice_id: 'voice_db_1',
      voice_slug: 'layla-en',
      model_stt: 'hakim-arab-v2',
      model_llm: 'hakim-chat-v1',
      model_tts: 'hakim-fast-v1',
    });
  });

  it('maps transcription.delta with is_final flag', () => {
    expect(
      translateFrame({
        type: 'transcription.delta',
        event_id: 1,
        utterance_id: 'utt_1',
        text: 'مرحبا',
        is_final: false,
      }),
    ).toEqual({
      type: 'transcription.delta',
      utterance_id: 'utt_1',
      text: 'مرحبا',
      is_final: false,
    });
  });

  it('maps transcription.done carrying optional language', () => {
    const ev = translateFrame({
      type: 'transcription.done',
      event_id: 2,
      utterance_id: 'utt_1',
      text: 'مرحبا بالعالم',
      language: 'ar',
      audio_ms: 1240,
      usage: { kind: 'stt_realtime', units: 1 },
    });
    expect(ev).toMatchObject({
      type: 'transcription.done',
      utterance_id: 'utt_1',
      text: 'مرحبا بالعالم',
      language: 'ar',
      audio_ms: 1240,
    });
  });

  it('maps translation.delta', () => {
    expect(
      translateFrame({
        type: 'translation.delta',
        event_id: 3,
        utterance_id: 'utt_1',
        text: 'Hello',
      }),
    ).toEqual({
      type: 'translation.delta',
      utterance_id: 'utt_1',
      text: 'Hello',
    });
  });

  it('maps translation.done with usage', () => {
    const ev = translateFrame({
      type: 'translation.done',
      event_id: 4,
      utterance_id: 'utt_1',
      text: 'Hello, world.',
      usage: { kind: 'llm_chat', units: 24 },
    });
    expect(ev).toMatchObject({
      type: 'translation.done',
      utterance_id: 'utt_1',
      text: 'Hello, world.',
    });
  });

  it('maps speech.started with format defaults', () => {
    expect(
      translateFrame({
        type: 'speech.started',
        event_id: 5,
        utterance_id: 'utt_1',
        characters: 13,
        sample_rate: 24000,
        encoding: 'pcm_s16le',
        channels: 1,
        voice_id: 'voice_db_1',
      }),
    ).toEqual({
      type: 'speech.started',
      utterance_id: 'utt_1',
      characters: 13,
      sample_rate: 24000,
      encoding: 'pcm_s16le',
      channels: 1,
      voice_id: 'voice_db_1',
    });
  });

  it('maps speech.done with duration_ms', () => {
    const ev = translateFrame({
      type: 'speech.done',
      event_id: 6,
      utterance_id: 'utt_1',
      duration_ms: 980,
      usage: { kind: 'tts', units: 13 },
    });
    expect(ev).toMatchObject({
      type: 'speech.done',
      utterance_id: 'utt_1',
      duration_ms: 980,
    });
  });

  it('maps session.usage to a cross-modality rollup', () => {
    const ev = translateFrame({
      type: 'session.usage',
      event_id: 7,
      session_id: 'wst_01',
      totals: {
        stt_audio_ms: 12400,
        llm_tokens: 248,
        tts_characters: 130,
        credits: 165,
        cost_usd: '0.0330',
      },
    });
    expect(ev).toEqual({
      type: 'session.usage',
      session_id: 'wst_01',
      totals: {
        stt_audio_ms: 12400,
        llm_tokens: 248,
        tts_characters: 130,
        credits: 165,
        cost_usd: '0.0330',
      },
    });
  });

  it('passes through an error frame with fatal + retryable flags', () => {
    const ev = translateFrame({
      type: 'error',
      event_id: 8,
      code: 'voice_not_found',
      message: 'no such voice',
      retryable: false,
      fatal: true,
      utterance_id: 'utt_1',
    });
    expect(ev).toEqual({
      type: 'error',
      code: 'voice_not_found',
      message: 'no such voice',
      retryable: false,
      fatal: true,
      utterance_id: 'utt_1',
    });
  });

  it('returns null for unknown / malformed frames', () => {
    expect(translateFrame({ type: 'translation.weird' })).toBeNull();
    expect(translateFrame(null)).toBeNull();
    expect(translateFrame('not an object')).toBeNull();
    expect(translateFrame({ type: 'transcription.delta' })).toBeNull();
  });
});

describe('translate-stream-ws.buildSessionUpdate', () => {
  it('returns null when no fields are pinned', () => {
    expect(buildSessionUpdate({})).toBeNull();
  });

  it('maps caller options to the server schema field names', () => {
    const frame = buildSessionUpdate({
      target_language: 'en',
      source_language: 'ar',
      voice: 'voice_db_1',
      gender: 'female',
      model_stt: 'hakim-arab-v2',
      model_llm: 'hakim-chat-v1',
      model_tts: 'hakim-fast-v1',
      cfg: 2.5,
      input_audio_format: 'pcm16',
      input_sample_rate: 24000,
      partials: false,
      system_prompt: 'translate to English',
    });
    expect(frame).toEqual({
      type: 'session.update',
      session: {
        target_language: 'en',
        source_language: 'ar',
        voice: 'voice_db_1',
        gender: 'female',
        model_stt: 'hakim-arab-v2',
        model_llm: 'hakim-chat-v1',
        model_tts: 'hakim-fast-v1',
        cfg: 2.5,
        input_audio_format: 'pcm16',
        input_sample_rate: 24000,
        partials: false,
        system_prompt: 'translate to English',
      },
    });
  });
});

describe('translate-stream-ws.buildWsUrl', () => {
  it('converts https:// to wss:// and appends the stream path', () => {
    expect(buildWsUrl('https://api.tryhakim.ai')).toBe(
      'wss://api.tryhakim.ai/v1/audio/translate/stream',
    );
  });
  it('converts http:// to ws:// for local dev', () => {
    expect(buildWsUrl('http://localhost:8787')).toBe(
      'ws://localhost:8787/v1/audio/translate/stream',
    );
  });
  it('preserves a non-root basePath', () => {
    expect(buildWsUrl('https://api.example.com/prefix')).toBe(
      'wss://api.example.com/prefix/v1/audio/translate/stream',
    );
  });
});

describe('translate-stream-ws.estimateAudioMs', () => {
  it('estimates ms for pcm16 at common sample rates', () => {
    expect(estimateAudioMs(32000, 16000, 'pcm16')).toBe(1000);
    expect(estimateAudioMs(96000, 24000, 'pcm16')).toBe(2000);
  });
  it('returns undefined for non-pcm formats so the server can derive from byte length', () => {
    expect(estimateAudioMs(1000, 16000, 'opus')).toBeUndefined();
    expect(estimateAudioMs(1000, 16000, 'mulaw')).toBeUndefined();
  });
});
