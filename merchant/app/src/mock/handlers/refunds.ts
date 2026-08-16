import type { ApprovalRequest, NotificationDto, OrderDto, Payment, Refund, RefundAwaitingApproval, RefundDecisionBody, RefundRequestDto } from '@/api/types';
import { db, uid } from '@/mock/db';
import { emit } from '@/mock/events';
import { audit, ok, requirePerm, requireSession } from '@/mock/security';
import type { Session } from '@/mock/types-internal';
import { ApiHttpError, h, readJson } from '@/mock/handlers/common';

/* Merchant refund request queue (contract GET /refunds,
 * POST /refunds/{refundId}/approve|reject). Rows live in the shared `refunds`
 * table; app statuses requested/approved/declined map onto the contract's
 * pending/approved/rejected. Decisions execute the refund for real (payment
 * state, ledger debit, order.refund, notifications) exactly once.
 *
 * Approval gate (ENTERPRISE-FINANCE.md L49-51, appended — I2 ownership):
 * refunds at/above the merchant's configured threshold bind to the approval
 * engine — approve creates (or finds) a `refund_above_threshold` approval and
 * the refund executes only once `POST /approvals/{approvalId}/decision` set it
 * to approved; otherwise 409 REFUND_AWAITING_APPROVAL. */

const REFUND_STATUS: Record<Refund['status'], RefundRequestDto['status']> = {
  requested: 'pending',
  approved: 'approved',
  declined: 'rejected',
};

/** Merchant threshold from the seed config (table `refundApprovalConfigs`). */
function refundThresholdOf(merchantId: string): number | null {
  const row = db
    .table<{ id: string; merchantId: string; thresholdTZS: number }>('refundApprovalConfigs')
    .where((r) => r.merchantId === merchantId)[0];
  return row?.thresholdTZS ?? null;
}

