import type {
  IntegrationInfo,
  IntegrationStatus,
  NotificationDto,
  P8bEvent,
  ServerEvent,
  UpdateWebhookSubscriptionBody,
  WebhookDelivery,
  WebhookSubscription,
} from '@/api/types';
import { http } from 'msw';
import { db, uid } from '@/mock/db';
import { emit } from '@/mock/events';
import { ApiHttpError, h, readJson } from '@/mock/handlers/common';
import { audit, json, ok, requireSession } from '@/mock/security';
import type { Session } from '@/mock/types-internal';

/* P8b webhooks + integrations (contract /webhooks, /integrations).
 * Rows are merchant-scoped server-side; the secret is write-only — stored on
 * the row, never returned by any response, and never logged. */

type WebhookRow = WebhookSubscription & { merchantId: string; secret: string; _consecutiveFailures?: number };
type DeliveryRow = WebhookDelivery & {
  merchantId: string;
  /** Test/demo hook: fail every attempt while attempts <= this number. */
  failUntilAttempts?: number;
  /** True once webhook.delivery_failed has been surfaced for this row. */
  _failedNotified?: boolean;
};
type IntegrationRow = IntegrationInfo & { merchantId: string };

/** Raw JSON body — the shared `ok()` spreads objects, so arrays go through here. */
const raw = (body: unknown, status = 200) => Response.json(body, { status });

const noContent = () => new Response(null, { status: 204 });

const BASE = typeof location !== 'undefined' ? location.origin : 'http://localhost';

