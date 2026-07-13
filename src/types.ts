/**
 * Public request/response shapes for the SDK.
 *
 * The types here are hand-kept in lockstep with the Hakim API's
 * request/response contract.
 */

/**
 * Public TTS model identifiers.
 *
 * The released tier is:
 *
 *   - `'hakim-fast-v1'` — sub-120 ms streaming. Recommended for
 *     new code that needs the lowest latency.
 *
 * The remaining tiers are kept on this union because the SDK
 * ships one binary for every environment; submitting them to a
 * production API returns `422 model_unavailable` until the org-
 * wide launch flag flips:
 *
 *   - `'hakim-v2'` · **`@experimental`** — premium quality with
 *     non-verbal tag support. Private preview only today.
 *   - `'hakim-v3'` · **`@experimental`** — premium quality plus
 *     voice generation via `voice_prompt`. Private preview only
 *     today.
 *
 * Plus one legacy alias still accepted by the API:
 *
 *   - `'hakim-flash-v1'` — pre-launch codename, normalised to
 *     `'hakim-fast-v1'` in metrics, audit logs, and the `model`
 *     field of any response surface that echoes it back.
 *
 * SDKs default to {@link DEFAULT_TTS_MODEL} for new requests. See
 * the `audio.ts` + `tts-models.ts` docblocks in `@hakim/schemas`
 * for the tier-ladder rationale.
 *
 * @experimental Members `'hakim-v2'` and `'hakim-v3'` are not
 *   generally available — see private-preview note above.
 */
export type TTSModel = 'hakim-fast-v1' | 'hakim-v2' | 'hakim-v3' | 'hakim-flash-v1';

/** Recommended default for new code. */
export const DEFAULT_TTS_MODEL: TTSModel = 'hakim-fast-v1';

export type ResponseFormat = 'mp3' | 'wav' | 'pcm' | 'opus';
export type SampleRate = 8000 | 16000 | 22050 | 24000 | 44100 | 48000;

export interface SpeechRequest {
  model: TTSModel;
  input: string;
  voice: string;
  response_format?: ResponseFormat;
  sample_rate?: SampleRate;
  speed?: number;
  stream?: boolean;
  cfg?: number;
  /**
   * Optional free-form description of a voice. Honoured by
   * tiers that advertise the `voice_prompt` capability (today
   * the `hakim-v3` private preview). On released tiers the
   * field is silently dropped and the response carries a
   * `voice_prompt_dropped_by_model_capability` entry in the
   * `x-hakim-warnings` header.
   *
   * @experimental
   */
  voice_prompt?: string;
}

/**
 * Public STT model identifier.
 *
 * `'hakim-arab-v2'` is the only accepted id — the Arabic-first
 * acoustic profile that backs every transcription path (batch
 * `POST /v1/audio/transcriptions` and realtime
 * `WSS /v1/audio/transcriptions/stream`).
 *
 * SDKs default to {@link DEFAULT_STT_MODEL}.
 */
export type STTModel = 'hakim-arab-v2';

/** The STT model used for every request. */
export const DEFAULT_STT_MODEL: STTModel = 'hakim-arab-v2';

export type STTResponseFormat = 'json' | 'text' | 'srt' | 'vtt' | 'verbose_json';
export type STTTimestamps = 'word' | 'segment' | 'none';

/**
 * Arabic dialect BCP-47 codes the server accepts. Kept in lockstep with
 * `ArabicDialectCode` in `@hakim/schemas/languages.ts` — if you add a
 * dialect there, mirror it here and update the drift test manifest.
 *
 * Phase 4 (voice catalogue v2) widened this list from 7 to 12 codes so
 * cloned voices can pin to a per-country dialect (`ar-EG`, `ar-LB`, …)
 * rather than collapsing everything to MSA.
 */
export type ArabicDialectCode =
  | 'ar-SA'
  | 'ar-AE'
  | 'ar-EG'
  | 'ar-SY'
  | 'ar-LB'
  | 'ar-JO'
  | 'ar-PS'
  | 'ar-MA'
  | 'ar-DZ'
  | 'ar-IQ'
  | 'ar-SD'
  | 'ar-YE';

/**
 * ISO 639-1 base language codes the server accepts. `auto` is NOT in
 * this union on purpose — it's an STT-only sentinel, exposed via
 * {@link STTLanguage}. Cloned voices must pin to a real language.
 */
export type BaseLanguageCode =
  | 'ar'
  | 'en'
  | 'fr'
  | 'es'
  | 'de'
  | 'it'
  | 'pt'
  | 'tr'
  | 'ur'
  | 'hi'
  | 'fa'
  | 'he'
  | 'nl'
  | 'ru'
  | 'pl'
  | 'uk'
  | 'ja'
  | 'ko'
  | 'zh'
  | 'th'
  | 'vi'
  | 'id'
  | 'ms'
  | 'sw'
  | 'am'
  | 'bn'
  | 'ta'
  | 'el'
  | 'ps'
  | 'ku'
  | 'cs'
  | 'ro'
  | 'hu'
  | 'fi'
  | 'sv'
  | 'no'
  | 'da'
  | 'my'
  | 'km'
  | 'lo'
  | 'tl';

