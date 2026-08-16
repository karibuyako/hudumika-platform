import type {
  ActivitySubmission,
  P8bEvent,
  ServerEvent,
  SetupStep,
  SubmitActivityBody,
  TaskItem,
  TaskKind,
  TaskStatus,
  UpdateTaskStatusBody,
} from '@/api/types';
import { db, uid } from '@/mock/db';
import { emit } from '@/mock/events';
import { ApiHttpError, h, readJson } from '@/mock/handlers/common';
import { audit, ok, requireSession } from '@/mock/security';
import type { Session } from '@/mock/types-internal';

/* P8b tasks center (contract /tasks/*): task detail + status updates,
 * product anomalies, store violations, activity submissions, setup guide.
 * Rows are merchant-scoped server-side. */

type TaskRow = TaskItem & { merchantId: string };
type ActivityRow = ActivitySubmission & { merchantId: string };
type SetupStepRow = SetupStep & { merchantId: string };

/** Raw JSON body — the shared `ok()` spreads objects, so arrays go through here. */
const raw = (body: unknown, status = 200) => Response.json(body, { status });

const TASK_KINDS: readonly TaskKind[] = ['anomaly', 'violation', 'activity', 'setup'];
const TASK_STATUSES: readonly TaskStatus[] = ['open', 'in_progress', 'done', 'dismissed'];

/* P8b event types are appended to types.ts only (shared with a parallel agent);
 * ServerEvent's union lives mid-file, so p8b events cross the bus via the
 * common base event type. */
function p8bEmit(event: P8bEvent) {
  emit(event as unknown as ServerEvent);
}

function stripMerchant<T extends { merchantId: string }>(row: T): Omit<T, 'merchantId'> {
  const { merchantId: _m, ...rest } = row;
  return rest;
}

function taskRows(session: Session): TaskRow[] {
  return db.table<TaskRow>('taskItems').where((t) => t.merchantId === session.merchantId);
}

function requireTask(session: Session, taskId: string): TaskRow {
  const row = taskRows(session).find((t) => t.id === taskId);
  if (!row) throw new ApiHttpError(404, 'TASK_NOT_FOUND', 'Task not found');
  return row;
}

function assertTaskStatus(status: unknown): TaskStatus {
  if (typeof status !== 'string' || !TASK_STATUSES.includes(status as TaskStatus)) {
    throw new ApiHttpError(400, 'TASK_STATUS_INVALID', 'status must be open, in_progress, done or dismissed');
  }
  return status as TaskStatus;
}

function setupGuide(session: Session): SetupStep[] {
  return db
    .table<SetupStepRow>('setupSteps')
    .where((s) => s.merchantId === session.merchantId)
    .sort((a, b) => a.order - b.order)
    .map(stripMerchant);
}

/* Sub-paths must be registered before /tasks/:taskId so the wildcard never
 * swallows anomalies/violations/activities/setup-guide. */
