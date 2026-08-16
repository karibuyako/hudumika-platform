import type {
  CustomerJourney,
  CustomerJourneyInput,
  DataExportJob,
  P8cEvent,
  PrivacyExportResult,
  ScheduledReport,
  ScheduledReportInput,
  ServerEvent,
  UpdateScheduledReportBody,
} from '@/api/types';
import { http } from 'msw';
import { db, uid } from '@/mock/db';
import { emit } from '@/mock/events';
import { ApiHttpError, h, idemGet, idemKey, idemSet, ok, readJson } from '@/mock/handlers/common';
import { audit, json, requireSession } from '@/mock/security';
import type { Session } from '@/mock/types-internal';

/* P8c scheduled reports + CRM journeys + enterprise data exports
 * (contract /reports, /journeys, /data/exports, /privacy/export).
 * Rows are merchant-scoped; every mutation is audited; exports are async
 * (queued → processing → ready) like the provider capture flow. */

const REPORT_TYPES = new Set(['revenue', 'orders', 'products', 'traffic', 'inventory', 'financial']);
const CADENCES = new Set(['daily', 'weekly', 'monthly']);
const FORMATS = new Set(['csv', 'xlsx', 'pdf']);
const JOURNEY_STATUSES = new Set(['draft', 'active', 'paused']);
const ACTION_TYPES = new Set(['push', 'sms', 'coupon', 'email']);
const EXPORT_SCOPES = new Set(['all', 'orders', 'customers', 'catalogue', 'financial']);
const EXPORT_FORMATS = new Set(['csv', 'xlsx', 'json']);

/** Documented journey triggers (CRM.md) — anything else is JOURNEY_TRIGGER_INVALID. */
const JOURNEY_TRIGGERS = new Set([
  'order.completed',
  'order.placed',
  'order.cancelled',
  'first_order',
  'loyalty.tier_up',
  'review.rated',
  'customer.inactive',
]);

/* P8c event types live in types.ts (appended, shared); ServerEvent's union is
 * fixed mid-file, so p8c events cross the bus via the common base event type. */
function p8cEmit(event: P8cEvent) {
  emit(event as unknown as ServerEvent);
}

const noContent = () => new Response(null, { status: 204 });

/** Top-level-array responses — the shared ok() spreads bodies, which mangles arrays. */
const okArray = (value: unknown[]) => Response.json(value);

const BASE = typeof location !== 'undefined' ? location.origin : 'http://localhost';

/** DELETE wrapper — same error filter as the shared `h` helpers. */
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

type ReportRow = ScheduledReport & { merchantId: string };
type JourneyRow = CustomerJourney & { merchantId: string };
type ExportRow = DataExportJob & { merchantId: string };

const reportsTable = () => db.table<ReportRow>('reports');
const journeysTable = () => db.table<JourneyRow>('journeys');
const exportsTable = () => db.table<ExportRow>('dataExports');

const merchantReports = (session: Session): ReportRow[] => reportsTable().where((r) => r.merchantId === session.merchantId);
const merchantJourneys = (session: Session): JourneyRow[] => journeysTable().where((j) => j.merchantId === session.merchantId);
const merchantExports = (session: Session): ExportRow[] => exportsTable().where((e) => e.merchantId === session.merchantId);

function stripMerchant<T extends { merchantId: string }>(row: T): Omit<T, 'merchantId'> {
  const { merchantId: _m, ...rest } = row;
  return rest;
}