/**
 * Language hint for STT: a base ISO code, an Arabic dialect, or `auto`
 * to let the server detect. Matches `STTLanguage` in `@hakim/schemas`.
 */
export type STTLanguage = 'auto' | BaseLanguageCode | ArabicDialectCode;

/**
 * Audio input for STT. Accepts a Node stream, a Buffer, a TypedArray,
 * a File/Blob-like object, or a string (treated as a file path only
 * when `filename` is NOT provided — otherwise the string is the raw
 * body and `filename` is the label we attach to the multipart part).
 */
export type AudioInput =
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | Uint8Array
  | Buffer
  | NodeJS.ReadableStream;

export interface TranscriptionRequestCommon {
  model?: STTModel;
  language?: STTLanguage;
  response_format?: STTResponseFormat;
  timestamps?: STTTimestamps;
  diarize?: boolean;
  /** Explicit filename for the multipart part. If missing, the SDK uses
   *  `audio.bin` — the upstream ffprobe step sniffs the real format. */
  filename?: string;
}

/**
 * Either upload audio bytes (`file`) or point at a publicly fetchable
 * URL (`url`, e.g. an S3/GCS/Azure presigned link) and let the server
 * fetch it — handy for buckets full of recordings. Exactly one is
 * required; they're mutually exclusive.
 */
export type TranscriptionRequest = TranscriptionRequestCommon &
  ({ file: AudioInput; url?: never } | { url: string; file?: never });

/** Parsed JSON response when `response_format: 'json'`. */
export interface TranscriptionJsonResponse {
  text: string;
  language?: string;
  duration?: number;
  /**
   * Enterprise usage observability · OpenAI-shaped `usage` block
   * mirroring `UsageBlockSchema` in `@hakim/schemas`. Server emits
   * this whenever the call resolved an API-key context (live keys);
   * test keys (`hk_test_…`) keep the legacy shape without `usage`.
   */
  usage?: UsageBlock;
}

/** 202 async acceptance body when the upload exceeds sync limits. */
export interface TranscriptionAsyncAccepted {
  id: string;
  status: 'queued';
  type: 'stt_batch';
  reason: 'size_gt_25mb' | 'duration_gt_10min';
  limits?: {
    max_sync_size_bytes?: number;
    max_sync_duration_seconds?: number;
  };
  poll_url: string;
}

export type TranscriptionResult =
  | { kind: 'sync_json'; data: TranscriptionJsonResponse }
  | { kind: 'sync_text'; text: string }
  | { kind: 'sync_srt'; text: string }
  | { kind: 'sync_vtt'; text: string }
  | { kind: 'async_accepted'; data: TranscriptionAsyncAccepted };

export type VoiceKind = 'preset' | 'cloned';

/**
 * Language a voice is pinned to. Phase 4 (voice catalogue v2) widened
 * this union from `'ar' | 'en' | 'multi'` to the full STT-aligned set —
 * 37 base codes plus 12 Arabic dialects — so cloned voices can surface
 * country-specific Arabic and any language the model supports.
 *
 * `multi` is retained as a deprecated alias for legacy presets and old
 * SDK callers; new voices should pick a concrete base code instead.
 *
 * Kept in lockstep with `VoiceLanguage` in `@hakim/schemas/languages.ts`.
 */
export type VoiceLanguage = BaseLanguageCode | ArabicDialectCode | 'multi';

export type VoiceGender = 'male' | 'female' | 'neutral';
export type VoiceStatus = 'processing' | 'ready' | 'failed';

/**
 * Voice use-case / tone. Phase 4 (voice catalogue v2) introduced this
 * column so a single speaker identity can have distinct takes per
 * intent (a warm narrator vs. the same speaker reading the news).
 *
 * Kept in lockstep with `VoiceType` in `@hakim/schemas/languages.ts`.
 */
export type VoiceType =
  | 'conversational'
  | 'narrative'
  | 'news'
  | 'social_media'
  | 'advertising'
  | 'elearning'
  | 'character'
  | 'customer_service';

export interface Voice {
  id: string;
  slug: string;
  name: string;
  kind: VoiceKind;
  language: VoiceLanguage;
  /** Voice use-case / tone. Defaults server-side to `conversational`
   *  for presets and for clones that omit the field. */
  voice_type: VoiceType;
  gender: VoiceGender;
  description: string | null;
  preview_url: string | null;
  status: VoiceStatus;
  created_at?: string;
}

export interface VoicesListQuery {
  language?: VoiceLanguage;
  gender?: VoiceGender;
  kind?: VoiceKind;
  /** Filter by voice use-case / tone (Phase 4). */
  voice_type?: VoiceType;
}

export interface VoicesListResponse {
  object: 'list';
  data: Voice[];
}

