import { http } from 'msw';
import type { OrderDto, Staff } from '@/api/types';
import { db } from '@/mock/db';
import { emit } from '@/mock/events';
import { ApiHttpError, audit, errorEnvelope, json, requireSession } from '@/mock/security';
import type { Session } from '@/mock/types-internal';

/* Wrap MSW handlers so domain errors (ApiHttpError) become proper
 * JSON error responses instead of unhandled exceptions (which MSW
 * surfaces as 500s). Equivalent to an API gateway error filter.
 * The envelope carries both the legacy `{error:{...}}` shape and the
 * contract top-level fields (code/message/requestId/retryAfterSeconds). */
type HandlerFn = (args: { request: Request; params: Record<string, string> }) => Promise<Response> | Response;

function wrap(fn: HandlerFn) {
  return async (info: { request: Request; params?: Record<string, unknown> }) => {
    try {
      return await fn({
        request: info.request,
        params: (info.params ?? {}) as Record<string, string>,
      });
    } catch (e) {
      if (e instanceof ApiHttpError) {
        return json(e.status, errorEnvelope(e));
      }
      throw e;
    }
  };
}

/** Base origin for handler registration.
 *  Browser: the current page origin (handlers are origin-scoped there).
 *  Node (contract tests): http://localhost. */
const BASE = typeof location !== 'undefined' ? location.origin : 'http://localhost';

const absolute = (path: string) => `${BASE}${path}`;

export const h = {
  get: (path: string, fn: HandlerFn) => http.get(absolute(path), wrap(fn)),
  post: (path: string, fn: HandlerFn) => http.post(absolute(path), wrap(fn)),
  patch: (path: string, fn: HandlerFn) => http.patch(absolute(path), wrap(fn)),
};

export const INTERNAL_KEY = 'demo-customer-platform';
export const INTERNAL_ACTOR = 'customer-platform';

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    throw new ApiHttpError(400, 'BAD_REQUEST', 'Invalid JSON body');
  }
}

export function getMerchant(session: Session): string {
  return session.merchantId;
}

/** Service-to-service auth for the (simulated) customer platform. */
export function requireInternal(request: Request): { actor: string; role: string } {
  const key = request.headers.get('x-internal-key');
  if (key !== INTERNAL_KEY) {
    throw new ApiHttpError(403, 'FORBIDDEN', 'Internal call rejected');
  }
  return { actor: INTERNAL_ACTOR, role: 'system' };
}

export function merchantSession(request: Request): Session & { merchantId: string } {
  return requireSession(request);
}

/* ---------------- Idempotency ---------------- */

const idemStore = new Map<string, { payload: unknown; at: number }>();
const IDEM_TTL = 3600 * 1000;

export function idemKey(request: Request): string {
  const k = request.headers.get('idempotency-key');
  if (!k) throw new ApiHttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required for this mutation');
  return k;
}

export function idemGet(namespace: string, key: string): unknown | undefined {
  const hit = idemStore.get(`${namespace}:${key}`);
  if (hit && hit.at > Date.now() - IDEM_TTL) return hit.payload;
  return undefined;
}

export function idemSet(namespace: string, key: string, payload: unknown) {
  idemStore.set(`${namespace}:${key}`, { payload, at: Date.now() });
  if (idemStore.size > 500) {
    const now = Date.now();
    for (const [k, v] of idemStore) {
      if (v.at < now - IDEM_TTL) idemStore.delete(k);
    }
  }
}

/* ---------------- Order state machine ---------------- */

export type OrderStatus = OrderDto['status'];

const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  new: ['merchant_accepted', 'preparing', 'cancelled'],
  merchant_accepted: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  refunded: [],
  failed: [],
  disputed: [],
};

export function assertTransition(order: OrderDto, to: OrderStatus) {
  if (order.status === to) return; // idempotent replay
  if (!TRANSITIONS[order.status]?.includes(to)) {
    throw new ApiHttpError(
      409,
      'INVALID_TRANSITION',
      `Cannot move order ${order.no} from ${order.status} to ${to} (state machine)`,
    );
  }
}

export function applyTransition(
  order: OrderDto,
  to: OrderStatus,
  actor: string,
  extra: Partial<OrderDto> = {},
  timelineEvent?: string,
): OrderDto {
  assertTransition(order, to);
  const timeline = [
    ...(order.timeline ?? []),
    ...(timelineEvent ? [{ event: timelineEvent, ts: Date.now(), actor }] : []),
  ];
  const updated = db
    .table<OrderDto>('orders')
    .update(order.id, { ...extra, status: to, version: order.version + 1, timeline })!;
  emit({ type: 'order.updated', order: updated, at: Date.now() });
  return updated;
}

export function auditStaff(session: Session, staff: Staff, action: string, resource: string, resourceId: string, detail: string) {
  audit(session.merchantId, staff.id, staff.role, action, resource, resourceId, detail);
}

export function ok(body: unknown, init?: { status?: number }) {
  return json(init?.status ?? 200, body);
}

export { ApiHttpError, json };
