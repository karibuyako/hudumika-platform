/* Dine-in bill lifecycle (P6b) — contract paths:
 *   POST /dine-in/orders (open a bill, idempotency-key required),
 *   GET /dine-in/orders/me (?status= filter),
 *   GET /dine-in/orders/{billId}, POST .../confirm-payment, POST .../close,
 *   GET /dine-in/tables/{tableId}/qr -> {qrPayload, menuUrl}.
 * Mock-only additions (tracked in docs/CONTRACT-ADDITIONS.md):
 *   POST /dine-in/orders/{billId}/request-bill (open -> billing; pushes
 *   dine_in.bill_requested), POST /dine-in/reservations/{id}/confirm
 *   (merchant confirm of a pending reservation).
 * State machine: open -> billing -> paid -> closed (cancelled terminal).
 * Money is integer TZS; totals are server-computed PriceBreakdown.
 */
import type { DineInOrder, NotificationDto, PriceBreakdown, ProductRow, Reservation, Staff, StoreServer, TableRow } from '@/api/types';
import { db, uid } from '@/mock/db';
import { emit } from '@/mock/events';
import { audit, requirePerm, requireSession } from '@/mock/security';
import { ApiHttpError, h, idemGet, idemKey, idemSet, ok, readJson } from '@/mock/handlers/common';
import type { Session } from '@/mock/types-internal';

const TAX_RATE = 0.06;

const PAYMENT_METHODS = ['mpesa', 'airtel_money', 'tigo_pesa', 'ezy_pesa', 'cod', 'cash', 'card', 'bank'] as const;

/* Dual-screen POS role gates (DINE-IN.md): billing actions (confirm-payment,
 * close) need `dine_in:billing` (cashier role); everything else that is
 * cashier-only answers STAFF_ROLE_FORBIDDEN (403) instead of FORBIDDEN. */
function requireBillingRole(session: Session): void {
  const staff = db.table<Staff>('staff').find(session.staffId);
  const perms = staff?.permissions ?? [];
  if (perms.includes('*') || perms.includes('dine_in:billing')) return;
  throw new ApiHttpError(403, 'STAFF_ROLE_FORBIDDEN', 'Only cashier roles can confirm payments or close bills');
}

function pushReservationNote(merchantId: string, title: string, body: string) {
  const note: NotificationDto = {
    id: uid('n'),
    merchantId,
    type: 'system',
    category: 'important',
    title,
    body,
    ts: Date.now(),
    read: false,
  };
  db.table<NotificationDto>('notifications').insert(note);
  emit({ type: 'notification.created', notification: note, at: note.ts });
}

function computeTotals(subtotalTZS: number): PriceBreakdown {
  const taxTZS = Math.round(subtotalTZS * TAX_RATE);
  return {
    subtotalTZS,
    deliveryFeeTZS: 0,
    platformFeeTZS: 0,
    taxTZS,
    discountTZS: 0,
    totalTZS: subtotalTZS + taxTZS,
  };
}

function requireBill(session: Session, id: string): DineInOrder {
  const bill = db.table<DineInOrder>('dineInOrders').find(id);
  if (!bill || bill.merchantId !== session.merchantId) {
    throw new ApiHttpError(404, 'DINE_IN_BILL_NOT_FOUND', 'Dine-in bill not found');
  }
  return bill;
}

function requireTable(session: Session, tableId: string): TableRow {
  const table = db.table<TableRow>('tables').find(tableId);
  if (!table) throw new ApiHttpError(404, 'DINE_IN_TABLE_NOT_FOUND', 'Dine-in table not found');
  const store = db.table<StoreServer>('stores').find(table.storeId);
  if (!store || store.merchantId !== session.merchantId) {
    throw new ApiHttpError(404, 'DINE_IN_TABLE_NOT_FOUND', 'Dine-in table not found');
  }
  return table;
}

/** Reservation ownership guard (contract /reservations — customer-side flow,
 * mock-only in the merchant app; rows carry a storeId app extension). */
function requireReservation(session: Session, id: string): Reservation & { storeId: string } {
  const row = db.table<Reservation & { storeId: string }>('reservations').find(id);
  if (!row || row.merchantId !== session.merchantId) {
    throw new ApiHttpError(404, 'RESERVATION_NOT_FOUND', 'Reservation not found');
  }
  return row;
}