export type UsageKind =
  | 'tts'
  | 'stt_batch'
  | 'stt_realtime'
  | 'voice_clone'
  | 'video_studio'
  // Chat completions usage. Token-denominated; the
  // `units` integer is `inputTokens + outputTokens` and the split
  // lives in `metadata.input_tokens` / `metadata.output_tokens` on
  // the underlying `UsageEvent` row.
  | 'llm_chat';

// ---------------------------------------------------------------------------
// Chat completions.
//
// OpenAI-shape on the wire so an `openai-node` user can swap the
// base URL + API key and keep their app code. Types mirror the Zod
// source of truth for the API's chat contract.
// ---------------------------------------------------------------------------

/** Public chat model id. v1 ships a single canonical id; the
 *  marketing alias `hkm-llm-1` is also accepted at the route. */
export type ChatModel = 'hakim-chat-v1' | 'hkm-llm-1';

/** Roles accepted on a message. `tool` is reserved for the future
 *  function-calling rollout — v1 rejects tool messages at the
 *  route boundary. */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** Text content part. Mirrors OpenAI's `type: 'text'` part so
 *  callers who already serialise structured content keep the same
 *  shape when vision lands in P7. */
export interface ChatTextContentPart {
  type: 'text';
  text: string;
}

/** A message's content is either a flat string (OpenAI shorthand)
 *  or an array of structured parts. v1 only ships text parts. */
export type ChatMessageContent = string | ChatTextContentPart[];

export interface ChatMessage {
  role: ChatRole;
  content: ChatMessageContent;
  /** OpenAI's optional speaker name. Capped server-side at 64 chars. */
  name?: string;
  /** Function-calling attachments — reserved for P7. Schema accepts
   *  them so callers hand-rolling tool calls don't 400 today; the
   *  route strips them before upstream dispatch. */
  tool_call_id?: string;
  tool_calls?: unknown[];
  /** Chain-of-thought trace from a reasoning-capable model.
   *  Surfaced only on assistant turns and only when the caller
   *  opted in via `reasoning: { enabled: true }` on the request.
   *  Field name matches OpenRouter / OpenAI gpt-oss cookbook
   *  conventions so existing SDK readers Just Work. */
  reasoning?: string;
}

/** Reasoning / chain-of-thought control. Defaults to OFF on every
 *  upstream call · thinking adds 10–50× latency for short prompts.
 *  Set `enabled: true` on a non-stream request to opt into
 *  receiving `message.reasoning` alongside `message.content`.
 *  Streaming requests with `reasoning.enabled = true` are rejected
 *  at the route's schema layer with a 400 — real-time agents
 *  cannot afford the latency cost. */
export interface ChatReasoningOption {
  enabled: boolean;
}

export interface ChatCompletionRequest {
  model: ChatModel | string;
  messages: ChatMessage[];
  /** Default `false`. `true` switches the response to SSE. */
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  /** v1 is locked to `1`. Schema accepts the field; rejects `> 1`. */
  n?: 1;
  stop?: string | string[];
  user?: string;
  presence_penalty?: number;
  frequency_penalty?: number;
  seed?: number;
  /** P7 placeholder. Schema accepts the field; the route strips it
   *  before upstream dispatch. */
  tools?: unknown[];
  tool_choice?: unknown;
  /** Reasoning / chain-of-thought control. Stream + `enabled:true`
   *  combo is rejected with a 400. */
  reasoning?: ChatReasoningOption;
}

/** Finish reasons forwarded verbatim from the upstream. */
export type ChatFinishReason =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'tool_calls'
  | 'function_call';

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: ChatFinishReason | null;
}

export interface ChatCompletionResponse {
  /** Public completion id (`chatcmpl-<rand24>`). Hakim-minted; the
   *  upstream id is never echoed. */
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: ChatCompletionUsage;
  /** Hakim-specific per-request usage block. Same data as the
   *  `x-hakim-usage-*` headers; embedded in the body so loggers
   *  that strip headers don't lose it. */
  hakim_usage?: UsageBlock;
}

/** Streaming `delta` — partial assistant message. Each chunk
 *  carries the role (first chunk), a content fragment, or — for
 *  reasoning-capable models when the caller opted in — a
 *  `reasoning` fragment as a sibling. v1's route rejects the
 *  stream-with-reasoning combo, so `delta.reasoning` is never
 *  populated on the public wire today; the field is kept on the
 *  shape for future non-real-time surfaces. */
export interface ChatCompletionChunkDelta {
  role?: ChatRole;
  content?: string;
  reasoning?: string;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkDelta;
  finish_reason: ChatFinishReason | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  /** Only the final chunk carries `usage` — Together emits it
   *  once per stream when configured for OpenAI compatibility,
   *  and we forward the same shape. */
  usage?: ChatCompletionUsage;
}

// ---------------------------------------------------------------------------
// Enterprise usage observability — mirrors `@hakim/schemas/observability.ts`.
// The Zod source of truth lives there; the drift test in `openapi-drift.test.ts`
// pins each interface below to its Zod sibling so additive fields fail loudly
// before they ship.
// ---------------------------------------------------------------------------

