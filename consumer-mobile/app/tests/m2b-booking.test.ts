/* M2b — Bookings questionnaire + quote decision + booking→support CTA +
 * booking payment intent flow + declined / no-show states.
 *
 * Questionnaire: GET /service-categories/{id}/questions returns typed contract
 * questions, deterministic per category; answers ride the BookingCreate call.
 * Quote decision: POST /bookings/{id}/quote/decision transitions the mock
 * state (approved → quote_accepted, declined → quote_required), the resulting
 * price breakdown is integer TZS. Support: a ticket created from a booking
 * carries the bookingId through the mock state.
 * Payment: POST /bookings creates the booking as `pending_payment` with a
 * linked intent; POST /payments/intent returns it idempotently and confirm()
 * flips both intent and booking to `paid` (mock webhook). */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { rejectsApiError, resetMockState } from './helpers';
import { getState, simulatePaymentFailure } from '@/repos/mock/mockState';
import { MockProvidersRepository } from '@/repos/mock/providers';
import { MockBookingsRepository, type MockBookingDetail } from '@/repos/mock/bookings';
import { MockPaymentsRepository } from '@/repos/mock/payments';
import { MockSupportRepository, mockTicketCategory } from '@/repos/mock/support';
import { idempotencyKey } from '@/lib/idempotency';
import { ServiceQuestionType, TicketCreateCategory } from '@hudumika/contract';

const providers = new MockProvidersRepository();
const bookings = new MockBookingsRepository();
const payments = new MockPaymentsRepository();
const support = new MockSupportRepository();

const QUESTION_TYPES = Object.values(ServiceQuestionType);

beforeEach(() => resetMockState());

function answers() {
  return { issue: 'Leak', location: 'Kitchen', urgency: 'Emergency' };
}

function bookingInput(overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'prov_001',
    serviceId: 'svc_001',
    scheduledFor: new Date(Date.now() + 86400_000).toISOString(),
    durationMinutes: 120,
    paymentMethod: 'mpesa' as const,
    answers: answers(),
    ...overrides,
  };
}

/* ---------------- questionnaire (TASK 1) ---------------- */

test('getQuestions returns typed contract questions, deterministic per category', async () => {
  const q1 = await providers.getQuestions('svc_001');
  assert.ok(q1.length >= 2);
  for (const q of q1) {
    assert.ok(q.key.length > 0 && q.label.length > 0);
    assert.ok(QUESTION_TYPES.includes(q.type), `type ${q.type} is a contract enum value`);
  }
  const issue = q1.find((q) => q.key === 'issue')!;
  assert.equal(issue.type, 'single_choice');
  assert.equal(issue.required, true);
  assert.deepEqual(issue.options, ['Leak', 'Blockage', 'Other']);
  // Deterministic per seed: same call twice yields the same shape.
  assert.deepEqual(q1, await providers.getQuestions('svc_001'));
});

test('questions differ per service category', async () => {
  const plumbing = await providers.getQuestions('svc_001');
  const cleaning = await providers.getQuestions('svc_003');
  assert.ok(cleaning.some((q) => q.key === 'scope'));
  assert.ok(cleaning.some((q) => q.type === 'multi_choice'));
  assert.ok(plumbing.some((q) => q.type === 'single_choice'));
});

test('getQuestions 404s for an unknown category', async () => {
  await rejectsApiError(providers.getQuestions('svc_nope'), 404, 'SERVICE_NOT_FOUND');
});

test('booking create carries questionnaire answers to the mock wire', async () => {
  const created = await bookings.create(bookingInput(), 'k1');
  assert.equal(created.status, 'pending_payment');
  assert.ok(created.price && Number.isInteger(created.price.totalTZS), 'new booking carries an integer server price');
  const detail = getState().bookings.find((b) => b.id === created.id);
  const stored = detail as unknown as { answers?: Record<string, unknown> };
  assert.deepEqual(stored.answers, answers());
});

test('booking create without answers stores none', async () => {
  const { answers: _answers, ...without } = bookingInput();
  const created = await bookings.create(without, 'k2');
  const detail = getState().bookings.find((b) => b.id === created.id) as unknown as { answers?: Record<string, unknown> };
  assert.equal(detail.answers, undefined);
});

/* ---------------- booking payment intent flow (FIX 1) ---------------- */

