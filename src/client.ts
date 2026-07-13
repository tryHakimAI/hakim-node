/**
 * Top-level `Hakim` client. Usage:
 *
 *   const hakim = new Hakim({ apiKey: process.env.HAKIM_API_KEY! });
 *   await hakim.audio.speech.create({ model: 'hakim-fast-v1', … });
 *
 * Configurable knobs (all optional):
 *
 *   - `baseURL`        — override the API host (defaults to prod).
 *                         Also reads HAKIM_BASE_URL env var.
 *   - `timeoutMs`      — per-request timeout. Defaults to 120 s so
 *                         long TTS synthesis doesn't spuriously abort.
 *   - `maxRetries`     — transient-failure retries. Defaults to 2.
 *   - `userAgentSuffix` — appended to the SDK UA (e.g. 'my-app/1.0.0').
 *   - `fetchImpl`      — inject a custom fetch (for tests or edge runtimes).
 */

import { SpeechAPI } from './audio/speech.js';
import { TranscriptionsAPI } from './audio/transcriptions.js';
import { TranslateAPI } from './audio/translate.js';
import { VoicesAPI } from './audio/voices.js';
import { ChatCompletionsAPI } from './chat/completions.js';
import { JobsAPI } from './jobs.js';
import { NotificationsAPI, SettingsAPI } from './settings.js';
import { Transport } from './transport.js';
import { UsageAPI } from './usage.js';
import { WebhooksAPI } from './webhooks.js';

const DEFAULT_BASE_URL = 'https://api.tryhakim.ai';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;

export interface HakimOptions {
  apiKey?: string;
  baseURL?: string;
  timeoutMs?: number;
  maxRetries?: number;
  userAgentSuffix?: string;
  fetchImpl?: typeof fetch;
  /** Internal testing knob: override the random source used for
   *  backoff jitter. Don't use in application code. */
  random?: () => number;
  /** Internal testing knob: override sleep between retries. */
  sleep?: (ms: number) => Promise<void>;
  /** Internal testing knob: override idempotency key generation. */
  generateIdempotencyKey?: () => string;
}

export class Hakim {
  readonly audio: {
    speech: SpeechAPI;
    transcriptions: TranscriptionsAPI;
    translate: TranslateAPI;
    voices: VoicesAPI;
  };
  readonly voices: VoicesAPI;
  readonly chat: {
    completions: ChatCompletionsAPI;
  };
  readonly usage: UsageAPI;
  readonly webhooks: WebhooksAPI;
  readonly jobs: JobsAPI;
  readonly settings: SettingsAPI;
  readonly notifications: NotificationsAPI;

  /** Expose the transport for advanced callers (custom endpoints,
   *  debugging). Stability of this interface is NOT guaranteed. */
  readonly _transport: Transport;

  constructor(options: HakimOptions = {}) {
    const env = typeof process !== 'undefined' ? (process.env ?? {}) : {};

    const apiKey = options.apiKey ?? env.HAKIM_API_KEY ?? env.HAKIM_API_TOKEN;
    if (!apiKey) {
      throw new TypeError(
        'Hakim SDK: missing API key. Pass `apiKey` to new Hakim({...}) or set the HAKIM_API_KEY env var.',
      );
    }

    const baseURL = options.baseURL ?? env.HAKIM_BASE_URL ?? DEFAULT_BASE_URL;

    this._transport = new Transport({
      apiKey,
      baseURL,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      userAgentSuffix: options.userAgentSuffix,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.random !== undefined ? { random: options.random } : {}),
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
      ...(options.generateIdempotencyKey !== undefined
        ? { generateIdempotencyKey: options.generateIdempotencyKey }
        : {}),
    });

    const voicesApi = new VoicesAPI(this._transport);
    this.audio = {
      speech: new SpeechAPI(this._transport),
      transcriptions: new TranscriptionsAPI(this._transport),
      translate: new TranslateAPI(this._transport),
      voices: voicesApi,
    };
    this.voices = voicesApi;
    this.chat = {
      completions: new ChatCompletionsAPI(this._transport),
    };
    this.usage = new UsageAPI(this._transport);
    this.webhooks = new WebhooksAPI(this._transport);
    this.jobs = new JobsAPI(this._transport);
    this.settings = new SettingsAPI(this._transport);
    this.notifications = new NotificationsAPI(this._transport);
  }
}