/** Decimal-string USD amount (2–6 fractional digits). See
 *  `UsdAmountSchema` in `@hakim/schemas` for the rationale (financial
 *  pipelines treat it as `DECIMAL(10,4)` cleanly). */
export type UsdAmount = string;

/** Unit denomination of a single request — what the integer in
 *  `UsageBlock.units` measures. `'tokens'` covers chat
 *  completions; the input/output split lives in the underlying
 *  `UsageEvent.metadata`. */
export type UsageUnitType = 'characters' | 'seconds' | 'count' | 'credits' | 'tokens';

/** Overage mode for the org's plan. `topup` is the current default. */
export type OverageMode = 'topup' | 'postpaid' | 'hard_stop';

/** OpenAI-shaped per-request usage block. Surfaced on STT JSON bodies,
 *  WebSocket frames, and via the `x-hakim-usage-*` response headers. */
export interface UsageBlock {
  request_id: string;
  kind: 'tts' | 'stt_batch' | 'stt_realtime' | 'voice_clone' | 'video_studio' | 'llm_chat';
  units: number;
  unit_type: UsageUnitType;
  credits: number;
  cost_usd: UsdAmount;
  model: string | null;
  billing_period_start: string;
  billing_period_end: string;
}

export interface CreditsSnapshot {
  included: number;
  used: number;
  remaining: number;
  effective_limit: number;
}

export interface ConcurrencySnapshot {
  limit: number;
  current: number;
}

export interface RateLimitSnapshot {
  limit_per_minute: number;
  remaining: number;
  reset_at: string;
}

export interface PlanSnapshot {
  id: string;
  name: string;
  overage_mode: OverageMode;
}

export interface PeriodSnapshot {
  start: string;
  end: string;
}

/** Full point-in-time limits envelope returned by `GET /v1/limits` and
 *  carried inside the realtime `session.created` WS frame. */
export interface LimitsSnapshot {
  generated_at: string;
  organization_id: string;
  plan: PlanSnapshot;
  period: PeriodSnapshot;
  credits: CreditsSnapshot;
  concurrency: ConcurrencySnapshot;
  rate_limit: RateLimitSnapshot;
}

export interface UsageSummary {
  period: { start: string; end: string };
  tts: { characters: number; included: number; overage_chars: number };
  stt: { seconds: number; included: number; overage_seconds: number };
  estimated_overage_usd: number;
  /** Canonical credits dimension. */
  credits: CreditsSnapshot;
  /** Plan + overage-mode hint so a single call paints a dashboard card. */
  plan: PlanSnapshot;
  /** In-flight request count + plan ceiling (visibility-only in v1). */
  concurrency: ConcurrencySnapshot;
  /** Decimal-string equivalent of `estimated_overage_usd` for finance
   *  pipelines that prefer `DECIMAL` typing over float JSON numbers. */
  estimated_overage_cost_usd: UsdAmount;
}

export interface UsageEvent {
  id: string;
  kind: UsageKind;
  units: number;
  api_key_id: string | null;
  request_id: string | null;
  status_code: number | null;
  latency_ms: number | null;
  created_at: string;
  /** Credits charged. Non-2xx rows always carry `0`. */
  credits: number;
  /** Marginal cost as a decimal string · `"0.00"` inside the bundle. */
  cost_usd: UsdAmount;
}

/** Detail-shape returned by `GET /v1/usage/events/:id`. Adds `model`
 *  lifted from the row's metadata so a header-scraped `request_id` can
 *  be dereferenced into a row with the public model identifier. */
export interface UsageEventDetail extends UsageEvent {
  model: string | null;
}