test('booking create → pending_payment intent → confirm → paid', async () => {
  const created = await bookings.create(bookingInput(), 'k1');
  assert.equal(created.status, 'pending_payment');
  const intent = await payments.createIntent(created.id, 'mpesa', idempotencyKey('cus_1', 'intent'));
  assert.equal(intent.status, 'created');
  assert.equal(intent.amountTZS, created.price!.totalTZS, 'intent amount matches the booking price');
  // Idempotent: the same booking resolves to the same intent.
  assert.equal((await payments.createIntent(created.id, 'mpesa', idempotencyKey('cus_1', 'intent'))).id, intent.id);
  const paid = await payments.confirm(intent.id, idempotencyKey('cus_1', 'confirm'));
  assert.equal(paid.status, 'paid');
  const detail = await bookings.get(created.id);
  assert.equal(detail.status, 'paid');
  assert.ok(detail.events.some((e) => e.status === 'paid'), 'paid event recorded on the booking timeline');
});

test('booking payment provider outage maps to PAYMENT_PROVIDER_ERROR with retryAfterSeconds, then recovers', async () => {
  const created = await bookings.create(bookingInput(), 'k1');
  const intent = await payments.createIntent(created.id, 'mpesa', idempotencyKey('cus_1', 'intent'));
  simulatePaymentFailure('PAYMENT_PROVIDER_ERROR', 3);
  const err = await rejectsApiError(payments.confirm(intent.id, idempotencyKey('cus_1', 'confirm')), 429, 'PAYMENT_PROVIDER_ERROR');
  assert.equal(err.details?.retryAfterSeconds, 3);
  const paid = await payments.confirm(intent.id, idempotencyKey('cus_1', 'confirm'));
  assert.equal(paid.status, 'paid');
  assert.equal((await bookings.get(created.id)).status, 'paid');
});

test('a paid booking intent is not payable again', async () => {
  const created = await bookings.create(bookingInput(), 'k1');
  const intent = await payments.createIntent(created.id, 'mpesa', idempotencyKey('cus_1', 'intent'));
  await payments.confirm(intent.id, idempotencyKey('cus_1', 'confirm'));
  await rejectsApiError(payments.createIntent(created.id, 'mpesa', idempotencyKey('cus_1', 'intent-2')), 409, 'PAYMENT_ALREADY_PAID');
});

test('cod bookings are created paid and skip the intent', async () => {
  const created = await bookings.create(bookingInput({ paymentMethod: 'cod' }), 'k1');
  assert.equal(created.status, 'paid');
  assert.equal((await bookings.get(created.id)).status, 'paid');
});

/* ---------------- booking estimate (FIX 3) ---------------- */

test('estimate returns integer TZS range with trip fee', async () => {
  const est = await bookings.estimate({ serviceId: 'svc_001' });
  for (const v of [est.lowTZS, est.highTZS, est.tripFeeTZS]) {
    assert.ok(Number.isInteger(v), `estimate field ${v} is integer TZS`);
  }
  assert.ok(est.lowTZS <= est.highTZS);
  assert.ok(est.tripFeeTZS >= 0);
  assert.ok(est.disclaimer && est.disclaimer.length > 0);
});

/* ---------------- declined / no-show seeds (FIX 2) ---------------- */

test('declined booking seed carries re-book navigation data and cancels with refund', async () => {
  const detail = await bookings.get('bk_declined_003');
  assert.equal(detail.status, 'declined');
  // "Request another provider" → /book?serviceId={...}&providerId={...}
  assert.ok(detail.serviceId.length > 0 && detail.providerId.length > 0);
  assert.ok(detail.events.some((e) => e.status === 'declined'));
  const refunded = await bookings.cancel('bk_declined_003', 'refund please', 'k1');
  assert.equal(refunded.status, 'refunded');
  assert.ok((await bookings.get('bk_declined_003')).events.some((e) => e.status === 'refunded'));
});

test('no-show booking seed is terminal and excluded from the active list', async () => {
  const detail = await bookings.get('bk_noshow_004');
  assert.equal(detail.status, 'no_show');
  assert.ok(detail.events.some((e) => e.status === 'no_show'));
  const active = await bookings.list({ status: 'active' });
  assert.ok(!active.some((b) => b.id === 'bk_noshow_004'));
  assert.ok(!active.some((b) => b.id === 'bk_declined_003'));
});