export const dineInHandlers = [
  /* ---- Table QR (contract shape {qrPayload, menuUrl}) ---- */
  h.get('/api/dine-in/tables/:id/qr', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const table = requireTable(session, String(params.id));
    const store = db.table<StoreServer>('stores').find(table.storeId);
    const base = store?.qrOrdering?.urlPattern || 'https://order.example.com/q';
    return ok({
      qrPayload: `hudumika:dinein:table:${table.id}`,
      menuUrl: `${base}/${table.storeId}/${table.id}?t=${table.qrToken}`,
    });
  }),

  /* ---- Open a bill at a table (customer from QR) ---- */
  h.post('/api/dine-in/orders', async ({ request }) => {
    const session = requireSession(request);
    const key = idemKey(request);
    const cached = idemGet('dine-in:open', key);
    if (cached) return ok(cached);
    const body = await readJson(request);
    if (String(body.merchantId ?? '') !== session.merchantId) {
      throw new ApiHttpError(403, 'FORBIDDEN', 'merchantId does not match the session');
    }
    const table = requireTable(session, String(body.tableId ?? ''));
    if (table.currentOrderId) {
      throw new ApiHttpError(409, 'DINE_IN_TABLE_IN_USE', 'Table already has an open bill');
    }
    if (!Array.isArray(body.items) || body.items.length === 0) {
      throw new ApiHttpError(400, 'INVALID_ITEMS', 'At least one item is required');
    }
    const items: DineInOrder['items'] = [];
    for (const raw of body.items as { catalogueItemId?: unknown; quantity?: unknown }[]) {
      const catalogueItemId = String(raw.catalogueItemId ?? '');
      const quantity = Number(raw.quantity);
      if (!Number.isInteger(quantity) || quantity < 1) {
        throw new ApiHttpError(400, 'INVALID_ITEMS', 'quantity must be an integer >= 1');
      }
      const product = db.table<ProductRow>('products').find(catalogueItemId);
      if (!product || product.storeId !== table.storeId) {
        throw new ApiHttpError(400, 'INVALID_ITEMS', `Unknown catalogue item: ${catalogueItemId}`);
      }
      items.push({ catalogueItemId, name: product.name, quantity, unitPriceTZS: product.price });
    }
    const subtotalTZS = items.reduce((sum, it) => sum + it.unitPriceTZS * it.quantity, 0);
    const bill: DineInOrder = {
      id: uid('dio'),
      merchantId: session.merchantId,
      tableId: table.id,
      status: 'open',
      items,
      totals: computeTotals(subtotalTZS),
      createdAt: Date.now(),
      paidAt: null,
    };
    db.table<DineInOrder>('dineInOrders').insert(bill);
    db.table<TableRow>('tables').update(table.id, { currentOrderId: bill.id, status: 'occupied' });
    audit(session.merchantId, session.staffId, session.role, 'dine-in:open', 'dine-in-order', bill.id, `opened bill at table ${table.name} (${items.length} items)`);
    emit({ type: 'dine_in.bill_opened', order: bill, at: Date.now() });
    idemSet('dine-in:open', key, { bill });
    return ok({ bill }, { status: 201 });
  }),

  /* ---- Own dine-in bills with optional status filter ---- */
  h.get('/api/dine-in/orders/me', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    let bills = db.table<DineInOrder>('dineInOrders').where((b) => b.merchantId === session.merchantId);
    if (status) bills = bills.filter((b) => b.status === status);
    return ok({ bills: bills.sort((a, b) => b.createdAt - a.createdAt) });
  }),

  /* ---- Bill detail (parties only) ---- */
  h.get('/api/dine-in/orders/:id', ({ request, params }) => {
    const session = requireSession(request);
    return ok({ bill: requireBill(session, String(params.id)) });
  }),

  /* ---- Confirm discounted bill payment (merchant) ---- */
  h.post('/api/dine-in/orders/:id/confirm-payment', async ({ request, params }) => {
    const session = requireSession(request);
    requireBillingRole(session);
    const bill = requireBill(session, String(params.id));
    if (bill.status === 'paid') return ok({ bill });
    if (bill.status !== 'open' && bill.status !== 'billing') {
      throw new ApiHttpError(409, 'DINE_IN_BILL_NOT_PAYABLE', 'Only open or billing bills can be paid');
    }
    /* Evidence (PAYMENTS.md): the cashier records the method (COD for cash
     * receipt, mpesa/airtel_money for provider-verified) and optional payer.
     * Body is optional — confirming with no evidence is still valid. */
    let body: Record<string, unknown> = {};
    try {
      body = (await readJson(request)) as Record<string, unknown>;
    } catch {
      /* no body — evidence fields are optional */
    }
    const method = String(body.method ?? '');
    const paymentMethod = PAYMENT_METHODS.includes(method as (typeof PAYMENT_METHODS)[number]) ? (method as (typeof PAYMENT_METHODS)[number]) : undefined;
    const paidBy = body.paidBy === undefined || body.paidBy === null ? undefined : String(body.paidBy).slice(0, 40);
    const evidence: Partial<DineInOrder> = {};
    if (paymentMethod) evidence.paymentMethod = paymentMethod;
    if (paidBy) evidence.paidBy = paidBy;
    const updated = db.table<DineInOrder>('dineInOrders').update(bill.id, { status: 'paid', paidAt: Date.now(), ...evidence })!;
    audit(session.merchantId, session.staffId, session.role, 'dine-in:confirm-payment', 'dine-in-order', bill.id, `confirmed payment of ${updated.totals.totalTZS} TZS${paymentMethod ? ` via ${paymentMethod}` : ''}${paidBy ? ` (recorded by ${paidBy})` : ''}`);
    emit({ type: 'dine_in.payment_confirmed', order: updated, at: Date.now() });
    return ok({ bill: updated });
  }),

  /* ---- Request the bill (waiter/customer): open -> billing, pushes
   * dine_in.bill_requested to the merchant. Mock-only path — tracked as a
   * contract-additions proposal (docs/CONTRACT-ADDITIONS.md). ---- */
  h.post('/api/dine-in/orders/:id/request-bill', ({ request, params }) => {
    const session = requireSession(request);
    const bill = requireBill(session, String(params.id));
    if (bill.status === 'billing') return ok({ bill });
    if (bill.status !== 'open') {
      throw new ApiHttpError(409, 'DINE_IN_ORDER_STATUS_CONFLICT', 'Only open bills can move to billing');
    }
    const updated = db.table<DineInOrder>('dineInOrders').update(bill.id, { status: 'billing' })!;
    audit(session.merchantId, session.staffId, session.role, 'dine-in:request-bill', 'dine-in-order', bill.id, 'customer/waiter requested the bill');
    emit({ type: 'dine_in.bill_requested', order: updated, at: Date.now() });
    return ok({ bill: updated });
  }),

  /* ---- Close a bill after settlement (merchant) ---- */
  h.post('/api/dine-in/orders/:id/close', ({ request, params }) => {
    const session = requireSession(request);
    requireBillingRole(session);
    const bill = requireBill(session, String(params.id));
    if (bill.status === 'closed') return ok({ bill });
    if (bill.status !== 'paid') {
      throw new ApiHttpError(409, 'DINE_IN_ORDER_STATUS_CONFLICT', 'Only paid bills can be closed');
    }
    const updated = db.table<DineInOrder>('dineInOrders').update(bill.id, { status: 'closed' })!;
    db.table<TableRow>('tables').update(bill.tableId, { currentOrderId: null, status: 'idle' });
    audit(session.merchantId, session.staffId, session.role, 'dine-in:close', 'dine-in-order', bill.id, 'closed bill after settlement');
    emit({ type: 'dine_in.bill_closed', order: updated, at: Date.now() });
    return ok({ bill: updated });
  }),

  /* ================= Reservations (contract /reservations — customer-side
   * flow, mock-only in the merchant app) =================
   * POST /reservations (201; Idempotency-Key required), GET /reservations/me
   * (bare array, newest first), POST /reservations/{id}/cancel. Statuses are
   * the exact ReservationStatus enum: pending → confirmed → seated →
   * completed | cancelled | no_show. */

  h.post('/api/reservations', async ({ request }) => {
    const session = requireSession(request);
    const key = idemKey(request);
    const cached = idemGet('reservation:create', key);
    if (cached) return ok(cached, { status: 201 });
    const body = await readJson(request);
    if (String(body.merchantId ?? '') !== session.merchantId) {
      throw new ApiHttpError(403, 'FORBIDDEN', 'merchantId does not match the session');
    }
    const partySize = Number(body.partySize);
    if (!Number.isInteger(partySize) || partySize < 1 || partySize > 50) {
      throw new ApiHttpError(422, 'VALIDATION_FAILED', 'partySize must be between 1 and 50');
    }
    const scheduledFor =
      typeof body.scheduledFor === 'number' ? Number(body.scheduledFor) : Date.parse(String(body.scheduledFor ?? ''));
    if (!Number.isFinite(scheduledFor)) {
      throw new ApiHttpError(422, 'VALIDATION_FAILED', 'scheduledFor must be an ISO date-time or epoch timestamp');
    }
    if (scheduledFor <= Date.now()) {
      throw new ApiHttpError(422, 'RESERVATION_TIME_IN_PAST', 'scheduledFor must be in the future');
    }
    const note = body.note === undefined || body.note === null ? undefined : String(body.note).trim();
    if (note !== undefined && note.length > 300) {
      throw new ApiHttpError(422, 'VALIDATION_FAILED', 'note must be at most 300 characters');
    }
    let tableId: string | null = null;
    if (body.tableId !== undefined && body.tableId !== null) {
      const table = db.table<TableRow>('tables').find(String(body.tableId));
      const store = table ? db.table<StoreServer>('stores').find(table.storeId) : undefined;
      if (!table || !store || store.merchantId !== session.merchantId) {
        throw new ApiHttpError(404, 'DINE_IN_TABLE_NOT_FOUND', 'Dine-in table not found');
      }
      if (table.capacity < partySize) {
        throw new ApiHttpError(409, 'RESERVATION_TABLE_FULL', 'Table is fully booked at the requested time');
      }
      const clash = db
        .table<Reservation & { storeId: string }>('reservations')
        .where((r) => r.tableId === table.id && (r.status === 'pending' || r.status === 'confirmed') && Math.abs(r.scheduledFor - scheduledFor) < 2 * 3600000);
      if (clash.length) {
        throw new ApiHttpError(409, 'RESERVATION_TABLE_FULL', 'Table is fully booked at the requested time');
      }
      tableId = table.id;
    }
    const now = Date.now();
    const row: Reservation & { storeId: string } = {
      id: uid('rsv'),
      merchantId: session.merchantId,
      storeId: db.table<StoreServer>('stores').where((s) => s.merchantId === session.merchantId)[0]?.id ?? '',
      tableId,
      partySize,
      scheduledFor,
      status: 'pending',
      note,
      createdAt: now,
    };
    db.table<Reservation & { storeId: string }>('reservations').insert(row);
    const { storeId: _sid, ...reservation } = row;
    audit(session.merchantId, session.staffId, session.role, 'reservation:create', 'reservation', row.id, `reserved for ${partySize} at ${new Date(scheduledFor).toISOString()}`);
    /* Merchant sees reservation traffic via notifications (DINE-IN.md):
     * reservation.requested on arrival, confirmed on confirm, reminder before
     * the slot. */
    pushReservationNote(
      session.merchantId,
      'New reservation request',
      `${partySize} guest(s) requested a table for ${new Date(scheduledFor).toLocaleString()}`,
    );
    emit({ type: 'reservation.requested', reservation, at: now });
    idemSet('reservation:create', key, reservation);
    return ok(reservation, { status: 201 });
  }),

  h.get('/api/reservations/me', ({ request }) => {
    const session = requireSession(request);
    const rows = db
      .table<Reservation & { storeId: string }>('reservations')
      .where((r) => r.merchantId === session.merchantId)
      .sort((a, b) => b.scheduledFor - a.scheduledFor);
    return ok(rows.map(({ storeId: _sid, ...r }) => r));
  }),

  h.post('/api/reservations/:reservationId/cancel', ({ request, params }) => {
    const session = requireSession(request);
    const row = requireReservation(session, String(params.reservationId));
    if (row.status !== 'pending' && row.status !== 'confirmed') {
      throw new ApiHttpError(409, 'RESERVATION_NOT_CANCELLABLE', 'Reservation can no longer be cancelled');
    }
    const updated = db.table<Reservation & { storeId: string }>('reservations').update(row.id, { status: 'cancelled' })!;
    const { storeId: _sid, ...reservation } = updated;
    audit(session.merchantId, session.staffId, session.role, 'reservation:cancel', 'reservation', row.id, `cancelled reservation for ${row.partySize}`);
    emit({ type: 'reservation.cancelled', reservation, at: Date.now() } as unknown as Parameters<typeof emit>[0]);
    return ok(reservation);
  }),

  /* ---- Merchant confirm of a pending reservation (dashboard quick action).
   * Mock-only path — merchant-side reservation management is a documented
   * contract gap (DINE-IN.md); this is the minimal confirm transition. ---- */
  h.post('/api/dine-in/reservations/:reservationId/confirm', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const row = requireReservation(session, String(params.reservationId));
    if (row.status === 'confirmed') {
      const { storeId: _sid, ...reservation } = row;
      return ok(reservation);
    }
    if (row.status !== 'pending') {
      throw new ApiHttpError(409, 'RESERVATION_NOT_CONFIRMABLE', 'Only pending reservations can be confirmed');
    }
    const updated = db.table<Reservation & { storeId: string }>('reservations').update(row.id, { status: 'confirmed' })!;
    const { storeId: _sid, ...reservation } = updated;
    audit(session.merchantId, session.staffId, session.role, 'reservation:confirm', 'reservation', row.id, `confirmed reservation for ${row.partySize} at ${new Date(row.scheduledFor).toISOString()}`);
    pushReservationNote(
      session.merchantId,
      'Reservation confirmed',
      `${row.partySize} guest(s) confirmed for ${new Date(row.scheduledFor).toLocaleString()}`,
    );
    emit({ type: 'reservation.confirmed', reservation, at: Date.now() });
    return ok(reservation);
  }),
];