export interface UsageEventsList {
  data: UsageEvent[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface UsageEventsQuery {
  kind?: UsageKind;
  limit?: number;
  cursor?: string;
}

/** Extra metadata the SDK attaches to every response object (not on
 *  binary TTS responses — those return a dedicated stream helper). */
export interface ResponseMeta {
  /** Echoed `X-Request-Id` from the server. */
  requestId: string | undefined;
  /** Raw `status` of the HTTP response. */
  status: number;
  /** Case-insensitive view over response headers. */
  headers: Headers;
}

/** TTS response on the non-streaming path. Contains the full audio body
 *  plus SDK-surfaced meta. */
export interface SpeechResponse {
  /** Audio bytes. Use `arrayBuffer()` / `bytes()` to consume. */
  audio: Uint8Array;
  /** e.g. `audio/mpeg`, `audio/wav`, `audio/pcm;rate=24000`, … */
  contentType: string;
  /** Unicode code-point count billed, from `X-Usage-Characters`. */
  usageCharacters: number | undefined;
  /** Audio duration ms, from `X-Duration-Ms`. */
  durationMs: number | undefined;
  /**
   * Enterprise usage observability · per-request usage block parsed
   * from the `x-hakim-usage-*` response headers. `undefined` only on
   * test keys (`hk_test_…`) which deliberately skip the quota
   * pipeline that produces this block.
   */
  usage: UsageBlock | undefined;
  /**
   * Partial limits snapshot parsed from the period + concurrency
   * response headers. `rate_limit` is omitted because the SDK can
   * read `x-ratelimit-*` directly when needed; call `usage.limits()`
   * for the full snapshot including `rate_limit.reset_at`.
   */
  limits: SpeechResponseLimits | undefined;
  meta: ResponseMeta;
}

/** TTS streaming response. `stream` yields Uint8Array chunks as they
 *  arrive from the server. Iterate with `for await` or pipe to stdout. */
export interface SpeechStreamResponse {
  stream: AsyncIterable<Uint8Array>;
  contentType: string;
  usageCharacters: number | undefined;
  usage: UsageBlock | undefined;
  limits: SpeechResponseLimits | undefined;
  meta: ResponseMeta;
}

/** Header-derived limits snapshot · `rate_limit` is intentionally
 *  omitted (it lives in `x-ratelimit-*` and reset is delivered as a
 *  duration rather than the absolute `reset_at` carried by
 *  `LimitsSnapshot`). Call `usage.limits()` for the full envelope. */
export interface SpeechResponseLimits {
  plan: PlanSnapshot;
  period: PeriodSnapshot;
  credits: CreditsSnapshot;
  concurrency: ConcurrencySnapshot;
}

// ---------------------------------------------------------------------------
// Voice clone (POST /v1/audio/voices)
// ---------------------------------------------------------------------------

/** Multipart body for `voices.create()`. The server accepts a single
 *  audio sample plus metadata; the clone worker picks up from there and
 *  flips `status` from `processing` to `ready` (or `failed`). */
export interface VoiceCreateRequest {
  /** Single audio sample of the target voice. Accepts the same inputs
   *  as STT (`Blob`, `Buffer`, `Uint8Array`, Node `ReadableStream`). */
  sample: AudioInput;
  /** Name the caller will see in dashboards and API list responses. */
  name: string;
  /** Optional short description (≤ 500 chars). */
  description?: string;
  /** Language the sample is in. Cloned voices are pinned to a language.
   *  Phase 4 widened this union from `'ar' | 'en' | 'multi'` to the
   *  full STT-aligned set (37 bases + 12 Arabic dialects). */
  language: VoiceLanguage;
  /** Optional voice use-case / tone. Defaults server-side to
   *  `conversational` when omitted (Phase 4). */
  voice_type?: VoiceType;
  /** Must be `true`. The server rejects anything else with
   *  `consent_not_confirmed`. Required by the voice-cloning consent
   *  workflow — never default this to `true` on behalf of the user. */
  consent_confirmed: true;
  /** Filename to attach on the multipart part. Defaults to
   *  `sample.bin`; upstream ffprobe sniffs the real format. */
  filename?: string;
}

// ---------------------------------------------------------------------------
// Webhooks (/v1/webhooks)
// ---------------------------------------------------------------------------

export type WebhookEventKey =
  | 'job.completed'
  | 'voice.ready'
  | 'voice.failed'
  | 'usage.threshold.reached'
  | 'invoice.paid'
  | 'invoice.payment_failed';

export interface Webhook {
  id: string;
  url: string;
  events: WebhookEventKey[];
  active: boolean;
  created_at: string;
}

/** Result of `webhooks.create()`. Includes the raw `secret` exactly
 *  once — the same value is never returned by any other endpoint. */
export interface WebhookCreated extends Webhook {
  secret: string;
}

export interface WebhookCreateRequest {
  url: string;
  events: WebhookEventKey[];
  active?: boolean;
}

export interface WebhookUpdateRequest {
  url?: string;
  events?: WebhookEventKey[];
  active?: boolean;
}

export interface WebhooksListResponse {
  object: 'list';
  data: Webhook[];
}

export type WebhookDeliveryStatus = 'pending' | 'succeeded' | 'failed';

export interface WebhookDelivery {
  id: string;
  webhook_id: string;
  event: WebhookEventKey;
  status: WebhookDeliveryStatus;
  status_code: number | null;
  attempts: number;
  next_retry_at: string | null;
  delivered_at: string | null;
  created_at: string;
}

export interface WebhookDeliveriesListQuery {
  webhook_id?: string;
  status?: WebhookDeliveryStatus;
  limit?: number;
  cursor?: string;
}

export interface WebhookDeliveriesListResponse {
  object: 'list';
  data: WebhookDelivery[];
  has_more: boolean;
  next_cursor: string | null;
}

// ---------------------------------------------------------------------------
// Jobs (/v1/jobs)
// ---------------------------------------------------------------------------

export type JobType = 'batch_stt' | 'voice_clone' | 'bulk_tts';
export type JobStatus = 'queued' | 'processing' | 'succeeded' | 'failed' | 'canceled';

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  progress_pct: number;
  result_url: string | null;
  error_message: string | null;
  error_code?: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface JobsListQuery {
  status?: JobStatus;
  type?: JobType;
  limit?: number;
  cursor?: string;
}

export interface JobsListResponse {
  object: 'list';
  data: Job[];
  has_more: boolean;
  next_cursor: string | null;
}

// ---------------------------------------------------------------------------
// Settings + notifications (/v1/settings/* + /v1/notifications)
// ---------------------------------------------------------------------------

export type UserLocale = 'ar' | 'en';

export interface Profile {
  id: string;
  email: string;
  email_verified: boolean;
  name: string | null;
  locale: UserLocale;
  timezone: string;
  avatar_url: string | null;
  marketing_opt_in: boolean;
}

export interface ProfileUpdateRequest {
  name?: string | null;
  locale?: UserLocale;
  timezone?: string;
  marketing_opt_in?: boolean;
}

export interface OrganizationSettings {
  id: string;
  name: string;
  slug: string;
  billing_email: string | null;
  default_locale: UserLocale;
  logo_url: string | null;
}

export interface OrganizationSettingsUpdateRequest {
  name?: string;
  slug?: string;
  billing_email?: string | null;
  default_locale?: UserLocale;
}

export interface NotificationPreferences {
  job_completions: boolean;
  voice_ready: boolean;
  billing_alerts: boolean;
  product_updates: boolean;
}

export type NotificationPreferencesUpdateRequest = Partial<NotificationPreferences>;

// ---------------------------------------------------------------------------
// Realtime STT (WSS /v1/audio/transcriptions/stream)
// ---------------------------------------------------------------------------

export interface TranscriptionStreamOptions {
  model?: STTModel;
  language?: STTLanguage;
  /** Sample rate (Hz) of the audio you're about to send. Defaults to
   *  16000 — the server resamples if it has to but the caller wastes
   *  bandwidth by sending the wrong rate. */
  sample_rate?: SampleRate;
  /** Format of the audio frames you'll send. Defaults to `pcm16` which
   *  maps to little-endian signed 16-bit PCM. */
  audio_format?: 'pcm16';
  /** Abort signal — closing it sends a clean close frame to the server. */
  signal?: AbortSignal;
}

/** Partial hypothesis (interim transcript, refines on every emit). */
export interface TranscriptionPartialEvent {
  type: 'partial';
  text: string;
  /** Ordinal index within the stream, monotonic. */
  seq: number;
}

/** Stable transcript segment — once `final`, a segment's text is
 *  committed and the server will never emit a `partial` for it again. */
export interface TranscriptionFinalEvent {
  type: 'final';
  text: string;
  language?: string;
  /** Start / end offsets from stream-open, in seconds. */
  start?: number;
  end?: number;
  seq: number;
}

/** Terminal event with the total metered usage. Always emitted
 *  exactly once right before the server closes the socket. */
export interface TranscriptionUsageEvent {
  type: 'usage';
  seconds: number;
}

/** Anything the server surfaces mid-stream (invalid payload, quota
 *  tripped, etc). The SDK translates the `code` into a `HakimError`
 *  subclass and throws; this shape is what callers see via
 *  `for await` iteration. */
export interface TranscriptionErrorEvent {
  type: 'error';
  code: string;
  message: string;
}

export type TranscriptionStreamEvent =
  | TranscriptionPartialEvent
  | TranscriptionFinalEvent
  | TranscriptionUsageEvent
  | TranscriptionErrorEvent;

/** Handle returned by `audio.transcriptions.stream()`. Callers send
 *  audio chunks with `sendAudio(bytes)`, iterate `events` to receive
 *  partials / finals, and call `close()` when they're done to flush
 *  the final usage event. */
export interface TranscriptionStreamHandle {
  /** Push a PCM chunk to the server. Buffers internally if the socket
   *  isn't open yet; throws if the stream is closed. */
  sendAudio(chunk: Uint8Array | ArrayBuffer | ArrayBufferView | Buffer): void;
  /** AsyncIterable of events. Consume with `for await (const e of
   *  handle.events) { … }`. Completes once the server closes. */
  readonly events: AsyncIterable<TranscriptionStreamEvent>;
  /** Signal end-of-audio. The server emits a final `usage` event and
   *  closes. Resolves once the close handshake completes. */
  close(): Promise<void>;
  /** Resolves once the server has closed the socket. Useful as an
   *  alternative to iterating events when you only care about totals. */
  readonly closed: Promise<void>;
}

// ---------------------------------------------------------------------------
// Realtime TTS (WSS /v1/audio/speech/stream)
// ---------------------------------------------------------------------------

/** Session-wide defaults applied to every `sendSpeech` call unless
 *  the call itself overrides the field. Only fields that are
 *  routinely pinned for the lifetime of a session live here — text
 *  + the optional `voice` override go on `sendSpeech`. */
export interface SpeechStreamOptions {
  model?: TTSModel;
  /** Default voice applied when a sendSpeech() omits its own voice.
   *  Same accepted shape as the HTTP `/v1/audio/speech` route
   *  (Voice.id preferred, slug accepted for prototyping). */
  voice?: string;
  /** Classifier-free guidance scale (0–10). Defaults to 2.0. */
  cfg?: number;
  /** Optional free-form voice prompt. Honoured only on tiers that
   *  advertise the `voice_prompt` capability (currently `hakim-v3`). */
  voice_prompt?: string;
  /** Abort signal — closing it sends a clean close frame to the
   *  server. */
  signal?: AbortSignal;
}

/** Per-utterance request shape passed to `handle.sendSpeech()`. */
export interface SpeechStreamCreateRequest {
  input: string;
  voice?: string;
  model?: TTSModel;
  cfg?: number;
  voice_prompt?: string;
  /** Client-supplied correlation id; echoed back on every event tied
   *  to this utterance (speech.started / speech.done / error). When
   *  omitted, the server assigns one shaped `wst_<base36>`. */
  request_id?: string;
}

/** Emitted once the server has resolved the voice + dispatched the
 *  upstream request. Audio chunks (`speech.audio` events) follow
 *  until the matching `speech.done`. */
export interface SpeechStreamStartedEvent {
  type: 'speech.started';
  request_id: string;
  characters: number;
  sample_rate: number;
  encoding: 'pcm_s16le';
  channels: 1;
  model: string;
  voice: string;
}

/** Audio chunk delivered between `speech.started` and `speech.done`.
 *  `chunk` is raw PCM-S16LE bytes. The SDK groups these as discrete
 *  events so consumers can treat the iterable as the single source
 *  of truth instead of juggling a separate binary channel. */
export interface SpeechStreamAudioEvent {
  type: 'speech.audio';
  request_id: string;
  chunk: Uint8Array;
}

/** Terminal per-utterance event. `duration_ms` is the synthesised
 *  audio duration computed from the streamed byte count. */
export interface SpeechStreamDoneEvent {
  type: 'speech.done';
  request_id: string;
  duration_ms: number;
  usage: UsageBlock;
}

/** Periodic + terminal usage heartbeat · cumulative characters
 *  billed for the session so far. */
export interface SpeechStreamUsageEvent {
  type: 'session.usage';
  session_characters: number;
  usage: UsageBlock;
}

/** Server-emitted error. `fatal` distinguishes a per-utterance
 *  failure (`fatal: false`, session continues) from a session
 *  terminator (`fatal: true`, socket closes after this event). */
export interface SpeechStreamErrorEvent {
  type: 'error';
  code: string;
  message: string;
  retryable: boolean;
  fatal: boolean;
  request_id?: string;
}

export type SpeechStreamEvent =
  | SpeechStreamStartedEvent
  | SpeechStreamAudioEvent
  | SpeechStreamDoneEvent
  | SpeechStreamUsageEvent
  | SpeechStreamErrorEvent;

/** Handle returned by `audio.speech.streamWs()`. Callers request
 *  utterances with `sendSpeech({ input, voice?, ... })`, iterate
 *  `events` to receive audio chunks + lifecycle events, and call
 *  `close()` when done to flush usage and tear down the socket. */
export interface SpeechStreamHandle {
  /** Request a new utterance. Buffers internally if the socket
   *  isn't open yet; throws if the stream is closed. Returns the
   *  `request_id` (server-assigned when not supplied) so the caller
   *  can correlate events for this utterance. */
  sendSpeech(request: SpeechStreamCreateRequest): string;
  /** Update session-wide defaults (model, voice, cfg, voice_prompt)
   *  mid-session. Useful for voice-agent flows that switch personas
   *  without reconnecting. */
  updateSession(session: Partial<SpeechStreamOptions>): void;
  /** AsyncIterable of events. Consume with `for await (const e of
   *  handle.events) { … }`. Completes once the server closes. */
  readonly events: AsyncIterable<SpeechStreamEvent>;
  /** Convenience iterator that yields only the raw PCM chunks for
   *  every utterance, in arrival order, until the socket closes.
   *  Equivalent to filtering `events` for `speech.audio.chunk`. */
  readonly audio: AsyncIterable<Uint8Array>;
  /** Signal end-of-session. The server flushes one terminal
   *  `session.usage` row then closes. Resolves once the close
   *  handshake completes. */
  close(): Promise<void>;
  /** Resolves once the server has closed the socket. */
  readonly closed: Promise<void>;
}

// ---------------------------------------------------------------------------
// Realtime Translate (WSS /v1/audio/translate/stream)
// ---------------------------------------------------------------------------

/** Session config sent on every `session.update`. The minimal session
 *  is `{ target_language: 'en' }` — everything else has a server-side
 *  default. */
export interface TranslateStreamOptions {
  /** Target language code. Required for the first `session.update`. */
  target_language?: BaseLanguageCode;
  /** Source language — `'auto'` lets the STT engine detect. Default `auto`. */
  source_language?: 'auto' | BaseLanguageCode | ArabicDialectCode;
  /** Override the auto-resolved voice. When omitted, the server picks
   *  the default voice for `(target_language, gender)`. */
  voice?: string;
  /** Default voice gender — used only when `voice` is unset. Default `female`. */
  gender?: VoiceGender;
  /** Override the STT model. Defaults to `hakim-arab-v2`. */
  model_stt?: STTModel;
  /** Override the LLM model. Defaults to the deployment's configured chat model. */
  model_llm?: ChatModel;
  /** Override the TTS model. Defaults to `hakim-fast-v1`. */
  model_tts?: TTSModel;
  /** Classifier-free guidance scale forwarded to TTS. */
  cfg?: number;
  /** Input audio format. Default `pcm16`. */
  input_audio_format?: 'pcm16' | 'opus' | 'mulaw';
  /** Input sample rate (Hz). Default `16000`. */
  input_sample_rate?: 8000 | 16000 | 22050 | 24000 | 44100 | 48000;
  /** Whether STT should emit interim partial-text frames. Default `true`. */
  partials?: boolean;
  /** Optional override for the translator system prompt. */
  system_prompt?: string;
  /** Abort signal — aborting sends a clean `session.close`. */
  signal?: AbortSignal;
}

/** Emitted as soon as the server has resolved the voice + dialed all
 *  three upstreams. Carries the merged config + chosen voice. */
export interface TranslateStreamCreatedEvent {
  type: 'session.created';
  session_id: string;
  voice_id: string;
  voice_slug: string;
  model_stt: string;
  model_llm: string;
  model_tts: string;
}

export interface TranslateStreamTranscriptionDeltaEvent {
  type: 'transcription.delta';
  utterance_id: string;
  text: string;
  is_final: boolean;
}

export interface TranslateStreamTranscriptionDoneEvent {
  type: 'transcription.done';
  utterance_id: string;
  text: string;
  language?: string;
  audio_ms: number;
  usage: UsageBlock;
}

export interface TranslateStreamTranslationDeltaEvent {
  type: 'translation.delta';
  utterance_id: string;
  text: string;
}

export interface TranslateStreamTranslationDoneEvent {
  type: 'translation.done';
  utterance_id: string;
  text: string;
  usage: UsageBlock;
}

export interface TranslateStreamSpeechStartedEvent {
  type: 'speech.started';
  utterance_id: string;
  characters: number;
  sample_rate: number;
  encoding: 'pcm_s16le';
  channels: 1;
  voice_id: string;
}

/** PCM-S16LE chunk for the in-flight utterance. The SDK groups
 *  binary frames into events so consumers iterate a single stream. */
export interface TranslateStreamSpeechAudioEvent {
  type: 'speech.audio';
  utterance_id: string;
  chunk: Uint8Array;
}

export interface TranslateStreamSpeechDoneEvent {
  type: 'speech.done';
  utterance_id: string;
  duration_ms: number;
  usage: UsageBlock;
}

/** Cross-modality usage rollup — emitted every 30 s and once on close. */
export interface TranslateStreamSessionUsageEvent {
  type: 'session.usage';
  session_id: string;
  totals: {
    stt_audio_ms: number;
    llm_tokens: number;
    tts_characters: number;
    credits: number;
    cost_usd: string;
  };
}

export interface TranslateStreamErrorEvent {
  type: 'error';
  code: string;
  message: string;
  retryable: boolean;
  fatal: boolean;
  utterance_id?: string;
}

export type TranslateStreamEvent =
  | TranslateStreamCreatedEvent
  | TranslateStreamTranscriptionDeltaEvent
  | TranslateStreamTranscriptionDoneEvent
  | TranslateStreamTranslationDeltaEvent
  | TranslateStreamTranslationDoneEvent
  | TranslateStreamSpeechStartedEvent
  | TranslateStreamSpeechAudioEvent
  | TranslateStreamSpeechDoneEvent
  | TranslateStreamSessionUsageEvent
  | TranslateStreamErrorEvent;

/** Handle returned by `audio.translate.streamWs()`. Callers stream
 *  audio in with `sendAudio()`, iterate `events` for the full
 *  STT → LLM → TTS event catalog (or `audio` for the raw PCM chunks
 *  of the synthesised target), and `close()` when done to flush
 *  usage and tear down the socket. */
export interface TranslateStreamHandle {
  /** Append a chunk of source audio (PCM at the configured
   *  `input_sample_rate`). Buffers internally if the socket isn't
   *  open yet; throws if the stream is closed. */
  sendAudio(chunk: Uint8Array | ArrayBuffer | ArrayBufferView | Buffer): void;
  /** Force an immediate STT utterance boundary. Equivalent to the
   *  end-of-speech signal the proxy would otherwise synthesise after
   *  a quiet window. */
  commitAudio(): void;
  /** Update session-wide defaults mid-session. Merged into the local
   *  copy too so a lazy reopen carries the latest values. */
  updateSession(session: Partial<TranslateStreamOptions>): void;
  /** AsyncIterable of every event. Completes once the server closes. */
  readonly events: AsyncIterable<TranslateStreamEvent>;
  /** Convenience iterator that yields only the synthesised audio
   *  bytes (raw PCM-S16LE @ 24 kHz mono), in arrival order, until
   *  the socket closes. Equivalent to filtering `events` for
   *  `speech.audio.chunk`. */
  readonly audio: AsyncIterable<Uint8Array>;
  /** Signal end-of-session. The server emits a terminal
   *  `session.usage` rollup then closes. */
  close(): Promise<void>;
  /** Resolves once the server has closed the socket. */
  readonly closed: Promise<void>;
}
