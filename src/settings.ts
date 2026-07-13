/**
 * `client.settings.*` + `client.notifications.*` — M2 follow-up surface.
 *
 * Thin fetch wrappers around the public `/v1/settings/*` and
 * `/v1/notifications` endpoints. Both hang off the same bearer-auth
 * transport as the rest of the SDK; the server scopes reads to
 * `settings:read` and writes to `settings:write`.
 *
 * The "profile" and "notifications" endpoints target the API-key
 * creator user, while "organization" targets the key's org. The
 * resulting DX is:
 *
 *   const me   = await hakim.settings.getProfile();
 *   const org  = await hakim.settings.getOrganization();
 *   const prefs = await hakim.notifications.get();
 *
 *   await hakim.settings.updateProfile({ locale: 'en' });
 *   await hakim.settings.updateOrganization({ name: 'Acme Corp' });
 *   await hakim.notifications.update({ product_updates: true });
 */

import type { Transport } from './transport.js';
import type {
  NotificationPreferences,
  NotificationPreferencesUpdateRequest,
  OrganizationSettings,
  OrganizationSettingsUpdateRequest,
  Profile,
  ProfileUpdateRequest,
} from './types.js';

export class SettingsAPI {
  constructor(private readonly transport: Transport) {}

  async getProfile(opts: { signal?: AbortSignal } = {}): Promise<Profile> {
    const res = await this.transport.request({
      method: 'GET',
      path: '/v1/settings/profile',
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return (await res.json()) as Profile;
  }

  async updateProfile(
    patch: ProfileUpdateRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<Profile> {
    const res = await this.transport.request({
      method: 'PATCH',
      path: '/v1/settings/profile',
      json: patch,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return (await res.json()) as Profile;
  }

  async getOrganization(opts: { signal?: AbortSignal } = {}): Promise<OrganizationSettings> {
    const res = await this.transport.request({
      method: 'GET',
      path: '/v1/settings/organization',
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return (await res.json()) as OrganizationSettings;
  }

  async updateOrganization(
    patch: OrganizationSettingsUpdateRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<OrganizationSettings> {
    const res = await this.transport.request({
      method: 'PATCH',
      path: '/v1/settings/organization',
      json: patch,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return (await res.json()) as OrganizationSettings;
  }
}

export class NotificationsAPI {
  constructor(private readonly transport: Transport) {}

  async get(opts: { signal?: AbortSignal } = {}): Promise<NotificationPreferences> {
    const res = await this.transport.request({
      method: 'GET',
      path: '/v1/notifications',
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return (await res.json()) as NotificationPreferences;
  }

  async update(
    patch: NotificationPreferencesUpdateRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<NotificationPreferences> {
    const res = await this.transport.request({
      method: 'PATCH',
      path: '/v1/notifications',
      json: patch,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return (await res.json()) as NotificationPreferences;
  }
}