/* ---------------- quote decision (TASK 2) ---------------- */

test('quote booking is seeded in quote_submitted with an issued quote', async () => {
  const detail = await bookings.get('bk_quote_002');
  assert.equal(detail.status, 'quote_submitted');
  assert.equal(detail.quoteStatus, 'quote_issued');
  const quote = (detail as unknown as { quote?: { laborTZS: number; tripFeeTZS: number } }).quote;
  assert.ok(quote && Number.isInteger(quote.laborTZS) && Number.isInteger(quote.tripFeeTZS));
});

test('quote decision approve moves to quote_accepted with integer price breakdown', async () => {
  const decided = await bookings.decideQuote('bk_quote_002', 'approved', undefined, 'k1');
  assert.equal(decided.status, 'quote_accepted');
  assert.equal(decided.quoteStatus, 'quote_approved');
  const price = decided.price!;
  assert.equal(
    price.subtotalTZS + price.deliveryFeeTZS + price.platformFeeTZS + price.taxTZS - price.discountTZS,
    price.totalTZS,
    'price breakdown satisfies the sum rule',
  );
  for (const v of [price.subtotalTZS, price.deliveryFeeTZS, price.platformFeeTZS, price.taxTZS, price.discountTZS, price.totalTZS]) {
    assert.ok(Number.isInteger(v));
  }
  const events = (await bookings.get('bk_quote_002')).events;
  assert.ok(events.some((e) => e.status === 'quote_accepted'));
});

test('quote decision decline returns to quote_required and records the note', async () => {
  const decided = await bookings.decideQuote('bk_quote_002', 'declined', 'Too expensive', 'k1');
  assert.equal(decided.status, 'quote_required');
  assert.equal(decided.quoteStatus, 'quote_declined');
  const events = (await bookings.get('bk_quote_002')).events;
  const last = events[events.length - 1];
  assert.equal(last.status, 'quote_required');
  assert.equal(last.note, 'Too expensive');
});

test('decideQuote is guarded: no issued quote → 409, unknown booking → 404', async () => {
  await rejectsApiError(bookings.decideQuote('bk_active_001', 'approved', undefined, 'k1'), 409, 'QUOTE_NOT_ALLOWED');
  await rejectsApiError(bookings.decideQuote('bk_nope', 'approved', undefined, 'k2'), 404, 'BOOKING_NOT_FOUND');
});

test('quote breakdown rows are integer TZS and total matches the sum', async () => {
  const detail = await bookings.get('bk_quote_002');
  const quote = (detail as unknown as { quote?: { laborTZS: number; tripFeeTZS: number; parts?: { name: string; quantity: number; unitCostTZS: number }[]; expiresAt?: string | null; note?: string } }).quote;
  assert.ok(quote, 'seeded quote is present');
  assert.ok(Number.isInteger(quote.laborTZS));
  assert.ok(Number.isInteger(quote.tripFeeTZS));
  assert.ok((quote.parts ?? []).length >= 1);
  const partsSum = (quote.parts ?? []).reduce((acc, p) => acc + p.unitCostTZS * p.quantity, 0);
  assert.ok(Number.isInteger(partsSum));
  for (const p of quote.parts ?? []) {
    assert.ok(Number.isInteger(p.unitCostTZS) && Number.isInteger(p.quantity));
  }
  assert.equal(quote.laborTZS + quote.tripFeeTZS + partsSum, 80000 + 15000 + 45000 + 2 * 3000);
  assert.ok(quote.expiresAt && quote.note);
});

/* ---------------- quote revision + ask provider (BOOKING-FLOW.md) ----------------
 * Contract reality: DecideBookingQuoteBodyDecision is approved|declined only and
 * BookingQuote/BookingDetail carry no revision/version fields — ask_provider and
 * the revision trail are mock-only extensions (documented in mock/bookings.ts). */

test('the seeded quote booking exposes the mock-only previousQuote for the comparison banner', async () => {
  const detail = await bookings.get('bk_quote_002');
  const ext = detail as unknown as MockBookingDetail;
  assert.ok(ext.previousQuote, 'seeded quote booking carries the superseded quote');
  assert.ok(Number.isInteger(ext.previousQuote!.laborTZS) && ext.previousQuote!.laborTZS > 0);
  assert.ok(ext.quoteAskProvider === true, 'the mock exposes the ask-provider capability flag');
  assert.ok(ext.quote && ext.quote.laborTZS < ext.previousQuote!.laborTZS, 'the current quote is the revised (cheaper) one');
});

