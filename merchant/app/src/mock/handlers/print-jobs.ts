/* Print jobs (contract /print-jobs, /print-jobs/{printJobId}) — P6d.
 * Merchant submits batch print work (receipts, kitchen tickets, labels,
 * vouchers); the queue is server-tracked with the PrintJobStatus enum
 * (queued → printing → done | failed). Money is not involved; id/status/
 * createdAt are server-owned.
 */
import type { MerchantDevice, PrintJob, PrintJobCreate, PrintJobStatus, PrintJobType } from '@/api/types';
import { db, uid } from '@/mock/db';
import { emit } from '@/mock/events';
import { audit, requirePerm, requireSession } from '@/mock/security';
import { ApiHttpError, h, ok, readJson } from '@/mock/handlers/common';

const JOB_TYPES: readonly PrintJobType[] = ['receipt', 'kitchen_ticket', 'label', 'voucher'];
const JOB_STATUSES: readonly PrintJobStatus[] = ['queued', 'printing', 'done', 'failed'];

/* Queue capacity before PRINT_QUEUE_FULL (STAFF-AND-DEVICES.md §59: retry with
 * backoff). Only queued/printing jobs occupy the queue. */
const QUEUE_CAPACITY = 20;

function printJobRows(merchantId: string): (PrintJob & { merchantId: string })[] {
  return db.table<PrintJob & { merchantId: string }>('printJobs').where((j) => j.merchantId === merchantId);
}

function requireJob(merchantId: string, id: string): PrintJob & { merchantId: string } {
  const job = db.table<PrintJob & { merchantId: string }>('printJobs').find(id);
  if (!job || job.merchantId !== merchantId) {
    throw new ApiHttpError(404, 'PRINT_JOB_NOT_FOUND', 'Print job not found');
  }
  return job;
}

/* Device resolution for a print target (STAFF-AND-DEVICES.md §54):
 * stale refs → DEVICE_NOT_FOUND; offline/error/pairing → DEVICE_OFFLINE with
 * queue-until-online or fallback options. */
function requireOnlineDevice(session: { merchantId: string }, deviceId: string | null, queueIfOffline: boolean) {
  if (!deviceId) return;
  const device = db.table<MerchantDevice & { merchantId: string }>('devices').find(deviceId);
  if (!device || device.merchantId !== session.merchantId) {
    throw new ApiHttpError(404, 'DEVICE_NOT_FOUND', 'Print device not found — re-check the device registry');
  }
  if (device.status !== 'online' && !queueIfOffline) {
    throw new ApiHttpError(409, 'DEVICE_OFFLINE', `Device "${device.label}" is ${device.status} — queue until it comes back online or fall back to another printer`, true, {
      deviceId: device.id,
      status: device.status,
      retryAfterSeconds: 30,
      options: ['queue_until_online', 'fallback'],
    });
  }
}

/* Queue capacity gate (STAFF-AND-DEVICES.md §59: PRINT_QUEUE_FULL — retry with
 * backoff). */
function assertQueueSpace(session: { merchantId: string }) {
  const occupied = printJobRows(session.merchantId).filter((j) => j.status === 'queued' || j.status === 'printing').length;
  if (occupied >= QUEUE_CAPACITY) {
    throw new ApiHttpError(409, 'PRINT_QUEUE_FULL', `The print queue is full (${QUEUE_CAPACITY} jobs) — retry after the printer drains it`, true, {
      queued: occupied,
      capacity: QUEUE_CAPACITY,
      retryAfterSeconds: 15,
    });
  }
}

export const printJobsHandlers = [
  /* ---- Create a print job (POST /print-jobs, 201) ---- */
  h.post('/api/print-jobs', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const body = (await readJson(request)) as unknown as PrintJobCreate;
    const jobType = String(body.jobType ?? '');
    if (!JOB_TYPES.includes(jobType as PrintJobType)) {
      throw new ApiHttpError(422, 'VALIDATION_FAILED', 'jobType must be receipt, kitchen_ticket, label or voucher');
    }
    const copies = body.copies === undefined ? 1 : Number(body.copies);
    if (!Number.isInteger(copies) || copies < 1 || copies > 5) {
      throw new ApiHttpError(422, 'VALIDATION_FAILED', 'copies must be between 1 and 5');
    }
    const label = body.label === undefined ? undefined : String(body.label);
    if (label !== undefined && label.length > 80) {
      throw new ApiHttpError(422, 'VALIDATION_FAILED', 'label must be at most 80 characters');
    }
    if (body.orderIds !== undefined && !Array.isArray(body.orderIds)) {
      throw new ApiHttpError(422, 'VALIDATION_FAILED', 'orderIds must be an array of order ids');
    }
    const queueIfOffline = body.queueIfOffline === true;
    const deviceId = body.deviceId === undefined || body.deviceId === null ? null : String(body.deviceId);
    requireOnlineDevice(session, deviceId, queueIfOffline);
    assertQueueSpace(session);
    const now = Date.now();
    const job: PrintJob & { merchantId: string } = {
      id: uid('pj'),
      merchantId: session.merchantId,
      jobType: jobType as PrintJobType,
      orderIds: Array.isArray(body.orderIds) ? (body.orderIds as string[]).map(String) : undefined,
      tableId: body.tableId === undefined || body.tableId === null ? null : String(body.tableId),
      deviceId,
      copies,
      label,
      status: 'queued',
      error: queueIfOffline && deviceId ? 'device offline — queued until the device returns online' : null,
      createdAt: now,
      completedAt: null,
    };
    db.table<PrintJob & { merchantId: string }>('printJobs').insert(job);
    audit(session.merchantId, session.staffId, session.role, 'print-job:create', 'print-job', job.id, `queued ${jobType} print job${label ? ` "${label}"` : ''}`);
    emit({ type: 'print_jobs.created', printJob: job, at: now } as unknown as Parameters<typeof emit>[0]);
    const { merchantId: _m, ...out } = job;
    return ok(out, { status: 201 });
  }),

  /* ---- Print job history (GET /print-jobs, ?status= + ?limit=) ---- */
  h.get('/api/print-jobs', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    if (status !== null && !JOB_STATUSES.includes(status as PrintJobStatus)) {
      throw new ApiHttpError(422, 'VALIDATION_FAILED', 'status must be queued, printing, done or failed');
    }
    const rawLimit = Number(url.searchParams.get('limit') ?? 20);
    const limit = Math.min(Math.max(Number.isInteger(rawLimit) ? rawLimit : 20, 1), 100);
    let rows = printJobRows(session.merchantId);
    if (status) rows = rows.filter((j) => j.status === status);
    rows = rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    return ok(rows.map(({ merchantId: _m, ...job }) => job));
  }),

  /* ---- Print job detail (GET /print-jobs/{printJobId}) ---- */
  h.get('/api/print-jobs/:printJobId', ({ request, params }) => {
    const session = requireSession(request);
    const job = requireJob(session.merchantId, String(params.printJobId));
    const { merchantId: _m, ...out } = job;
    return ok(out);
  }),
];
