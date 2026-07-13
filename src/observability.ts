/**
 * `observability` — parse the `x-hakim-*` response headers into typed
 * shapes mirroring `@hakim/schemas/observability.ts`.
 *
 * The server stamps every successful TTS / STT response with the
 * canonical observability header set. Customers integrating with
 * `Snowpipe`/`BigQuery`/`Splunk` can copy the headers into a warehouse
 * directly, but in-process callers usually want a typed object on the
 * response · these helpers do that lift without forcing every caller
 * to remember the header names.
 *
 * The header names are the contract; we intentionally hard-code them
 * here (rather than importing `OBSERVABILITY_HEADERS` from
 * `@hakim/schemas`) so the SDK stays publishable stand-alone. The
 * drift test in `openapi-drift.test.ts` keeps the header surface in
 * lockstep with the Zod source.
 */
import type {
  ConcurrencySnapshot,
  CreditsSnapshot,
  PeriodSnapshot,
  PlanSnapshot,
  SpeechResponseLimits,
  UsageBlock,
  UsageUnitType,
} from './types.js';

/** Decode the `x-hakim-usage-*` family into a `UsageBlock`. Returns
 *  `undefined` when any required header is missing · the server emits
 *  the full set atomically, so a partial set means we're talking to a
 *  pre-observability API (or a non-billable surface). */
export function parseUsageBlockFromHeaders(headers: Headers): UsageBlock | undefined {
  const kind = readKind(headers.get('x-hakim-usage-kind'));
  const units = readInt(headers.get('x-hakim-usage-units'));
  const unitType = readUnitType(headers.get('x-hakim-usage-unit-type'));
  const credits = readInt(headers.get('x-hakim-usage-credits'));
  const cost = headers.get('x-hakim-usage-cost-usd');
  const requestId = headers.get('x-request-id');
  const periodStart = headers.get('x-hakim-period-start');
  const periodEnd = headers.get('x-hakim-period-end');

  if (
    kind === undefined ||
    units === undefined ||
    unitType === undefined ||
    credits === undefined ||
    cost === null ||
    requestId === null ||
    periodStart === null ||
    periodEnd === null
  ) {
    return undefined;
  }

  return {
    request_id: requestId,
    kind,
    units,
    unit_type: unitType,
    credits,
    cost_usd: cost,
    model: headers.get('x-hakim-model'),
    billing_period_start: periodStart,
    billing_period_end: periodEnd,
  };
}

/** Decode the period + credits + concurrency snapshot a response
 *  carries on its headers. The rate-limit dimension is dropped on
 *  purpose · see `SpeechResponseLimits` docblock. */
export function parseLimitsFromHeaders(headers: Headers): SpeechResponseLimits | undefined {
  const planId = headers.get('x-hakim-plan-id');
  const periodStart = headers.get('x-hakim-period-start');
  const periodEnd = headers.get('x-hakim-period-end');
  const included = readInt(headers.get('x-hakim-credits-included'));
  const used = readInt(headers.get('x-hakim-credits-used'));
  const remaining = readInt(headers.get('x-hakim-credits-remaining'));
  const effective = readInt(headers.get('x-hakim-credits-effective-limit'));
  const concLimit = readInt(headers.get('x-hakim-concurrency-limit'));
  const concCurrent = readInt(headers.get('x-hakim-concurrency-current'));

  if (
    !planId ||
    !periodStart ||
    !periodEnd ||
    included === undefined ||
    used === undefined ||
    remaining === undefined ||
    effective === undefined ||
    concLimit === undefined ||
    concCurrent === undefined
  ) {
    return undefined;
  }

  const plan: PlanSnapshot = {
    id: planId,
    name: planId,
    // The header set doesn't carry the overage-mode literal · use
    // `topup` (the current default) so the shape parses cleanly.
    // Callers that need the authoritative overage-mode should call
    // `usage.limits()`.
    overage_mode: 'topup',
  };
  const period: PeriodSnapshot = { start: periodStart, end: periodEnd };
  const credits: CreditsSnapshot = { included, used, remaining, effective_limit: effective };
  const concurrency: ConcurrencySnapshot = { limit: concLimit, current: concCurrent };
  return { plan, period, credits, concurrency };
}

function readInt(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

const KIND_VALUES = new Set<UsageBlock['kind']>([
  'tts',
  'stt_batch',
  'stt_realtime',
  'voice_clone',
  'video_studio',
  'llm_chat',
]);

function readKind(raw: string | null): UsageBlock['kind'] | undefined {
  if (raw === null) return undefined;
  return KIND_VALUES.has(raw as UsageBlock['kind']) ? (raw as UsageBlock['kind']) : undefined;
}

const UNIT_TYPE_VALUES: ReadonlySet<UsageUnitType> = new Set<UsageUnitType>([
  'characters',
  'seconds',
  'count',
  'credits',
  'tokens',
]);

function readUnitType(raw: string | null): UsageUnitType | undefined {
  if (raw === null) return undefined;
  return UNIT_TYPE_VALUES.has(raw as UsageUnitType) ? (raw as UsageUnitType) : undefined;
}
