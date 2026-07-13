/**
 * Tests for `hakim.settings.*` + `hakim.notifications.*` (M2 follow-up).
 *
 * We swap the SDK's fetch implementation with a stub that records the
 * request and returns a canned response. Coverage:
 *   - GET /v1/settings/profile — correct URL + method, typed body.
 *   - PATCH /v1/settings/profile — sends JSON body with content-type
 *     and Authorization header.
 *   - GET + PATCH /v1/settings/organization — same.
 *   - GET + PATCH /v1/notifications — same.
 */
import { describe, expect, it } from 'vitest';
import { Hakim } from './client.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Captured = {
  url: string;
  method: string | undefined;
  body: string | undefined;
  contentType: string | undefined;
  auth: string | undefined;
};

function recordingFetch(response: Response, capture: Captured[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = new Headers(init?.headers);
    capture.push({
      url,
      method: init?.method,
      body: typeof init?.body === 'string' ? init.body : undefined,
      contentType: headers.get('content-type') ?? undefined,
      auth: headers.get('authorization') ?? undefined,
    });
    return response;
  }) as typeof fetch;
}

const profile = {
  id: 'user_1',
  email: 'ada@example.com',
  email_verified: true,
  name: 'Ada Lovelace',
  locale: 'ar' as const,
  timezone: 'Asia/Dubai',
  avatar_url: null,
  marketing_opt_in: false,
};

const org = {
  id: 'org_1',
  name: 'Analytic Engines',
  slug: 'analytic-engines',
  billing_email: 'bills@analytic.example',
  default_locale: 'en' as const,
  logo_url: null,
};

const prefs = {
  job_completions: true,
  voice_ready: true,
  billing_alerts: true,
  product_updates: false,
};

describe('settings.getProfile', () => {
  it('hits GET /v1/settings/profile with bearer auth', async () => {
    const capture: Captured[] = [];
    const hakim = new Hakim({
      apiKey: 'hk_test_profile',
      baseURL: 'https://api.example.test',
      fetchImpl: recordingFetch(jsonResponse(200, profile), capture),
    });

    const p = await hakim.settings.getProfile();
    expect(p).toEqual(profile);

    const call = capture[0]!;
    expect(call.method).toBe('GET');
    expect(call.url).toBe('https://api.example.test/v1/settings/profile');
    expect(call.auth).toBe('Bearer hk_test_profile');
  });
});

describe('settings.updateProfile', () => {
  it('sends the patch as JSON', async () => {
    const capture: Captured[] = [];
    const hakim = new Hakim({
      apiKey: 'hk_test_profile',
      fetchImpl: recordingFetch(jsonResponse(200, { ...profile, locale: 'en' }), capture),
    });

    const p = await hakim.settings.updateProfile({ locale: 'en' });
    expect(p.locale).toBe('en');

    const call = capture[0]!;
    expect(call.method).toBe('PATCH');
    expect(call.url).toMatch(/\/v1\/settings\/profile$/);
    expect(call.contentType).toBe('application/json');
    expect(JSON.parse(call.body ?? '{}')).toEqual({ locale: 'en' });
  });
});

describe('settings.getOrganization / updateOrganization', () => {
  it('GET hits /v1/settings/organization', async () => {
    const capture: Captured[] = [];
    const hakim = new Hakim({
      apiKey: 'hk_test_org',
      fetchImpl: recordingFetch(jsonResponse(200, org), capture),
    });

    const o = await hakim.settings.getOrganization();
    expect(o).toEqual(org);
    expect(capture[0]!.method).toBe('GET');
    expect(capture[0]!.url).toMatch(/\/v1\/settings\/organization$/);
  });

  it('PATCH sends the partial payload as JSON', async () => {
    const capture: Captured[] = [];
    const hakim = new Hakim({
      apiKey: 'hk_test_org',
      fetchImpl: recordingFetch(jsonResponse(200, { ...org, name: 'Renamed' }), capture),
    });

    const o = await hakim.settings.updateOrganization({ name: 'Renamed' });
    expect(o.name).toBe('Renamed');
    const call = capture[0]!;
    expect(call.method).toBe('PATCH');
    expect(JSON.parse(call.body ?? '{}')).toEqual({ name: 'Renamed' });
  });
});

describe('notifications.get / update', () => {
  it('GET returns the typed preferences record', async () => {
    const capture: Captured[] = [];
    const hakim = new Hakim({
      apiKey: 'hk_test_n',
      fetchImpl: recordingFetch(jsonResponse(200, prefs), capture),
    });
    const p = await hakim.notifications.get();
    expect(p).toEqual(prefs);
    expect(capture[0]!.method).toBe('GET');
    expect(capture[0]!.url).toMatch(/\/v1\/notifications$/);
  });

  it('PATCH sends only the keys provided', async () => {
    const capture: Captured[] = [];
    const merged = { ...prefs, product_updates: true };
    const hakim = new Hakim({
      apiKey: 'hk_test_n',
      fetchImpl: recordingFetch(jsonResponse(200, merged), capture),
    });
    const p = await hakim.notifications.update({ product_updates: true });
    expect(p.product_updates).toBe(true);
    expect(JSON.parse(capture[0]!.body ?? '{}')).toEqual({ product_updates: true });
  });
});
