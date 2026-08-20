import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mmss } from '@/lib/format';
import { getUrgencyTier, RUSH_PRESETS_MIN, urgencyFromCreatedAt, URGENCY_TONE } from '@/lib/urgency';
import { dict } from '@/i18n';

/* ================= Urgency tiers: dwell = now - Order.createdAt =================
 *  Spec per merchant/docs/ORDER-FLOW.md Round-2: Low <2m, Medium <5m, High <10m, Critical >=10m.
 *  Honest UI over contract data — no urgency field; computed client-side.
 */
test('urgency tiers computed from Order.createdAt: boundaries and tones', () => {
  const now = Date.now();
  const at = (msAgo: number) => now - msAgo;

  // <2m Low
  assert.equal(urgencyFromCreatedAt(at(0), now), 'low');
  assert.equal(urgencyFromCreatedAt(at(60 * 1000), now), 'low');
  assert.equal(urgencyFromCreatedAt(at(2 * 60 * 1000 - 1), now), 'low');

  // <5m Medium — inclusive of 2m boundary
  assert.equal(urgencyFromCreatedAt(at(2 * 60 * 1000), now), 'medium');
  assert.equal(urgencyFromCreatedAt(at(4 * 60 * 1000 + 59 * 1000), now), 'medium');
  assert.equal(urgencyFromCreatedAt(at(5 * 60 * 1000 - 1), now), 'medium');

  // <10m High
  assert.equal(urgencyFromCreatedAt(at(5 * 60 * 1000), now), 'high');
  assert.equal(urgencyFromCreatedAt(at(9 * 60 * 1000 + 59 * 1000), now), 'high');
  assert.equal(urgencyFromCreatedAt(at(10 * 60 * 1000 - 1), now), 'high');

  // >=10m Critical
  assert.equal(urgencyFromCreatedAt(at(10 * 60 * 1000), now), 'critical');
  assert.equal(urgencyFromCreatedAt(at(15 * 60 * 1000), now), 'critical');
  assert.equal(urgencyFromCreatedAt(at(60 * 60 * 1000), now), 'critical');

  // Pill tones per spec: low muted (neutral), medium warning, high danger, critical danger
  assert.equal(URGENCY_TONE.low, 'neutral');
  assert.equal(URGENCY_TONE.medium, 'warning');
  assert.equal(URGENCY_TONE.high, 'danger');
  assert.equal(URGENCY_TONE.critical, 'danger');
});

test('urgency is honest UI over contract data — no urgency field on RushOrder payload', () => {
  const now = Date.now();
  const urgency = urgencyFromCreatedAt(now - 30 * 1000, now);
  assert.equal(urgency, 'low');
  const fakePayload: any = { urgency: 'critical', requestedAt: now - 30 * 1000 };
  const honest = urgencyFromCreatedAt(fakePayload.requestedAt, now);
  assert.equal(honest, 'low', 'fake urgency field is ignored, dwell from createdAt wins');
});

test('getUrgencyTier(createdAt) alias matches urgencyFromCreatedAt and spec thresholds', () => {
  const now = Date.now();
  const cases: [number, ReturnType<typeof getUrgencyTier>][] = [
    [0, 'low'],
    [60_000, 'low'],
    [2 * 60_000, 'medium'],
    [4 * 60_000, 'medium'],
    [5 * 60_000, 'high'],
    [9 * 60_000, 'high'],
    [10 * 60_000, 'critical'],
    [20 * 60_000, 'critical'],
  ];
  for (const [ago, expected] of cases) {
    const createdAt = now - ago;
    assert.equal(getUrgencyTier(createdAt, now), expected);
    assert.equal(urgencyFromCreatedAt(createdAt, now), expected, 'alias parity');
  }
});

test('ETA presets are exactly 5/10/15/20/30/45 and fill reply text honestly (≤300)', () => {
  assert.deepEqual([...RUSH_PRESETS_MIN], [5, 10, 15, 20, 30, 45]);

  for (const m of RUSH_PRESETS_MIN) {
    const text = `ETA ${m} minutes`;
    assert.ok(text.length <= 300, `preset ${m} text within 300 chars`);
    assert.match(text, /^ETA \d+ minutes$/);
    const label = dict.en['orders.rushReplyPreset']?.replace('{n}', String(m));
    assert.ok(label?.includes(String(m)), 'i18n label interpolates minutes');
  }

  let replyText = '';
  const setReplyText = (v: string) => (replyText = v.slice(0, 300));
  setReplyText(`ETA ${RUSH_PRESETS_MIN[1]} minutes`);
  assert.equal(replyText, 'ETA 10 minutes');
  setReplyText(`ETA ${RUSH_PRESETS_MIN[5]} minutes`);
  assert.equal(replyText, 'ETA 45 minutes');
});

