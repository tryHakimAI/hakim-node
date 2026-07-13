/**
 * `@tryhakim/voice` — official Hakim API client for Node.js.
 *
 *   import { Hakim } from '@tryhakim/voice';
 *
 *   const hakim = new Hakim({ apiKey: process.env.HAKIM_API_KEY });
 *   const speech = await hakim.audio.speech.create({
 *     model: 'hakim-fast-v1',
 *     input: 'مرحبا بالعالم',
 *     // Pass the `id` from `hakim.audio.voices.list()` for stable
 *     // production traffic. Slugs (e.g. `'omar'`) are accepted but
 *     // are best for prototyping — they may collide between presets
 *     // and clones, and may shift if the voice catalogue is renamed.
 *     voice: 'cmokbc2b1001pvu39wmj61b7h',
 *   });
 *
 * See the package README for a tour of every namespace.
 */

export { Hakim, type HakimOptions } from './client.js';
export {
  HakimError,
  InvalidRequestError,
  AuthenticationError,
  PermissionError,
  NotFoundError,
  QuotaExceededError,
  RateLimitError,
  IdempotencyConflictError,
  ServiceUnavailableError,
  ConnectionError,
  type HakimErrorType,
  type HakimApiErrorPayload,
} from './errors.js';
export type {
  // Request shapes
  SpeechRequest,
  TranscriptionRequest,
  TranscriptionRequestCommon,
  TranscriptionStreamOptions,
  TranscriptionStreamHandle,
  TranscriptionStreamEvent,
  TranscriptionPartialEvent,
  TranscriptionFinalEvent,
  TranscriptionUsageEvent,
  TranscriptionErrorEvent,
  SpeechStreamOptions,
  SpeechStreamCreateRequest,
  SpeechStreamHandle,
  SpeechStreamEvent,
  SpeechStreamStartedEvent,
  SpeechStreamAudioEvent,
  SpeechStreamDoneEvent,
  SpeechStreamUsageEvent,
  SpeechStreamErrorEvent,
  TranslateStreamOptions,
  TranslateStreamHandle,
  TranslateStreamEvent,
  TranslateStreamCreatedEvent,
  TranslateStreamTranscriptionDeltaEvent,
  TranslateStreamTranscriptionDoneEvent,
  TranslateStreamTranslationDeltaEvent,
  TranslateStreamTranslationDoneEvent,
  TranslateStreamSpeechStartedEvent,
  TranslateStreamSpeechAudioEvent,
  TranslateStreamSpeechDoneEvent,
  TranslateStreamSessionUsageEvent,
  TranslateStreamErrorEvent,
  VoicesListQuery,
  VoiceCreateRequest,
  UsageEventsQuery,
  AudioInput,
  // Chat
  ChatModel,
  ChatRole,
  ChatMessage,
  ChatMessageContent,
  ChatTextContentPart,
  ChatReasoningOption,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChoice,
  ChatCompletionChunk,
  ChatCompletionChunkChoice,
  ChatCompletionChunkDelta,
  ChatCompletionUsage,
  ChatFinishReason,
  // Webhooks
  Webhook,
  WebhookCreated,
  WebhookCreateRequest,
  WebhookUpdateRequest,
  WebhooksListResponse,
  WebhookDelivery,
  WebhookDeliveriesListQuery,
  WebhookDeliveriesListResponse,
  WebhookDeliveryStatus,
  WebhookEventKey,
  // Jobs
  Job,
  JobType,
  JobStatus,
  JobsListQuery,
  JobsListResponse,
  // Response shapes
  SpeechResponse,
  SpeechStreamResponse,
  TranscriptionResult,
  TranscriptionJsonResponse,
  TranscriptionAsyncAccepted,
  VoicesListResponse,
  Voice,
  UsageSummary,
  UsageEvent,
  UsageEventsList,
  ResponseMeta,
  // Enums / unions
  TTSModel,
  ResponseFormat,
  SampleRate,
  STTModel,
} from './types.js';
export { DEFAULT_TTS_MODEL, DEFAULT_STT_MODEL } from './types.js';
export type {
  STTResponseFormat,
  STTTimestamps,
  STTLanguage,
  BaseLanguageCode,
  ArabicDialectCode,
  VoiceKind,
  VoiceLanguage,
  VoiceGender,
  VoiceStatus,
  UsageKind,
  // Settings + notifications
  Profile,
  ProfileUpdateRequest,
  OrganizationSettings,
  OrganizationSettingsUpdateRequest,
  NotificationPreferences,
  NotificationPreferencesUpdateRequest,
  UserLocale,
} from './types.js';
export {
  verifyWebhookSignature,
  type VerifyWebhookSignatureOptions,
  type WebhookSignatureVerifyResult,
} from './webhooks.js';
export {
  ChatCompletionsAPI,
  type ChatCompletionCreateResponse,
  type ChatCompletionStreamResponse,
  type StreamingUsagePreflight,
} from './chat/index.js';
export { SDK_VERSION, SDK_NAME } from './version.js';