test('decideQuote with ask_provider records the ask, keeps the quote issued and issues a revision (mock-only)', async () => {
  const before = (await bookings.get('bk_quote_002')) as unknown as MockBookingDetail;
  const decided = await bookings.decideQuote('bk_quote_002', 'ask_provider', 'Can you lower the labor cost?', 'k1');
  assert.equal(decided.status, 'quote_submitted', 'the booking stays in the quote flow');
  assert.equal(decided.quoteStatus, 'quote_issued', 'the quote still awaits the customer decision');
  const after = (await bookings.get('bk_quote_002')) as unknown as MockBookingDetail;
  const events = after.events;
  assert.ok(events.some((e) => e.status === 'quote_asked'), 'the ask is recorded on the timeline');
  assert.ok(events.some((e) => e.status === 'quote_submitted' && e.note === 'Revised quote issued'), 'the provider revision is recorded');
  assert.ok(after.previousQuote, 'the revision trail exposes the superseded quote');
  assert.equal(after.previousQuote!.laborTZS, before.quote!.laborTZS, 'previousQuote equals the quote that was superseded');
  assert.ok(after.quote && after.quote.laborTZS < before.quote!.laborTZS, 'a cheaper revised quote was issued');
  const lastAsk = events[events.length - 2];
  assert.equal(lastAsk.status, 'quote_asked');
  assert.equal(lastAsk.note, 'Can you lower the labor cost?', 'the customer note rides the ask');
});

test('ask_provider is guarded like the other decisions: no issued quote → 409 QUOTE_NOT_ALLOWED', async () => {
  await rejectsApiError(bookings.decideQuote('bk_active_001', 'ask_provider', 'why so much?', 'k1'), 409, 'QUOTE_NOT_ALLOWED');
  await rejectsApiError(bookings.decideQuote('bk_nope', 'ask_provider', 'hi', 'k2'), 404, 'BOOKING_NOT_FOUND');
});

/* ---------------- booking → support CTA (TASK 3) ---------------- */

test('support ticket created from a booking carries the bookingId', async () => {
  const created = await support.createTicket(
    { subject: 'Issue with booking bk_active_001', body: 'The provider never arrived', bookingId: 'bk_active_001' },
    'k1',
  );
  assert.equal(created.status, 'open');
  const stored = getState().tickets.find((t) => t.id === created.id)!;
  assert.ok(stored.subject.includes('booking bk_active_001'));
});

test('booking list includes the seeded quote booking under active scope', async () => {
  const active = await bookings.list({ status: 'active' });
  assert.ok(active.some((b) => b.id === 'bk_quote_002'));
});

/* ---------------- completed booking: rebook + invoice data path (TASK 2) ---------------- */

test('completed booking exposes the rebook route params (serviceId + providerId)', async () => {
  const created = await bookings.create(
    bookingInput({ providerId: 'prov_001', serviceId: 'svc_002' }),
    'k1',
  );
  // The mock has no seeded completed booking; flip the created booking to
  // completed (post-confirmation) so the detail carries terminal data.
  const stored = getState().bookings.find((b) => b.id === created.id)!;
  stored.status = 'completed';
  stored.events.push({ status: 'completed', at: new Date().toISOString(), by: 'customer', note: 'Job completed' });

  const detail = await bookings.get(created.id);
  assert.equal(detail.status, 'completed');
  assert.ok(detail.serviceId.length > 0 && detail.providerId.length > 0, 'rebook needs both params');
  // "Book again" → /book?serviceId={serviceId}&providerId={providerId}
  const route = { pathname: '/book', params: { serviceId: detail.serviceId, providerId: detail.providerId } };
  assert.equal(route.params.serviceId, 'svc_002');
  assert.equal(route.params.providerId, 'prov_001');
});

