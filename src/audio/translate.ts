/**
 * `audio.translate` — realtime speech translation (STT → LLM → TTS)
 * over a single WebSocket session (`WSS /v1/audio/translate/stream`).
 *
 * Only entry point is `streamWs()` — the surface is realtime by
 * design. The companion HTTP path is intentionally not exposed: a
 * batch translate flow is recoverable from existing `audio.speech` +
 * `audio.transcriptions` + `chat.completions` chains, while the
 * realtime pipeline relies on the proxy's three-upstream
 * orchestration.
 */

import type { Transport } from '../transport.js';
import type { TranslateStreamHandle, TranslateStreamOptions } from '../types.js';
import { openTranslateStream } from './translate-stream-ws.js';

export class TranslateAPI {
  constructor(private readonly transport: Transport) {}

  /** Open a realtime translate session.
   *
   *  Returns a `TranslateStreamHandle`. The minimum viable session is:
   *
   *      const session = hakim.audio.translate.streamWs({
   *        target_language: 'en',
   *      });
   *      micCapture.on('pcm', (chunk) => session.sendAudio(chunk));
   *      for await (const ev of session.events) {
   *        if (ev.type === 'translation.done') console.log(ev.text);
   *        if (ev.type === 'speech.audio') speaker.write(ev.chunk);
   *      }
   *      await session.close();
   *
   *  The voice for the synthesised target is auto-resolved on the
   *  server from `(target_language, gender)`; supply `voice` to
   *  override. */
  streamWs(opts: TranslateStreamOptions = {}): TranslateStreamHandle {
    return openTranslateStream(this.transport, opts);
  }
}