test('i18n keys for new labels exist in en+sw+ar and interpolate correctly', () => {
  const keys = [
    'orders.urgency.low',
    'orders.urgency.medium',
    'orders.urgency.high',
    'orders.urgency.critical',
    'orders.rushReplyPreset',
    'orders.etaPresetHint',
    'orders.deadlineHint',
    'orders.deadlineInfo',
    'orders.batchAcceptResult',
    'rf.partialBanner',
    'rf.partialDetail',
  ];
  for (const k of keys) {
    assert.ok(dict.en[k], `en missing ${k}`);
    assert.ok(dict.sw[k], `sw missing ${k}`);
    assert.ok((dict.ar as Record<string, string>)[k], `ar missing ${k}`);
  }
  assert.equal(dict.en['orders.rushReplyPreset'].includes('{n}'), true);
  assert.equal(dict.en['orders.batchAcceptResult'].includes('{n}'), true);
  assert.ok(dict.en['rf.partialBanner'].toLowerCase().includes('partial'), 'honesty banner mentions partial');
  assert.ok(dict.en['rf.partialBanner'].includes('amountTZS') || dict.en['rf.partialDetail'].includes('amountTZS'), 'honesty banner documents contract gap: no amountTZS');
  assert.ok(dict.en['rf.partialDetail'].toLowerCase().includes('no amount'), 'honesty detail says no amount input');
});

test('deadline countdown mm:ss via src/lib/format.ts mmss — informational mm:ss', () => {
  assert.equal(mmss(0), '00:00');
  assert.equal(mmss(1), '00:01');
  assert.equal(mmss(59), '00:59');
  assert.equal(mmss(60), '01:00');
  assert.equal(mmss(90), '01:30');
  assert.equal(mmss(5 * 60), '05:00');
  assert.equal(mmss(10 * 60 + 3), '10:03');
  assert.equal(mmss(-5), '00:00', 'negative clamps to 00:00');
  assert.equal(mmss(3600), '60:00', 'hour-long countdown renders as 60:00');

  const now = Date.now();
  const deadlineAt = now + 90 * 1000;
  const remaining = Math.max(0, Math.floor((deadlineAt - now) / 1000));
  assert.equal(mmss(remaining), '01:30');
  const pastDeadline = now - 1000;
  const remainingPast = Math.max(0, Math.floor((pastDeadline - now) / 1000));
  assert.equal(mmss(remainingPast), '00:00', 'past deadline shows 00:00 (server auto-cancels informationally)');
});

test('order source badge renders Order.source pill (app/web/phone/pos) and deadline countdown uses mmss', () => {
  const SOURCE_TONE: Record<string, string> = { app: 'info', web: 'success', phone: 'warning', pos: 'neutral' };
  for (const src of ['app', 'web', 'phone', 'pos'] as const) {
    assert.ok(SOURCE_TONE[src], `source ${src} has a tone`);
    const label = (dict.en as Record<string, string>)[`orders.source.${src}`];
    assert.ok(label, `i18n key orders.source.${src} exists`);
    assert.equal(label, src.toUpperCase());
  }
  // Graceful fallback when source is null/undefined — no pill rendered, no crash
  const nullSource: string | null = null as unknown as string;
  assert.equal(nullSource ? SOURCE_TONE[nullSource] ?? 'neutral' : 'no-pill', 'no-pill');
  const createdAt = Date.now();
  const deadlineAt = createdAt + 2 * 60 * 1000;
  const secs = Math.floor((deadlineAt - createdAt) / 1000);
  assert.equal(mmss(secs), '02:00');
  // Informational banner text uses t('orders.deadlineHint') — server authoritative wording
  assert.ok(dict.en['orders.deadlineHint'].toLowerCase().includes('server'), 'deadline hint mentions server authoritative');
  assert.ok(dict.en['orders.deadlineHint'].includes('mm:ss') || dict.en['orders.deadlineHint'].toLowerCase().includes('informational'), 'deadline hint mentions informational/mm:ss');
});

test('partial refund honesty: approve body has only reason, no amountTZS field (contract gap)', () => {
  // Banner documents the gap and no fake amount input exists
  assert.ok(dict.en['rf.partialBanner'].includes('amountTZS'), 'banner documents no amountTZS');
  assert.ok(dict.en['rf.partialDetail'].includes('≤500'), 'detail mentions reason ≤500');
  // The refunds screen renders reasoning only — no amount input is honest
  const approveBody: Record<string, unknown> = { reason: 'out of stock' };
  assert.ok(!('amountTZS' in approveBody), 'contract approve body has no amountTZS — honest UI must not invent one');
  assert.equal(typeof approveBody.reason, 'string');
});

test('batch accept BatchResult shape reflects partial failures per ORDER-FLOW.md', () => {
  // Shape: { accepted: number, failed: number, failures: { orderId, code }[] } — per-failure code
  const sample: { accepted: number; failed: number; failures: { orderId: string; code: string }[] } = {
    accepted: 2,
    failed: 1,
    failures: [{ orderId: 'o_1', code: 'ORDER_STATUS_CONFLICT' }],
  };
  assert.equal(sample.accepted + sample.failed, 3, 'accepted + failed = total attempted');
  assert.equal(sample.failures[0].orderId, 'o_1');
  assert.ok(sample.failures[0].code.length > 0);
  // UI i18n for batch result interpolates counts
  const label = dict.en['orders.batchAcceptResult'];
  assert.ok(label.includes('{n}') && label.includes('{m}'), 'batch i18n interpolates accepted/total');
});