/** DELETE wrapper — same error filter as the shared `h` helpers in handlers/common.ts. */
function del(
  path: string,
  fn: (args: { request: Request; params: Record<string, string> }) => Promise<Response> | Response,
) {
  return http.delete(`${BASE}${path}`, async (info) => {
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

/* ---- Delivery engine (IW L46-47, RM P8b E2E 9) ----
 * Deliveries start `retrying` with nextRetryAt due; the sweeper tick advances
 * them with exponential backoff (30s → 60s → 120s → 240s → 480s), max 8
 * attempts per event. After 5 consecutive errors the subscription flips to
 * `failing`; success flips the delivery to `success` (delivered). A delivery
 * that exhausts its attempts becomes `failed` and surfaces
 * `webhook.delivery_failed` (event + in-app notification). */

const MAX_ATTEMPTS = 8;
const FAILING_AFTER = 5;
const BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 480_000];

function notify(merchantId: string, title: string, body: string) {
  db.table<NotificationDto>('notifications').insert({
    id: uid('n'),
    merchantId,
    type: 'system',
    category: 'important',
    title,
    body,
    ts: Date.now(),
    read: false,
  });
}

function deliveryBackoffMs(attempts: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1];
}

/** Simulate one attempt for a due delivery. Deterministic for tests via
 *  `failUntilAttempts`; otherwise a 20% failure rate simulates flaky
 *  endpoints. Returns the updated delivery row. */
function attemptDelivery(d: DeliveryRow, now: number): DeliveryRow {
  const attempts = d.attempts + 1;
  const webhook = db.table<WebhookRow>('webhooks').find(d.webhookId);
  const fail = d.failUntilAttempts !== undefined ? attempts <= d.failUntilAttempts : Math.random() < 0.2;
  if (!fail) {
    const done = db.table<DeliveryRow>('webhookDeliveries').update(d.id, {
      status: 'success',
      attempts,
      statusCode: 200,
      nextRetryAt: null,
      deliveredAt: now,
    })!;
    if (webhook) {
      db.table<WebhookRow>('webhooks').update(webhook.id, { lastDeliveryAt: now, _consecutiveFailures: 0 });
    }
    return done;
  }
  const consecutive = (webhook?._consecutiveFailures ?? 0) + 1;
  const final = attempts >= MAX_ATTEMPTS;
  const row = db.table<DeliveryRow>('webhookDeliveries').update(d.id, {
    attempts,
    statusCode: final ? 500 : null,
    status: final ? 'failed' : 'retrying',
    nextRetryAt: final ? null : now + deliveryBackoffMs(attempts),
    deliveredAt: final ? now : null,
  })!;
  if (webhook) {
    const flipped = !final && consecutive >= FAILING_AFTER && webhook.status !== 'failing';
    const patch: Partial<WebhookRow> = { _consecutiveFailures: consecutive };
    if (flipped) patch.status = 'failing';
    db.table<WebhookRow>('webhooks').update(webhook.id, patch);
    if (flipped) {
      p8bEmit({ type: 'webhooks.updated', webhook: toWire({ ...webhook, ...patch }), at: now });
    }
  }
  if ((final || (!final && consecutive >= FAILING_AFTER)) && !row._failedNotified) {
    db.table<DeliveryRow>('webhookDeliveries').update(d.id, { _failedNotified: true });
    const delivery = toDeliveryWire(row);
    p8bEmit({ type: 'webhooks.delivery_failed', delivery, at: now });
    notify(
      d.merchantId,
      'Webhook delivery failing',
      `Delivery of ${delivery.event} to ${webhook?.url ?? delivery.webhookId} keeps failing — review the endpoint or re-enable after a fix.`,
    );
  }
  return row;
}

/** Sweeper tick: attempt every delivery whose nextRetryAt has arrived. */
export function webhookDeliveryTick(now = Date.now()): { attempted: number; delivered: number; failed: number } {
  const due = db
    .table<DeliveryRow>('webhookDeliveries')
    .where((d) => d.status === 'retrying' && (d.nextRetryAt ?? 0) <= now);
  let delivered = 0;
  let failed = 0;
  for (const d of due) {
    const next = attemptDelivery(d, now);
    if (next.status === 'success') delivered += 1;
    else if (next.status === 'failed') failed += 1;
  }
  return { attempted: due.length, delivered, failed };
}

/** Enqueue a delivery for the webhook's first event (create/test paths). */
function enqueueDelivery(webhook: WebhookRow, event: string, dueAt: number): DeliveryRow {
  const row: DeliveryRow = {
    id: uid('wdel'),
    merchantId: webhook.merchantId,
    webhookId: webhook.id,
    event,
    status: 'retrying',
    attempts: 0,
    statusCode: null,
    nextRetryAt: dueAt,
    deliveredAt: null,
  };
  db.table<DeliveryRow>('webhookDeliveries').insert(row);
  return row;
}

function toDeliveryWire(row: DeliveryRow): WebhookDelivery {
  const { merchantId: _m, failUntilAttempts: _f, _failedNotified: _n, ...rest } = row;
  return rest;
}

const VALID_EVENTS = new Set([
  'order.updated',
  'order.created',
  'payment.captured',
  'notification.created',
  'chat.message',
  'campaign.updated',
  'ledger.updated',
  'settlement.created',
  'merchant.updated',
  'task.updated',
]);

const WEBHOOK_STATUSES: readonly WebhookSubscription['status'][] = ['active', 'disabled', 'failing'];

/* P8b event types are appended to types.ts only (shared with a parallel agent);
 * ServerEvent's union lives mid-file, so p8b events cross the bus via the
 * common base event type. */
function p8bEmit(event: P8bEvent) {
  emit(event as unknown as ServerEvent);
}

/** Never leak the secret — responses return the contract shape only. */
function toWire(row: WebhookRow): WebhookSubscription {
  const { merchantId: _m, secret: _s, _consecutiveFailures: _c, ...rest } = row;
  return rest;
}

function newSecret(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `whsec_${crypto.randomUUID()}`.replace(/-/g, '');
  }
  return `whsec_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

function webhookRows(session: Session): WebhookRow[] {
  return db.table<WebhookRow>('webhooks').where((w) => w.merchantId === session.merchantId);
}

function requireWebhook(session: Session, webhookId: string): WebhookRow {
  const row = webhookRows(session).find((w) => w.id === webhookId);
  if (!row) throw new ApiHttpError(404, 'WEBHOOK_NOT_FOUND', 'Webhook subscription not found');
  return row;
}

function assertWebhookBody(body: Partial<UpdateWebhookSubscriptionBody>): { url: string; events: string[] } {
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url || !/^https?:\/\/.+/.test(url)) {
    throw new ApiHttpError(400, 'WEBHOOK_URL_INVALID', 'url must be a valid http(s) URL');
  }
  if (!Array.isArray(body.events) || body.events.length === 0) {
    throw new ApiHttpError(400, 'WEBHOOK_EVENT_INVALID', 'events must be a non-empty array');
  }
  for (const e of body.events) {
    if (typeof e !== 'string' || !VALID_EVENTS.has(e)) {
      throw new ApiHttpError(400, 'WEBHOOK_EVENT_INVALID', `Unsupported webhook event: ${String(e)}`);
    }
  }
  return { url, events: [...new Set(body.events)] };
}

function stripMerchant<T extends { merchantId: string }>(row: T): Omit<T, 'merchantId'> {
  const { merchantId: _m, ...rest } = row;
  return rest;
}

export const webhookHandlers = [
  /* ---- Webhook subscriptions ---- */

  h.get('/api/webhooks', ({ request }) => {
    const session = requireSession(request);
    const rows = webhookRows(session).sort((a, b) => b.createdAt - a.createdAt);
    return raw(rows.map(toWire));
  }),

  h.post('/api/webhooks', async ({ request }) => {
    const session = requireSession(request);
    const body = (await readJson(request)) as Partial<UpdateWebhookSubscriptionBody>;
    const { url, events } = assertWebhookBody(body);
    const status = WEBHOOK_STATUSES.includes(body.status as WebhookSubscription['status'])
      ? (body.status as WebhookSubscription['status'])
      : 'active';
    const row: WebhookRow = {
      id: uid('wh'),
      merchantId: session.merchantId,
      url,
      events,
      secret: newSecret(),
      status,
      lastDeliveryAt: null,
      createdAt: Date.now(),
    };
    db.table<WebhookRow>('webhooks').insert(row);
    p8bEmit({ type: 'webhooks.created', webhook: toWire(row), at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'webhooks:create', 'webhook', row.id, `created ${url} (${events.length} event(s))`);
    /* Delivery engine: enqueue a first delivery so retry/backoff progress is
     * visible on the deliveries screen right away (IW L46). */
    enqueueDelivery(row, events[0], Date.now());
    return raw(toWire(row), 201);
  }),

  h.patch('/api/webhooks/:webhookId', async ({ request, params }) => {
    const session = requireSession(request);
    const row = requireWebhook(session, String(params.webhookId));
    const body = (await readJson(request)) as Partial<UpdateWebhookSubscriptionBody>;
    const patch: Partial<WebhookRow> = {};
    if (body.url !== undefined || body.events !== undefined) {
      const { url, events } = assertWebhookBody(body);
      patch.url = url;
      patch.events = events;
    }
    if (body.status !== undefined) {
      if (!WEBHOOK_STATUSES.includes(body.status)) {
        throw new ApiHttpError(400, 'WEBHOOK_STATUS_INVALID', 'status must be active, disabled or failing');
      }
      patch.status = body.status;
      /* Re-enable (IW L48) resets the consecutive-failure counter. */
      if (body.status === 'active') patch._consecutiveFailures = 0;
    }
    if (body.rotateSecret === true) patch.secret = newSecret();
    if (Object.keys(patch).length === 0) {
      throw new ApiHttpError(400, 'BAD_REQUEST', 'Nothing to update');
    }
    const updated = db.table<WebhookRow>('webhooks').update(row.id, patch)!;
    p8bEmit({ type: 'webhooks.updated', webhook: toWire(updated), at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'webhooks:update', 'webhook', row.id, `updated ${Object.keys(patch).join(', ')}`);
    return ok(toWire(updated));
  }),

  del('/api/webhooks/:webhookId', ({ request, params }) => {
    const session = requireSession(request);
    const row = requireWebhook(session, String(params.webhookId));
    db.table<WebhookRow>('webhooks').remove(row.id);
    p8bEmit({ type: 'webhooks.deleted', webhookId: row.id, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'webhooks:delete', 'webhook', row.id, `deleted ${row.url}`);
    return noContent();
  }),

  h.get('/api/webhooks/deliveries', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const webhookId = url.searchParams.get('webhookId');
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20));
    let rows = db.table<DeliveryRow>('webhookDeliveries').where((d) => d.merchantId === session.merchantId);
    if (webhookId) rows = rows.filter((d) => d.webhookId === webhookId);
    const list = rows
      .sort((a, b) => (b.deliveredAt ?? b.nextRetryAt ?? 0) - (a.deliveredAt ?? a.nextRetryAt ?? 0))
      .slice(0, limit)
      .map(toDeliveryWire);
    return raw(list);
  }),

  /* Test delivery (mock extension, IW L48 "test" action): enqueue a delivery
   * and attempt it synchronously. A failed test surfaces WEBHOOK_DELIVERY_FAILED. */
  h.post('/api/webhooks/:webhookId/test', ({ request, params }) => {
    const session = requireSession(request);
    const row = requireWebhook(session, String(params.webhookId));
    if (row.status === 'disabled') {
      throw new ApiHttpError(400, 'WEBHOOK_STATUS_INVALID', 'A disabled webhook cannot be tested — re-enable it first');
    }
    const delivery = enqueueDelivery(row, row.events[0] ?? 'order.created', Date.now());
    const next = attemptDelivery(delivery, Date.now());
    if (next.status === 'failed') {
      throw new ApiHttpError(400, 'WEBHOOK_DELIVERY_FAILED', `Test delivery to ${row.url} failed after ${next.attempts} attempt(s)`);
    }
    return ok(toDeliveryWire(next));
  }),

  /* ---- Integrations registry ---- */

  h.get('/api/integrations', ({ request }) => {
    const session = requireSession(request);
    const rows = db
      .table<IntegrationRow>('integrations')
      .where((i) => i.merchantId === session.merchantId)
      .sort((a, b) => a.provider.localeCompare(b.provider));
    return raw(rows.map(stripMerchant));
  }),

  h.post('/api/integrations/:integrationId/disconnect', async ({ request, params }) => {
    const session = requireSession(request);
    const body = await readJson(request);
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) throw new ApiHttpError(400, 'INTEGRATION_REASON_REQUIRED', 'reason is required to disconnect');
    if (reason.length > 500) throw new ApiHttpError(400, 'INTEGRATION_REASON_REQUIRED', 'reason must be at most 500 characters');
    const row = db
      .table<IntegrationRow>('integrations')
      .where((i) => i.merchantId === session.merchantId)
      .find((i) => i.id === String(params.integrationId));
    if (!row) throw new ApiHttpError(404, 'INTEGRATION_NOT_FOUND', 'Integration not found');
    if (row.status === 'disconnected') {
      throw new ApiHttpError(409, 'INTEGRATION_DISCONNECTED', 'Integration is already disconnected');
    }
    const updated = db
      .table<IntegrationRow>('integrations')
      .update(row.id, { status: 'disconnected' as IntegrationStatus, lastSyncedAt: null })!;
    p8bEmit({ type: 'integrations.disconnected', integration: stripMerchant(updated), at: Date.now() });
    /* IW L20 — the owner gets the integration.disconnected in-app notification. */
    notify(session.merchantId, 'Integration disconnected', `${row.label} was disconnected: ${reason}`);
    audit(session.merchantId, session.staffId, session.role, 'integrations:disconnect', 'integration', row.id, `disconnected ${row.provider} (${reason})`);
    return noContent();
  }),
];