function assertReportBody(body: Record<string, unknown>, partial: boolean): void {
  const pick = (key: string) => body[key] !== undefined;
  if (!partial || pick('name')) {
    const name = String(body.name ?? '');
    if (!name.trim()) throw new ApiHttpError(400, 'NAME_REQUIRED', 'name is required');
    if (name.length > 160) throw new ApiHttpError(400, 'NAME_TOO_LONG', 'name must be at most 160 characters');
  }
  if (!partial || pick('reportType')) {
    if (!REPORT_TYPES.has(String(body.reportType))) {
      throw new ApiHttpError(422, 'REPORT_TYPE_INVALID', 'reportType must be one of revenue, orders, products, traffic, inventory, financial');
    }
  }
  if (!partial || pick('cadence')) {
    if (!CADENCES.has(String(body.cadence))) {
      throw new ApiHttpError(422, 'CADENCE_INVALID', 'cadence must be one of daily, weekly, monthly');
    }
  }
  if (!partial || pick('format')) {
    if (!FORMATS.has(String(body.format))) {
      throw new ApiHttpError(422, 'FORMAT_INVALID', 'format must be one of csv, xlsx, pdf');
    }
  }
  if (body.recipients !== undefined) {
    if (!Array.isArray(body.recipients)) throw new ApiHttpError(422, 'RECIPIENTS_INVALID', 'recipients must be an array of emails');
    for (const r of body.recipients) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(r))) {
        throw new ApiHttpError(422, 'RECIPIENTS_INVALID', `invalid email: ${String(r)}`);
      }
    }
  }
  if (body.storeIds !== undefined && !Array.isArray(body.storeIds)) {
    throw new ApiHttpError(422, 'STORE_IDS_INVALID', 'storeIds must be an array');
  }
}

function assertJourneyBody(body: Record<string, unknown>): void {
  const name = String(body.name ?? '');
  if (!name.trim()) throw new ApiHttpError(400, 'JOURNEY_NAME_REQUIRED', 'name is required');
  if (name.length > 80) throw new ApiHttpError(400, 'JOURNEY_NAME_TOO_LONG', 'name must be at most 80 characters');
  const trigger = String(body.trigger ?? '');
  if (!JOURNEY_TRIGGERS.has(trigger)) {
    throw new ApiHttpError(422, 'JOURNEY_TRIGGER_INVALID', `trigger must be one of: ${[...JOURNEY_TRIGGERS].join(', ')}`);
  }
  if (!Array.isArray(body.actions) || body.actions.length === 0) {
    throw new ApiHttpError(422, 'JOURNEY_ACTIONS_INVALID', 'actions must be a non-empty array');
  }
  for (const a of body.actions as Record<string, unknown>[]) {
    if (!ACTION_TYPES.has(String(a.type))) {
      throw new ApiHttpError(422, 'JOURNEY_ACTION_TYPE_INVALID', 'action type must be one of push, sms, coupon, email');
    }
    if (!Number.isInteger(a.delayHours) || Number(a.delayHours) < 0) {
      throw new ApiHttpError(422, 'JOURNEY_DELAY_INVALID', 'delayHours must be a non-negative integer');
    }
  }
  if (body.status !== undefined && !JOURNEY_STATUSES.has(String(body.status))) {
    throw new ApiHttpError(422, 'JOURNEY_STATUS_INVALID', 'status must be one of draft, active, paused');
  }
}

function assertExportBody(body: Record<string, unknown>): void {
  if (!EXPORT_SCOPES.has(String(body.scope))) {
    throw new ApiHttpError(422, 'EXPORT_SCOPE_INVALID', 'scope must be one of all, orders, customers, catalogue, financial');
  }
  if (!EXPORT_FORMATS.has(String(body.format))) {
    throw new ApiHttpError(422, 'EXPORT_FORMAT_INVALID', 'format must be one of csv, xlsx, json');
  }
}

/** Simulate the async export pipeline (queued → processing → ready with url). */
function scheduleExportCompletion(job: ExportRow): void {
  setTimeout(() => {
    const cur = exportsTable().find(job.id);
    if (!cur) return;
    const processing = exportsTable().update(job.id, { status: 'processing' });
    if (processing) p8cEmit({ type: 'data_exports.updated', job: stripMerchant(processing), at: Date.now() });
    setTimeout(() => {
      const ready = exportsTable().update(job.id, {
        status: 'ready',
        downloadUrl: `data:${job.format === 'json' ? 'application/json' : job.format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv'};charset=utf-8,export-${job.scope}-${job.id}`,
        expiresInSeconds: 900,
        completedAt: Date.now(),
      });
      if (ready) p8cEmit({ type: 'data_exports.updated', job: stripMerchant(ready), at: Date.now() });
    }, 1200);
  }, 600);
}