/** The refund's `refund_above_threshold` approval, if any. */
function refundApprovalOf(merchantId: string, refundId: string): (ApprovalRequest & { merchantId: string }) | undefined {
  return db
    .table<ApprovalRequest & { merchantId: string }>('approvals')
    .where((a) => a.merchantId === merchantId && a.type === 'refund_above_threshold' && a.refId === refundId)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

/** Find the gate approval or create a pending one (EF L49-51); the refund
 *  executes only once this row is `approved`. */
function requireRefundApproval(
  session: Session,
  refund: Refund,
  orderNo: string,
  amount: number,
  thresholdTZS: number,
): ApprovalRequest & { merchantId: string } {
  const existing = refundApprovalOf(session.merchantId, refund.id);
  if (existing) return existing;
  const approval: ApprovalRequest & { merchantId: string } = {
    id: uid('ap'),
    merchantId: session.merchantId,
    type: 'refund_above_threshold',
    refType: 'refund',
    refId: refund.id,
    summary: `Refund TZS ${amount.toLocaleString('en-US')} on order ${orderNo} — at/above the TZS ${thresholdTZS.toLocaleString('en-US')} approval threshold`,
    amountTZS: amount,
    status: 'pending',
    requestedBy: session.staffId,
    decisionBy: null,
    decisionComment: null,
    createdAt: Date.now(),
    decidedAt: null,
  };
  db.table<ApprovalRequest & { merchantId: string }>('approvals').insert(approval);
  notify(
    session.merchantId,
    `Approval requested · refund_above_threshold`,
    `Refund TZS ${amount.toLocaleString('en-US')} on ${orderNo} awaits approval before it can execute.`,
  );
  emit({ type: 'approvals.requested', approval, at: Date.now() } as never);
  return approval;
}

function awaitingApprovalOf(merchantId: string, refundId: string, thresholdTZS: number | null, amountTZS: number): RefundAwaitingApproval | null {
  if (thresholdTZS === null || amountTZS < thresholdTZS) return null;
  const approval = refundApprovalOf(merchantId, refundId);
  if (!approval || approval.status === 'approved') return null;
  return {
    approvalId: approval.id,
    approvalStatus: approval.status === 'rejected' ? 'rejected' : 'pending',
    thresholdTZS,
    amountTZS,
  };
}

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

export function toRefundRequest(r: Refund, order?: OrderDto): RefundRequestDto {
  return {
    id: r.id,
    orderId: r.orderId,
    customerName: order?.customer.name ?? null,
    amountTZS: Math.round(r.amount),
    reason: r.reason,
    status: REFUND_STATUS[r.status] ?? 'pending',
    decisionReason: r.status === 'requested' ? null : (r.reasonCode ?? ''),
    createdAt: r.createdAt ?? r.ts,
    awaitingApproval: awaitingApprovalOf(r.merchantId, r.id, refundThresholdOf(r.merchantId), Math.round(r.amount)),
  };
}

function ownRefund(session: Session, id: string): { refund: Refund; order: OrderDto } {
  const refund = db.table<Refund>('refunds').find(id);
  if (!refund || refund.merchantId !== session.merchantId) {
    throw new ApiHttpError(404, 'REFUND_REQUEST_NOT_FOUND', 'Refund request not found');
  }
  const order = db.table<OrderDto>('orders').find(refund.orderId)!;
  return { refund, order };
}

/** Execute an approved refund for real: payment refund, ledger debit, order state. */
function executeRefund(session: Session, refund: Refund, order: OrderDto) {
  const pay = db.table<Payment>('payments').find(refund.paymentId);
  if (!pay || pay.status !== 'captured') {
    throw new ApiHttpError(409, 'PAYMENT_NOT_CAPTURED', 'Payment was not captured — nothing to refund');
  }
  db.table<Payment>('payments').update(pay.id, {
    status: 'refunded',
    refundedAmount: pay.refundedAmount + refund.amount,
    refunds: [...pay.refunds, refund.id],
  });
  emit({ type: 'payment.captured', payment: { ...pay, status: 'refunded' as const, refunds: [...pay.refunds, refund.id] }, at: Date.now() });
  db.table('ledger').insert({
    id: uid('l'),
    merchantId: session.merchantId,
    type: 'refund',
    amount: -refund.amount,
    title: `Refund ${order.no}`,
    ts: Date.now(),
    status: 'completed',
    refType: 'order',
    refId: order.id,
  });
  db.table<OrderDto>('orders').update(order.id, {
    refund: { ts: refund.createdAt, reason: refund.reason, amount: refund.amount, status: 'approved' },
    version: order.version + 1,
    timeline: [...(order.timeline ?? []), { event: 'refund-approved', ts: Date.now(), actor: session.staffId }],
  });
  db.table('notifications').insert({
    id: uid('n'),
    merchantId: session.merchantId,
    type: 'order',
    title: `Refund approved · ${order.no}`,
    body: `TZS ${refund.amount.toLocaleString('en-US')} returned to the customer's wallet.`,
    ts: Date.now(),
    read: false,
    orderId: order.id,
  });
  /* PAYMENTS.md: `refund.processed` signal (SMS + in-app) on executed refunds. */
  emit({
    type: 'refund.processed',
    refundId: refund.id,
    orderId: order.id,
    amountTZS: Math.round(refund.amount),
    at: Date.now(),
  });
}

export const refundHandlers = [
  /* ---- GET /refunds — refund request queue (contract: bare RefundRequest[]) ---- */
  h.get('/api/refunds', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20)));
    const rows = db
      .table<Refund>('refunds')
      .where((r) => r.merchantId === session.merchantId && (!status || status === 'all' || REFUND_STATUS[r.status] === status))
      .sort((a, b) => (b.createdAt ?? b.ts) - (a.createdAt ?? a.ts))
      .slice(0, limit)
      .map((r) => toRefundRequest(r, db.table<OrderDto>('orders').find(r.orderId)));
    return ok(rows);
  }),

  /* ---- POST /refunds/{refundId}/approve — approve (partial amount allowed) ---- */
  h.post('/api/refunds/:id/approve', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'orders:manage');
    const { refund, order } = ownRefund(session, String(params.id));
    if (refund.status !== 'requested') {
      throw new ApiHttpError(409, 'REFUND_ALREADY_DECIDED', 'This refund request was already decided');
    }
    const body = (await readJson(request)) as unknown as RefundDecisionBody;
    const decisionReason = String(body.reason ?? '').slice(0, 500);
    const partial = Number(body.amountTZS);
    const amount = Number.isInteger(partial) && partial > 0 ? Math.min(partial, Math.round(order.total)) : Math.round(refund.amount);
    /* Approval gate: above the configured threshold the refund binds to the
     * approval engine — it executes only after the approval is approved. */
    const thresholdTZS = refundThresholdOf(session.merchantId);
    if (thresholdTZS !== null && amount >= thresholdTZS) {
      const gateApproval = requireRefundApproval(session, refund, order.no, amount, thresholdTZS);
      if (gateApproval.status !== 'approved') {
        const gateStatus = gateApproval.status === 'rejected' ? 'rejected' : 'pending';
        throw new ApiHttpError(
          409,
          'REFUND_AWAITING_APPROVAL',
          gateStatus === 'rejected'
            ? 'The approval for this refund was rejected — the refund cannot execute'
            : `Refund TZS ${amount.toLocaleString('en-US')} is at/above the TZS ${thresholdTZS.toLocaleString('en-US')} threshold and awaits approval`,
          false,
          {
            approvalId: gateApproval.id,
            approvalStatus: gateStatus,
            thresholdTZS,
            amountTZS: amount,
          },
        );
      }
    }
    const decided: Refund = {
      ...refund,
      status: 'approved',
      amount,
      reason: refund.reason,
      reasonCode: decisionReason || 'MERCHANT_APPROVED',
      decidedBy: session.staffId,
      decidedAt: Date.now(),
    };
    executeRefund(session, decided, order);
    db.table<Refund>('refunds').update(refund.id, decided);
    audit(order.merchantId, session.staffId, session.role, 'orders:refund-decide', 'order', order.id, `approved refund TZS ${amount} on ${order.no}${decisionReason ? ` (${decisionReason})` : ''}`);
    const updated = db.table<Refund>('refunds').find(refund.id)!;
    emit({ type: 'refunds.decided', refund: toRefundRequest(updated, db.table<OrderDto>('orders').find(order.id)), at: Date.now() });
    return ok(toRefundRequest(updated, order));
  }),

  /* ---- POST /refunds/{refundId}/reject ---- */
  h.post('/api/refunds/:id/reject', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'orders:manage');
    const { refund, order } = ownRefund(session, String(params.id));
    if (refund.status !== 'requested') {
      throw new ApiHttpError(409, 'REFUND_ALREADY_DECIDED', 'This refund request was already decided');
    }
    const body = (await readJson(request)) as unknown as RefundDecisionBody;
    const decisionReason = String(body.reason ?? '').slice(0, 500);
    const decided: Refund = {
      ...refund,
      status: 'declined',
      reasonCode: decisionReason || 'MERCHANT_DECLINED',
      decidedBy: session.staffId,
      decidedAt: Date.now(),
    };
    db.table<Refund>('refunds').update(refund.id, decided);
    db.table<OrderDto>('orders').update(order.id, {
      refund: { ts: refund.createdAt, reason: refund.reason, amount: refund.amount, status: 'declined' },
      version: order.version + 1,
      timeline: [...(order.timeline ?? []), { event: 'refund-declined', ts: Date.now(), actor: session.staffId }],
    });
    db.table('notifications').insert({
      id: uid('n'),
      merchantId: session.merchantId,
      type: 'order',
      title: `Refund declined · ${order.no}`,
      body: 'The refund request was declined. The customer has been notified.',
      ts: Date.now(),
      read: false,
      orderId: order.id,
    });
    audit(order.merchantId, session.staffId, session.role, 'orders:refund-decide', 'order', order.id, `declined refund TZS ${Math.round(refund.amount)} on ${order.no}${decisionReason ? ` (${decisionReason})` : ''}`);
    const updated = db.table<Refund>('refunds').find(refund.id)!;
    emit({ type: 'refunds.decided', refund: toRefundRequest(updated, order), at: Date.now() });
    return ok(toRefundRequest(updated, order));
  }),
];