export const taskHandlers = [
  /* ---- Product anomalies / store violations ---- */

  h.get('/api/tasks/anomalies', ({ request }) => {
    const session = requireSession(request);
    const rows = taskRows(session).filter((t) => t.kind === 'anomaly');
    return raw(rows.map(stripMerchant));
  }),

  h.get('/api/tasks/violations', ({ request }) => {
    const session = requireSession(request);
    const rows = taskRows(session).filter((t) => t.kind === 'violation');
    return raw(rows.map(stripMerchant));
  }),

  /* ---- Activity submissions ---- */

  h.get('/api/tasks/activities', ({ request }) => {
    const session = requireSession(request);
    const rows = db
      .table<ActivityRow>('taskActivities')
      .where((a) => a.merchantId === session.merchantId)
      .sort((a, b) => b.submittedAt - a.submittedAt);
    return raw(rows.map(stripMerchant));
  }),

  h.post('/api/tasks/activities', async ({ request }) => {
    const session = requireSession(request);
    const body = (await readJson(request)) as Partial<SubmitActivityBody>;
    const platformEventId = typeof body.platformEventId === 'string' ? body.platformEventId.trim() : '';
    if (!platformEventId) {
      throw new ApiHttpError(400, 'ACTIVITY_PLATFORM_EVENT_REQUIRED', 'platformEventId is required');
    }
    const existing = db
      .table<ActivityRow>('taskActivities')
      .where((a) => a.merchantId === session.merchantId)
      .find((a) => a.platformEventId === platformEventId);
    if (existing) {
      throw new ApiHttpError(409, 'ACTIVITY_ALREADY_SUBMITTED', 'This platform activity was already submitted');
    }
    const status: ActivitySubmission['status'] =
      body.status === 'approved' || body.status === 'rejected' ? body.status : 'submitted';
    const row: ActivityRow = {
      id: uid('act'),
      merchantId: session.merchantId,
      platformEventId,
      status,
      submittedAt: Date.now(),
    };
    db.table<ActivityRow>('taskActivities').insert(row);
    p8bEmit({ type: 'tasks.activity_submitted', submission: stripMerchant(row), at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'tasks:activity', 'activity', row.id, `submitted platform activity ${platformEventId}`);
    return raw(stripMerchant(row), 201);
  }),

  /* ---- Setup guide ---- */

  h.get('/api/tasks/setup-guide', ({ request }) => {
    const session = requireSession(request);
    return raw(setupGuide(session));
  }),

  h.post('/api/tasks/setup-guide/:stepId/complete', ({ request, params }) => {
    const session = requireSession(request);
    const step = db
      .table<SetupStepRow>('setupSteps')
      .where((s) => s.merchantId === session.merchantId)
      .find((s) => s.id === String(params.stepId));
    if (!step) throw new ApiHttpError(404, 'SETUP_STEP_NOT_FOUND', 'Setup step not found');
    if (step.completed) {
      throw new ApiHttpError(409, 'SETUP_STEP_ALREADY_COMPLETE', 'Setup step is already complete');
    }
    db.table<SetupStepRow>('setupSteps').update(step.id, { completed: true });
    const steps = setupGuide(session);
    p8bEmit({ type: 'tasks.setup_step_completed', stepId: step.id, steps, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'tasks:setup', 'setup-step', step.id, `completed setup step "${step.title}"`);
    return raw(steps);
  }),

  /* ---- Task detail + status (wildcards last) ---- */

  h.get('/api/tasks/:taskId', ({ request, params }) => {
    const session = requireSession(request);
    return ok(stripMerchant(requireTask(session, String(params.taskId))));
  }),

  h.patch('/api/tasks/:taskId', async ({ request, params }) => {
    const session = requireSession(request);
    const row = requireTask(session, String(params.taskId));
    const body = (await readJson(request)) as Partial<UpdateTaskStatusBody>;
    if (body.status === undefined) {
      throw new ApiHttpError(400, 'TASK_STATUS_REQUIRED', 'status is required');
    }
    const status = assertTaskStatus(body.status);
    const note = typeof body.note === 'string' ? body.note.trim() : undefined;
    if (note !== undefined && note.length > 500) {
      throw new ApiHttpError(400, 'TASK_NOTE_TOO_LONG', 'note must be at most 500 characters');
    }
    const patch: Partial<TaskRow> = { status };
    if (note) patch.description = note;
    const updated = db.table<TaskRow>('taskItems').update(row.id, patch)!;
    p8bEmit({ type: 'tasks.updated', task: stripMerchant(updated), at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'tasks:update', 'task', row.id, `set "${row.title}" to ${status}`);
    return ok(stripMerchant(updated));
  }),
];

export const TASK_KIND_SET: readonly TaskKind[] = TASK_KINDS;
export const TASK_STATUS_SET: readonly TaskStatus[] = TASK_STATUSES;