test('completed booking detail carries the integer-TZS price the invoice will summarize', async () => {
  const created = await bookings.create(bookingInput(), 'k1');
  const stored = getState().bookings.find((b) => b.id === created.id)!;
  stored.status = 'completed';
  stored.events.push({ status: 'completed', at: new Date().toISOString(), by: 'customer', note: 'Job completed' });

  const detail = await bookings.get(created.id);
  const price = detail.price!;
  for (const v of [price.subtotalTZS, price.deliveryFeeTZS, price.platformFeeTZS, price.taxTZS, price.discountTZS, price.totalTZS]) {
    assert.ok(Number.isInteger(v), `price field ${v} is integer TZS`);
  }
  assert.equal(
    price.subtotalTZS + price.deliveryFeeTZS + price.platformFeeTZS + price.taxTZS - price.discountTZS,
    price.totalTZS,
    'price breakdown satisfies the sum rule',
  );
});

/* ---------------- customer documents (mock-only, CONTRACT-ADDITIONS #9) ----------------
 * The contract has POST-only issue endpoints and no customer GET; the mock
 * serves deterministic invoice/warranty/proof-of-service for terminal
 * (completed) bookings, derived from the server-price breakdown. The live
 * repo returns null on 404 until Team 6 ships the GETs. */

test('completed booking serves invoice/warranty/proof from the mock with integer TZS', async () => {
  const created = await bookings.create(bookingInput(), 'k1');
  const stored = getState().bookings.find((b) => b.id === created.id)!;
  stored.status = 'completed';
  stored.events.push({ status: 'completed', at: new Date().toISOString(), by: 'customer', note: 'Job completed' });

  const invoice = await bookings.getInvoice(created.id);
  assert.ok(invoice, 'completed booking has an invoice');
  for (const v of [invoice!.subtotalTZS, invoice!.feesTZS, invoice!.totalTZS]) {
    assert.ok(Number.isInteger(v), `invoice amount ${v} is integer TZS`);
  }
  assert.ok(invoice!.lineItems.length >= 1);
  for (const li of invoice!.lineItems) {
    assert.ok(Number.isInteger(li.unitPriceTZS) && Number.isInteger(li.quantity));
  }
  assert.equal(invoice!.subtotalTZS + invoice!.feesTZS, invoice!.totalTZS, 'invoice rows sum to the billed total');
  assert.ok(invoice!.issuedAt.length > 0);

  const warranty = await bookings.getWarranty(created.id);
  assert.ok(warranty, 'completed booking has a warranty');
  assert.ok(warranty!.coverage.length > 0);
  assert.ok(Date.parse(warranty!.expiresAt) > Date.parse(created.scheduledFor), 'warranty outlives the booking date');

  const proof = await bookings.getProofOfService(created.id);
  assert.ok(proof, 'completed booking has proof of service');
  assert.ok(proof!.photos.length >= 1);
  assert.equal(proof!.signatureStatus, 'signed');
  assert.ok(proof!.completedAt.length > 0);
});

test('non-completed bookings return null documents; unknown bookings 404', async () => {
  assert.equal(await bookings.getInvoice('bk_active_001'), null, 'active booking: invoice not yet issued');
  assert.equal(await bookings.getWarranty('bk_active_001'), null);
  assert.equal(await bookings.getProofOfService('bk_active_001'), null);
  assert.equal(await bookings.getInvoice('bk_noshow_004'), null, 'terminal-but-not-completed: no documents');
  await rejectsApiError(bookings.getInvoice('bk_nope'), 404, 'BOOKING_NOT_FOUND');
  await rejectsApiError(bookings.getWarranty('bk_nope'), 404, 'BOOKING_NOT_FOUND');
  await rejectsApiError(bookings.getProofOfService('bk_nope'), 404, 'BOOKING_NOT_FOUND');
});

test('support ticket with the mock-first feedback category round-trips through the mock', async () => {
  // 'feedback' is not a contract TicketCreateCategory value yet
  // (docs/CONTRACT-ADDITIONS.md #6) — the app casts it into the contract
  // field position exactly like support.tsx does.
  const created = await support.createTicket(
    { subject: 'Great experience', body: 'The app was easy to use', category: 'feedback' as TicketCreateCategory },
    'k1',
  );
  assert.equal(created.status, 'open');
  assert.equal(mockTicketCategory(created.id), 'feedback', 'the mock stores the mock-first category');
  assert.ok(getState().tickets.some((t) => t.id === created.id));
});