export const reportHandlers = [
  /* ---- Scheduled reports (contract /reports) ---- */
  h.get('/api/reports', ({ request }) => {
    const session = requireSession(request);
    return okArray(merchantReports(session).map(stripMerchant));
  }),

  h.post('/api/reports', async ({ request }) => {
    const session = requireSession(request);
    const key = idemKey(request);
    const replay = idemGet('report-create', key);
    if (replay) return ok(replay);
    const body = (await readJson(request)) as Partial<ScheduledReportInput>;
    assertReportBody(body as Record<string, unknown>, false);
    const report: ReportRow = {
      id: uid('rep'),
      merchantId: session.merchantId,
      name: String(body.name),
      reportType: body.reportType as ScheduledReport['reportType'],
      cadence: body.cadence as ScheduledReport['cadence'],
      format: body.format as ScheduledReport['format'],
      recipients: Array.isArray(body.recipients) ? body.recipients.map(String) : [],
      filters: body.filters !== undefined ? (body.filters as Record<string, unknown>) : undefined,
      storeIds: Array.isArray(body.storeIds) ? body.storeIds.map(String) : [],
      enabled: body.enabled !== false,
      lastRunAt: null,
    };
    reportsTable().insert(report);
    const wire = stripMerchant(report);
    p8cEmit({ type: 'reports.created', report: wire, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'report:create', 'report', report.id, `created scheduled ${report.cadence} ${report.reportType} report`);
    idemSet('report-create', key, wire);
    return ok(wire, { status: 201 });
  }),

  h.patch('/api/reports/:reportId', async ({ request, params }) => {
    const session = requireSession(request);
    const report = reportsTable().find(String(params.reportId));
    if (!report || report.merchantId !== session.merchantId) {
      throw new ApiHttpError(404, 'NOT_FOUND', 'Report not found');
    }
    const body = (await readJson(request)) as UpdateScheduledReportBody;
    assertReportBody(body as Record<string, unknown>, true);
    const patch: Partial<ReportRow> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.reportType !== undefined) patch.reportType = body.reportType;
    if (body.cadence !== undefined) patch.cadence = body.cadence;
    if (body.format !== undefined) patch.format = body.format;
    if (body.recipients !== undefined) patch.recipients = body.recipients;
    if (body.filters !== undefined) patch.filters = body.filters;
    if (body.storeIds !== undefined) patch.storeIds = body.storeIds;
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    const updated = reportsTable().update(report.id, patch)!;
    const wire = stripMerchant(updated);
    p8cEmit({ type: 'reports.updated', report: wire, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'report:update', 'report', report.id, `updated scheduled ${wire.cadence} ${wire.reportType} report`);
    return ok(wire);
  }),

  del('/api/reports/:reportId', ({ request, params }) => {
    const session = requireSession(request);
    const report = reportsTable().find(String(params.reportId));
    if (!report || report.merchantId !== session.merchantId) {
      throw new ApiHttpError(404, 'NOT_FOUND', 'Report not found');
    }
    reportsTable().remove(report.id);
    p8cEmit({ type: 'reports.deleted', reportId: report.id, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'report:delete', 'report', report.id, 'deleted scheduled report');
    return noContent();
  }),

  /* ---- CRM journeys (contract /journeys) ---- */
  h.get('/api/journeys', ({ request }) => {
    const session = requireSession(request);
    return okArray(merchantJourneys(session).map(stripMerchant));
  }),

  h.post('/api/journeys', async ({ request }) => {
    const session = requireSession(request);
    const key = idemKey(request);
    const replay = idemGet('journey-create', key);
    if (replay) return ok(replay);
    const body = (await readJson(request)) as Partial<CustomerJourneyInput>;
    assertJourneyBody(body as Record<string, unknown>);
    const journey: JourneyRow = {
      id: uid('jrn'),
      merchantId: session.merchantId,
      name: String(body.name),
      trigger: String(body.trigger),
      actions: (body.actions ?? []).map((a) => ({
        type: a.type,
        delayHours: Number(a.delayHours),
        template: a.template,
      })),
      status: (body.status as CustomerJourney['status']) ?? 'draft',
      createdAt: Date.now(),
    };
    journeysTable().insert(journey);
    const wire = stripMerchant(journey);
    p8cEmit({ type: 'journeys.created', journey: wire, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'journey:create', 'journey', journey.id, `created journey "${journey.name}" (${journey.status})`);
    idemSet('journey-create', key, wire);
    return ok(wire, { status: 201 });
  }),

  /* Activate/pause toggle (CRM.md:35 — statuses draft/active/paused). The yaml
   * only defines GET/POST /journeys, so the status-update path is a documented
   * contract gap served at PATCH /journeys/{journeyId}. */
  h.patch('/api/journeys/:journeyId', async ({ request, params }) => {
    const session = requireSession(request);
    const journey = journeysTable().find(String(params.journeyId));
    if (!journey || journey.merchantId !== session.merchantId) {
      throw new ApiHttpError(404, 'NOT_FOUND', 'Journey not found');
    }
    const body = await readJson(request);
    const status = String(body.status ?? '');
    if (!JOURNEY_STATUSES.has(status)) {
      throw new ApiHttpError(422, 'JOURNEY_STATUS_INVALID', 'status must be one of draft, active, paused');
    }
    const updated = journeysTable().update(journey.id, { status: status as JourneyRow['status'] })!;
    const wire = stripMerchant(updated);
    p8cEmit({ type: 'journeys.updated', journey: wire, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'journey:update', 'journey', updated.id, `updated journey "${updated.name}" -> ${updated.status}`);
    return ok(wire);
  }),

  /* ---- Data exports (contract /data/exports) ---- */
  h.get('/api/data/exports', ({ request }) => {
    const session = requireSession(request);
    return okArray(
      merchantExports(session)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(stripMerchant),
    );
  }),

  h.post('/api/data/exports', async ({ request }) => {
    const session = requireSession(request);
    const key = idemKey(request);
    const replay = idemGet('data-export-create', key);
    if (replay) return ok(replay);
    const body = await readJson(request);
    assertExportBody(body);
    const job: ExportRow = {
      id: uid('dex'),
      merchantId: session.merchantId,
      scope: String(body.scope) as ExportRow['scope'],
      format: String(body.format) as ExportRow['format'],
      status: 'queued',
      downloadUrl: null,
      expiresInSeconds: null,
      createdAt: Date.now(),
      completedAt: null,
    };
    exportsTable().insert(job);
    const wire = stripMerchant(job);
    p8cEmit({ type: 'data_exports.created', job: wire, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'data-export:request', 'data-export', job.id, `requested ${job.scope} ${job.format} export`);
    idemSet('data-export-create', key, wire);
    scheduleExportCompletion(job);
    return ok(wire, { status: 202 });
  }),

  /* ---- Privacy export (contract POST /privacy/export — the GET variant in
   * ops.ts is a mock-only shape; the contract POST lives here) ---- */
  h.post('/api/privacy/export', async ({ request }) => {
    const session = requireSession(request);
    const key = idemKey(request);
    const replay = idemGet('privacy-export', key);
    if (replay) return ok(replay);
    const jobId = uid('pex');
    const result: PrivacyExportResult = { jobId, status: 'queued' };
    p8cEmit({ type: 'privacy.export_requested', jobId, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'privacy:export', 'merchant', session.merchantId, 'merchant requested personal data export');
    idemSet('privacy-export', key, result);
    return ok(result, { status: 202 });
  }),
];
