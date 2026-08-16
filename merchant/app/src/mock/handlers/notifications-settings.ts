import type { NotificationDto, NotificationPreferences, OrderAlertSettings } from '@/api/types';
import { db } from '@/mock/db';
import { json, ok, requireSession } from '@/mock/security';
import { ApiHttpError, h, readJson } from '@/mock/handlers/common';
import { http } from 'msw';

/* ================= P6: Notification preferences + order alerts (contract
 * /notifications/me/preferences, /notifications/me/order-settings,
 * /notifications/{notificationId}/read — API-CONTRACT.yaml). ================= */

type PreferenceRow = { id: string; merchantId: string } & NotificationPreferences;
type OrderAlertRow = { id: string; merchantId: string } & OrderAlertSettings;

const BASE = typeof location !== 'undefined' ? location.origin : 'http://localhost';

/** PUT wrapper (common.h has get/post/patch only) — same error envelope. */
function put(path: string, fn: (args: { request: Request; params: Record<string, string> }) => Promise<Response> | Response) {
  return http.put(`${BASE}${path}`, async (info) => {
    try {
      return await fn({ request: info.request, params: (info.params ?? {}) as Record<string, string> });
    } catch (e) {
      if (e instanceof ApiHttpError) {
        return json(e.status, { error: { code: e.code, message: e.message, retriable: e.retriable, details: e.details } });
      }
      throw e;
    }
  });
}

const DEFAULT_PREFERENCES: Record<keyof NotificationPreferences, boolean> = {
  push: true,
  sms: false,
  email: true,
  inApp: true,
};

/** Event keys surfaced in the settings screen — the contract treats each
 * channel map as free-form event key → boolean, so the mock seeds the same
 * keys the merchant UI edits. */
const EVENT_KEYS = [
  'order.created',
  'order.status',
  'refund.processed',
  'review.received',
  'ticket.reply',
  'withdrawal.paid',
  'marketing.campaign',
  'system.announcement',
] as const;

/** System/high-priority events render locked-on in the UI and cannot be
 * disabled (NOTIFICATIONS.md §Preferences — "system events render locked-on";
 * backend/NOTIFICATIONS.md — OTP/security/payout failures bypass prefs). The
 * server enforces the same set on PUT so a client can never disable them. */
export const LOCKED_PREFERENCE_EVENTS: ReadonlySet<string> = new Set([
  'system.announcement',
  'otp.requested',
  'otp.verified',
  'withdrawal.failed',
  'payout.failed',
]);

function preferencesOf(merchantId: string): NotificationPreferences {
  const row = db.table<PreferenceRow>('notificationPreferences').where((r) => r.merchantId === merchantId)[0];
  if (row) return { push: { ...row.push }, sms: { ...row.sms }, email: { ...row.email }, inApp: { ...row.inApp } };
  const fallback: NotificationPreferences = { push: {}, sms: {}, email: {}, inApp: {} };
  for (const channel of Object.keys(DEFAULT_PREFERENCES) as (keyof NotificationPreferences)[]) {
    fallback[channel] = Object.fromEntries(EVENT_KEYS.map((k) => [k, DEFAULT_PREFERENCES[channel]]));
  }
  return fallback;
}

function parsePreferences(body: Record<string, unknown>): NotificationPreferences {
  const out: NotificationPreferences = { push: {}, sms: {}, email: {}, inApp: {} };
  for (const channel of Object.keys(out) as (keyof NotificationPreferences)[]) {
    const map = body[channel];
    if (map === undefined || map === null || typeof map !== 'object' || Array.isArray(map)) {
      throw new ApiHttpError(400, 'INVALID_PREFERENCES', `${channel} must be a map of event key → boolean`);
    }
    for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
      if (typeof value !== 'boolean') {
        throw new ApiHttpError(400, 'INVALID_PREFERENCES', `${channel}.${key} must be a boolean`);
      }
      out[channel][key] = value;
    }
  }
  /* Locked-on system events: the server forces them enabled on every channel
   * (they bypass preferences per backend/NOTIFICATIONS.md). */
  for (const channel of Object.keys(out) as (keyof NotificationPreferences)[]) {
    for (const key of LOCKED_PREFERENCE_EVENTS) {
      out[channel][key] = true;
    }
  }
  return out;
}

