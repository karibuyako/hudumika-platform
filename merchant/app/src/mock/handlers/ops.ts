
import type { AuditLog, Experiment, SupportTicket, TaskDto } from '@/api/types';
import { db, uid } from '@/mock/db';
import { emit } from '@/mock/events';
import { audit, json, ok, requirePerm, requireSession } from '@/mock/security';
import { ApiHttpError, h, idemGet, idemKey, idemSet, readJson } from '@/mock/handlers/common';
import type {
  AccountDeletionStatus,
  P10ExtEvent,
  PrivacyExportJob,
  ServerEvent,
} from '@/api/types';

const p10Emit = (event: P10ExtEvent) => emit(event as unknown as ServerEvent);

/* Async privacy-export jobs (POST /privacy/export → GET /privacy/export/{jobId}) —
 * module-level so the queued → processing → ready lifecycle survives calls. */
const privacyExportJobs = new Map<string, PrivacyExportJob & { merchantId: string }>();

function privacyJobDto(job: PrivacyExportJob & { merchantId: string }): PrivacyExportJob {
  return {
    jobId: job.jobId,
    status: job.status,
    downloadUrl: job.downloadUrl,
    expiresInSeconds: job.expiresInSeconds,
    completedAt: job.completedAt,
  };
}

export const opsHandlers = [
  /* ---- Store settings ---- */
  h.patch('/api/store', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const body = await readJson(request);
    const store = db.table<import('@/api/types').StoreServer>('stores').find('s_demo');
    if (!store) throw new ApiHttpError(404, 'NOT_FOUND', 'Store not found');
    const patch: Record<string, unknown> = {};
    for (const key of [
      'name', 'category', 'phone', 'address', 'description', 'bannerColor',
      'featuredProductIds', 'open', 'hours', 'deliveryRadiusKm', 'deliveryFee',
      'minOrder', 'orderSettings', 'decoration', 'promotion',
      'announcement', 'coverImage', 'deliveryEtaMin', 'pickupReadyMinutes',
      'scheduledReopenAt', 'freeDeliveryThreshold', 'receiptTemplateId',
      'paymentMethods', 'dualScreen', 'qrOrdering',
    ] as const) {
      if (body[key] !== undefined) {
        const existing = (store as unknown as Record<string, unknown>)[key];
        if (typeof existing === 'object' && existing !== null && !Array.isArray(existing) && typeof body[key] === 'object') {
          patch[key] = { ...(existing as Record<string, unknown>), ...(body[key] as Record<string, unknown>) };
        } else {
          patch[key] = body[key];
        }
      }
    }
    if (patch.freeDeliveryThreshold !== undefined) patch.freeDeliveryThreshold = Math.max(0, Number(patch.freeDeliveryThreshold));
    const updated = db.table<import('@/api/types').StoreServer>('stores').update(store.id, patch as Partial<import('@/api/types').StoreServer>)!;
    audit(session.merchantId, session.staffId, session.role, 'store:update', 'store', store.id, `updated store settings (${Object.keys(patch).join(', ')})`);
    emit({ type: 'merchant.updated', store: updated, at: Date.now() });
    return ok({ store: updated });
  }),

  /* ---- Tasks (server-computed business guidance) ---- */
  h.get('/api/tasks', ({ request }) => {
    const session = requireSession(request);
    const tasks = db.table<TaskDto>('tasks').where((t) => t.merchantId === session.merchantId);
    return ok({ tasks });
  }),

  h.post('/api/tasks/:id/complete', async ({ request, params }) => {
    const session = requireSession(request);
    const t = db.table<TaskDto>('tasks').find(String(params.id));
    if (!t || t.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Task not found');
    if (t.done) return ok({ task: t });
    const updated = db.table<TaskDto>('tasks').update(t.id, { done: true })!;
    emit({ type: 'task.updated', task: updated, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'tasks:complete', 'task', t.id, `completed "${t.title}"`);
    return ok({ task: updated });
  }),

  /* ---- Support tickets ---- */
  h.get('/api/support/tickets', ({ request }) => {
    const session = requireSession(request);
    const list = db.table<SupportTicket>('supportTickets').where((t) => t.merchantId === session.merchantId).sort((a, b) => b.updatedAt - a.updatedAt);
    return ok({ tickets: list });
  }),

  h.post('/api/support/tickets', async ({ request }) => {
    const session = requireSession(request);
    const body = await readJson(request);
    const subject = String(body.subject ?? '').trim();
    const text = String(body.body ?? '').trim();
    if (!subject || !text) throw new ApiHttpError(400, 'EMPTY_TICKET', 'Subject and description are required');
    const ticket: SupportTicket = {
      id: uid('tkt'),
      merchantId: session.merchantId,
      subject,
      body: text,
      status: 'open',
      replies: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    db.table<SupportTicket>('supportTickets').insert(ticket);
    audit(session.merchantId, session.staffId, session.role, 'support:create', 'ticket', ticket.id, `opened ticket "${subject}"`);
    return ok({ ticket });
  }),

  /* ---- Audit trail (owner/manager only) ---- */
  h.get('/api/audit', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'audit:view');
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const from = Number(url.searchParams.get('from') ?? 0);
    const limit = Math.min(300, Number(url.searchParams.get('limit') ?? 100));
    let rows = db.table<AuditLog>('auditLogs').where((a) => a.merchantId === session.merchantId && a.ts >= from);
    if (action) rows = rows.filter((a) => a.action === action);
    return ok({ logs: [...rows].sort((a, b) => b.ts - a.ts).slice(0, limit) });
  }),

  /* ---- Experiments (A/B config for the merchant app) ---- */
  h.get('/api/experiments', ({ request }) => {
    requireSession(request);
    const url = new URL(request.url);
    const keys = (url.searchParams.get('keys') ?? '').split(',').filter(Boolean);
    let list = db.table<Experiment>('experiments').all();
    if (keys.length) list = list.filter((e) => keys.includes(e.key));
    return ok({ experiments: list });
  }),

  /* ---- Riders / logistics ---- */
  h.get('/api/riders', ({ request }) => {
    requireSession(request);
    return ok({ riders: db.table('riders').all() });
  }),

  /* ---- Monitoring & health ---- */
  h.get('/api/health', () => {
    return ok({ status: 'ok', version: '1.0.0', time: Date.now() });
  }),

  h.post('/api/monitoring/errors', async ({ request }) => {
    requireSession(request);
    const body = await readJson(request);
    db.table('errorReports').insert({
      id: uid('err'),
      message: String(body.message ?? '').slice(0, 500),
      stack: String(body.stack ?? '').slice(0, 2000),
      route: String(body.route ?? ''),
      ts: Date.now(),
    });
    return ok({ accepted: true });
  }),

  /* ---- Events stream (long-poll; near real-time) ---- */
  h.get('/api/events', async ({ request }) => {
    requireSession(request);
    const url = new URL(request.url);
    const after = Number(url.searchParams.get('after') ?? 0);
    const { eventsAfter } = await import('@/mock/events');
    const { latestSeq } = await import('@/mock/events');
    const tail = eventsAfter(after);
    if (tail.length) {
      return ok({ seq: latestSeq(), events: tail.map((e) => e.event) });
    }
    // Hold the request briefly (long-poll) so new events arrive promptly.
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const again = eventsAfter(after);
      if (again.length) {
        return ok({ seq: latestSeq(), events: again.map((e) => e.event) });
      }
      await new Promise((r) => setTimeout(r, 800));
    }
    return ok({ seq: latestSeq(), events: [] });
  }),

  /* ---- Privacy (PIPL-style data export & erasure) ---- */
  h.get('/api/privacy/export', ({ request }) => {
    const session = requireSession(request);
    const m = session.merchantId;
    const data = {
      merchant: db.table('merchants').find(m),
      store: db.table('stores').find('s_demo'),
      staff: db.table('staff').where((s) => s.merchantId === m),
      orders: db.table('orders').where((o) => o.merchantId === m).slice(0, 100),
      ledger: db.table('ledger').where((e) => e.merchantId === m).slice(0, 100),
      notifications: db.table('notifications').where((n) => n.merchantId === m),
    };
    audit(m, session.staffId, session.role, 'privacy:export', 'merchant', m, 'merchant requested data export');
    return ok({ exportedAt: Date.now(), data });
  }),

  /* ---- Privacy: account deletion with cooling-off (PRIVACY-ACCOUNT.md:26-32).
   * Requires confirmation "DELETE" (exact) + optional reason; returns a 30-day
   * pending request. Cancellation is a support-ticket flow (audited). ---- */
  h.post('/api/privacy/delete', async ({ request }) => {
    const session = requireSession(request);
    const body = await readJson(request);
    if (String(body.confirmation ?? '') !== 'DELETE') {
      throw new ApiHttpError(400, 'ACCOUNT_DELETION_INVALID_CONFIRMATION', 'Type DELETE to confirm account deletion');
    }
    const m = session.merchantId;
    const merchant = db.table('merchants').find(m)!;
    if (merchant.deletionPending) {
      return ok(merchant.deletionPending as AccountDeletionStatus);
    }
    const requestedAt = Date.now();
    const deletion: AccountDeletionStatus = {
      requestId: uid('del'),
      status: 'pending',
      estimatedDays: 30,
      requestedAt,
      completesAt: requestedAt + 30 * 86400000,
      reason: body.reason ? String(body.reason).slice(0, 500) : null,
    };
    db.table('merchants').update(m, { deletionPending: deletion });
    p10Emit({ type: 'privacy.deletion_requested', request: deletion, at: requestedAt });
    audit(m, session.staffId, session.role, 'privacy:delete', 'merchant', m, `deletion requested (${deletion.requestId}) — 30-day cooling-off`);
    return ok(deletion);
  }),

  /* ---- Privacy: pending deletion status (mock extension for the cooling-off
   * banner — the contract surfaces cancellation via support tickets). ---- */
  h.get('/api/privacy/delete', ({ request }) => {
    const session = requireSession(request);
    const merchant = db.table('merchants').find(session.merchantId)!;
    return ok({ request: (merchant.deletionPending as AccountDeletionStatus | undefined) ?? null });
  }),

  /* ---- Privacy: async export job (PRIVACY-ACCOUNT.md:18-24).
   * POST /privacy/export → queued (202); GET /privacy/export/{jobId} advances
   * queued → processing → ready with a short-lived download URL. A second
   * concurrent request is blocked with PRIVACY_EXPORT_IN_PROGRESS. ---- */
  h.post('/api/privacy/export', async ({ request }) => {
    const session = requireSession(request);
    const key = idemKey(request);
    const replay = idemGet('privacy-export', key);
    if (replay) return json(202, replay);
    const active = [...privacyExportJobs.values()].find(
      (j) => j.merchantId === session.merchantId && (j.status === 'queued' || j.status === 'processing'),
    );
    if (active) {
      throw new ApiHttpError(409, 'PRIVACY_EXPORT_IN_PROGRESS', 'A privacy export is already in progress');
    }
    const jobId = uid('pex');
    const job: PrivacyExportJob & { merchantId: string } = {
      jobId,
      merchantId: session.merchantId,
      status: 'queued',
      downloadUrl: null,
      expiresInSeconds: null,
      completedAt: null,
    };
    privacyExportJobs.set(jobId, job);
    const wire = { jobId, status: 'queued' as const };
    idemSet('privacy-export', key, wire);
    emit({ type: 'privacy.export_requested', jobId, at: Date.now() } as unknown as ServerEvent);
    audit(session.merchantId, session.staffId, session.role, 'privacy:export', 'merchant', session.merchantId, 'merchant requested personal data export');
    return json(202, wire);
  }),

  h.get('/api/privacy/export/:jobId', ({ request, params }) => {
    requireSession(request);
    const job = privacyExportJobs.get(String(params.jobId));
    if (!job) throw new ApiHttpError(404, 'NOT_FOUND', 'Export job not found');
    if (job.status === 'queued') {
      job.status = 'processing';
    } else if (job.status === 'processing') {
      job.status = 'ready';
      job.downloadUrl = `https://cdn.example.com/exports/${job.jobId}.json`;
      job.expiresInSeconds = 900;
      job.completedAt = Date.now();
      p10Emit({ type: 'privacy.export_ready', job: privacyJobDto(job), at: Date.now() });
    }
    return ok(privacyJobDto(job));
  }),

  /* ---- Drift-D alias: contract GET /audit/me ≡ GET /audit (same payload;
   * docs/CONTRACT-ADDITIONS.md "Resolution status"). ---- */
  h.get('/api/audit/me', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'audit:view');
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const from = Number(url.searchParams.get('from') ?? 0);
    const limit = Math.min(300, Number(url.searchParams.get('limit') ?? 100));
    let rows = db.table<AuditLog>('auditLogs').where((a) => a.merchantId === session.merchantId && a.ts >= from);
    if (action) rows = rows.filter((a) => a.action === action);
    return ok({ logs: [...rows].sort((a, b) => b.ts - a.ts).slice(0, limit) });
  }),
];