function orderSettingsOf(merchantId: string): OrderAlertSettings {
  const row = db.table<OrderAlertRow>('orderAlertSettings').where((r) => r.merchantId === merchantId)[0];
  if (row) {
    return {
      acceptanceMethod: row.acceptanceMethod,
      voiceAlerts: row.voiceAlerts,
      channels: [...row.channels],
      ...(row.quietHours ? { quietHours: { ...row.quietHours } } : {}),
      ...(row.autoAcceptWithinSeconds !== undefined ? { autoAcceptWithinSeconds: row.autoAcceptWithinSeconds } : {}),
    };
  }
  const store = db.table<{ id: string; merchantId: string; orderSettings?: { autoAccept?: boolean; autoAcceptDelaySec?: number; voiceAnnounce?: boolean } }>('stores').where((s) => s.merchantId === merchantId)[0];
  return {
    acceptanceMethod: store?.orderSettings?.autoAccept ? 'auto' : 'manual',
    voiceAlerts: store?.orderSettings?.voiceAnnounce ?? true,
    channels: ['push', 'in_app'],
    quietHours: { enabled: false, from: '22:00', to: '08:00' },
    autoAcceptWithinSeconds: Math.min(300, Math.max(30, store?.orderSettings?.autoAcceptDelaySec ?? 60)),
  };
}

const CHANNELS: readonly OrderAlertChannel[] = ['push', 'sms', 'in_app'];
type OrderAlertChannel = OrderAlertSettings['channels'][number];

function parseOrderSettings(body: Record<string, unknown>): OrderAlertSettings {
  const acceptanceMethod = body.acceptanceMethod;
  if (acceptanceMethod !== 'manual' && acceptanceMethod !== 'auto') {
    throw new ApiHttpError(400, 'INVALID_ACCEPTANCE_METHOD', 'acceptanceMethod must be manual or auto');
  }
  if (typeof body.voiceAlerts !== 'boolean') {
    throw new ApiHttpError(400, 'INVALID_ORDER_SETTINGS', 'voiceAlerts must be a boolean');
  }
  if (!Array.isArray(body.channels) || body.channels.some((c) => !CHANNELS.includes(c as OrderAlertChannel))) {
    throw new ApiHttpError(400, 'INVALID_CHANNELS', `channels must be a subset of ${CHANNELS.join(', ')}`);
  }
  let autoAcceptWithinSeconds: number | undefined;
  if (body.autoAcceptWithinSeconds !== undefined) {
    const n = Number(body.autoAcceptWithinSeconds);
    if (!Number.isInteger(n) || n < 30 || n > 300) {
      throw new ApiHttpError(400, 'INVALID_AUTO_ACCEPT', 'autoAcceptWithinSeconds must be an integer between 30 and 300');
    }
    autoAcceptWithinSeconds = n;
  }
  const rawQuiet = body.quietHours as Record<string, unknown> | undefined;
  const quietHours = rawQuiet === undefined ? undefined : {
    enabled: rawQuiet.enabled === true,
    from: String(rawQuiet.from ?? '22:00'),
    to: String(rawQuiet.to ?? '08:00'),
  };
  return {
    acceptanceMethod,
    voiceAlerts: body.voiceAlerts,
    channels: [...(body.channels as OrderAlertChannel[])],
    ...(quietHours ? { quietHours } : {}),
    ...(autoAcceptWithinSeconds !== undefined ? { autoAcceptWithinSeconds } : {}),
  };
}

export const notificationSettingsHandlers = [
  h.get('/api/notifications/me/preferences', ({ request }) => {
    const session = requireSession(request);
    return ok(preferencesOf(session.merchantId));
  }),

  put('/api/notifications/me/preferences', async ({ request }) => {
    const session = requireSession(request);
    const body = await readJson(request);
    const parsed = parsePreferences(body);
    const existing = db.table<PreferenceRow>('notificationPreferences').where((r) => r.merchantId === session.merchantId)[0];
    if (existing) {
      db.table<PreferenceRow>('notificationPreferences').update(existing.id, parsed);
    } else {
      db.table<PreferenceRow>('notificationPreferences').insert({ id: `pref_${session.merchantId}`, merchantId: session.merchantId, ...parsed });
    }
    return ok(preferencesOf(session.merchantId));
  }),

  h.get('/api/notifications/me/order-settings', ({ request }) => {
    const session = requireSession(request);
    return ok(orderSettingsOf(session.merchantId));
  }),

  put('/api/notifications/me/order-settings', async ({ request }) => {
    const session = requireSession(request);
    const body = await readJson(request);
    const parsed = parseOrderSettings(body);
    const existing = db.table<OrderAlertRow>('orderAlertSettings').where((r) => r.merchantId === session.merchantId)[0];
    if (existing) {
      db.table<OrderAlertRow>('orderAlertSettings').update(existing.id, parsed);
    } else {
      db.table<OrderAlertRow>('orderAlertSettings').insert({ id: `oa_${session.merchantId}`, merchantId: session.merchantId, ...parsed });
    }
    return ok(orderSettingsOf(session.merchantId));
  }),

  h.post('/api/notifications/:notificationId/read', ({ request, params }) => {
    const session = requireSession(request);
    const note = db.table<NotificationDto>('notifications').find(String(params.notificationId));
    if (!note || note.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Notification not found');
    if (!note.read) db.table<NotificationDto>('notifications').update(note.id, { read: true });
    return new Response(null, { status: 204 });
  }),
];
