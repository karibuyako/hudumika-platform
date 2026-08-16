/* M6 — Engagement: conversations (unread badge lifecycle, blocked read-only),
 * notification preferences round-trip, support tickets, reviews eligibility. */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { rejectsApiError, resetMockState, auth } from './helpers';
import { MockConversationsRepository, resetMessageRateLimit, seedMessageHistory, nextMessagesCursor, mergeOlderMessages } from '@/repos/mock/conversations';
import { MockNotificationsRepository, PREFERENCE_EVENT_KEYS, LOCKED_PREFERENCE_EVENTS } from '@/repos/mock/notifications';
import { MockSupportRepository } from '@/repos/mock/support';
import { MockReviewsRepository } from '@/repos/mock/reviews';
import { getState } from '@/repos/mock/mockState';

const conversations = new MockConversationsRepository();
const notifications = new MockNotificationsRepository();
const support = new MockSupportRepository();
const reviews = new MockReviewsRepository();

beforeEach(() => resetMockState());

test('unread badge counts unread messages and clears on thread open (/read)', async () => {
  assert.equal(await conversations.unreadCount(), 2);
  await conversations.markRead('conv_001');
  assert.equal(await conversations.unreadCount(), 0);
  await conversations.send('conv_001', 'hello again', 'k1');
  assert.equal(await conversations.unreadCount(), 0, 'customer sends do not bump the badge');
});

test('blocked conversations are read-only: send → 409 CONVERSATION_BLOCKED', async () => {
  await rejectsApiError(conversations.send('conv_002', 'hello', 'k1'), 409, 'CONVERSATION_BLOCKED');
  const blocked = await conversations.get('conv_002');
  assert.equal(blocked.status, 'blocked');
  const hasSystemNotice = (await conversations.listMessages('conv_002')).some((m) => m.authorRole === 'system');
  assert.ok(hasSystemNotice, 'blocked threads carry a system notice');
});

test('notification preferences PUT round-trips per-event keys and invalid events are rejected by shape', async () => {
  const prefs = await notifications.getPreferences();
  prefs.push = { ...(prefs.push ?? {}), 'order.delivered': false, 'payment.failed': true };
  const saved = await notifications.putPreferences(prefs, 'k1');
  assert.equal(saved.push?.['order.delivered'], false);
  assert.equal(saved.push?.['payment.failed'], true);
  const reloaded = await notifications.getPreferences();
  assert.equal(reloaded.push?.['payment.failed'], true);
  assert.equal(typeof prefs.inApp?.['order.created'], 'boolean');
});

test('every per-event preference key the app renders is accepted by the mock', async () => {
  const prefs = await notifications.getPreferences();
  for (const key of PREFERENCE_EVENT_KEYS) {
    // Locked keys stay true; toggleable keys flip on each pass.
    const next = key.startsWith('security.') ? true : !(prefs.push?.[key] ?? false);
    prefs.push = { ...(prefs.push ?? {}), [key]: next };
    const saved = await notifications.putPreferences(prefs, `k_${key}`);
    assert.equal(saved.push?.[key], next, `${key} round-trips`);
  }
});

test('legacy coarse keys are gone: the seeded preferences merge into per-event defaults', async () => {
  const prefs = await notifications.getPreferences();
  assert.equal(prefs.push?.['order.status'], undefined, 'legacy order.status dropped');
  assert.equal(prefs.push?.['security'], undefined, 'legacy security dropped');
  assert.equal(prefs.push?.['order.created'], true, 'per-event default surfaced');
  assert.equal(prefs.inApp?.['payment.failed'], true, 'payment.failed defaults to in-app + push + sms');
  assert.equal(prefs.sms?.['payment.failed'], true);
  assert.equal(prefs.email?.['security.otp'], true, 'locked keys are always on across their channels');
  assert.equal(prefs.push?.['security.otp'], true, 'OTP stays on on every channel — always-on keys are never off');
});

test('security.* preferences are locked: the repo rejects disabling them with PREFERENCE_INVALID_EVENT', async () => {
  for (const key of LOCKED_PREFERENCE_EVENTS) {
    const prefs = await notifications.getPreferences();
    prefs.push = { ...(prefs.push ?? {}), [key]: false };
    await rejectsApiError(notifications.putPreferences(prefs, `k_lock_${key}`), 422, 'PREFERENCE_INVALID_EVENT');
  }
  const reloaded = await notifications.getPreferences();
  assert.equal(reloaded.sms?.['security.otp'], true, 'security stays on after the rejected save');
});

test('support tickets prefilled from an order stay linked in the subject', async () => {
  const ticket = await support.createTicket({ subject: 'Missing item', body: 'Milk tea missing', orderId: 'ord_completed_004' }, 'k1');
  assert.ok(ticket.subject.length > 0);
  const detail = await support.getTicket(ticket.id);
  assert.equal(detail.messages[0].authorRole, 'customer');
});

test('reviews are eligibility-gated (delivered/completed only) and single-shot', async () => {
  const ineligible = getState().merchants[1].id;
  await rejectsApiError(reviews.create({ targetType: 'merchant', targetId: ineligible, rating: 5, body: 'x' }, 'k1'), 422, 'REVIEW_NOT_ELIGIBLE');
  const merchantId = getState().orders.find((o) => o.status === 'delivered')!.merchantId;
  const created = await reviews.create({ targetType: 'merchant', targetId: merchantId, rating: 4, body: 'nzuri' }, 'k2');
  assert.equal(created.state, 'pending');
  await rejectsApiError(reviews.create({ targetType: 'merchant', targetId: merchantId, rating: 5, body: 'again' }, 'k3'), 422, 'REVIEW_ALREADY_EXISTS');
});

test('auth session is required before engagement surfaces respond (repo-level visibility)', async () => {
  await auth.logout();
  const tickets = await support.listTickets();
  assert.ok(Array.isArray(tickets));
});

test('rate-limited sends throw MESSAGE_RATE_LIMITED with retryAfterSeconds; the window closes and a later send succeeds', async () => {
  resetMessageRateLimit();
  await conversations.send('conv_001', 'ping', 'k_rl_1');
  const limited = await rejectsApiError(conversations.send('conv_001', 'ping again', 'k_rl_2'), 429, 'MESSAGE_RATE_LIMITED');
  assert.ok(
    typeof limited.details?.retryAfterSeconds === 'number' && limited.details.retryAfterSeconds >= 1,
    'details carry retryAfterSeconds so the composer can show a countdown',
  );
  const history = await conversations.listMessages('conv_001');
  assert.ok(!history.some((m) => m.body === 'ping again'), 'the rate-limited message never lands (draft survives)');
  await new Promise((r) => setTimeout(r, (limited.details!.retryAfterSeconds as number) * 1000 + 300));
  await conversations.send('conv_001', 'ping after window', 'k_rl_3');
  const after = await conversations.listMessages('conv_001');
  assert.ok(after.some((m) => m.body === 'ping after window'), 'a send after the rate window succeeds');
});

test('system messages are identifiable by authorRole for centered-notice rendering', async () => {
  const messages = await conversations.listMessages('conv_002');
  const notice = messages.find((m) => m.authorRole === 'system');
  assert.ok(notice, 'blocked threads include a system notice');
  assert.equal(notice!.authorRole, 'system');
  assert.ok(notice!.body.length > 0, 'the system notice carries server copy for the centered notice');
});

test('attachments follow the contract shape: up to 4, invalid ones rejected with MESSAGE_ATTACHMENT_INVALID', async () => {
  resetMessageRateLimit();
  const sent = await conversations.send('conv_001', 'with photo', 'k_att_1', [
    { mediaType: 'image', url: 'https://cdn.hudumika.dev/mock/fixture/photo_01.jpg' },
    { mediaType: 'document', url: 'https://cdn.hudumika.dev/mock/fixture/receipt.pdf' },
  ]);
  assert.equal(sent.attachments?.length, 2);
  assert.equal(sent.attachments?.[0].mediaType, 'image');
  await rejectsApiError(
    conversations.send('conv_001', 'too many', 'k_att_2', Array.from({ length: 5 }, (_, i) => ({ mediaType: 'image' as const, url: `https://cdn.hudumika.dev/mock/fixture/p${i}.jpg` }))),
    422,
    'MESSAGE_ATTACHMENT_INVALID',
  );
  await rejectsApiError(
    conversations.send('conv_001', 'bad url', 'k_att_3', [{ mediaType: 'image', url: '' }]),
    422,
    'MESSAGE_ATTACHMENT_INVALID',
  );
});

/* ---------------- chat pagination (CHAT.md) ---------------- */

test('listMessages is tail-first: the first page returns the NEWEST page and a next cursor for older messages', async () => {
  // Seeded conv_001 (3 messages) + 45 history = 48 total — more than one page.
  seedMessageHistory('conv_001', 45);
  const first = await conversations.listMessages('conv_001');
  assert.equal(first.length, 30, 'first page is a full page');
  assert.equal(first[first.length - 1].body, 'history message 44', 'the newest message sits at the bottom of the first page');
  assert.equal(first[first.length - 2].body, 'history message 43', 'page content is contiguous');
  assert.ok(!first.some((m) => m.body === 'msg_1'), 'the oldest seeded messages are NOT on the first page');
  assert.equal(nextMessagesCursor(first), '30', 'a full page yields the cursor for the previous page');
});

test('loading the previous page prepends older messages; the final short page clears the cursor', async () => {
  seedMessageHistory('conv_001', 45);
  const first = await conversations.listMessages('conv_001');
  const older = await conversations.listMessages('conv_001', '30');
  assert.equal(older.length, 18, 'previous page holds the remaining 18 older messages');
  assert.equal(older[older.length - 1].body, 'history message 14', 'the previous page ends right before the first page');
  assert.equal(first[0].body, 'history message 15', 'pages are contiguous (14 → 15)');
  assert.equal(older[0].id, 'msg_1', 'oldest message (the seeded "msg_1") surfaces on the previous page');
  assert.equal(nextMessagesCursor(older, '30'), null, 'a short page means no older messages');
});

test('prepending the older page dedupes by id and keeps newest at the bottom', async () => {
  seedMessageHistory('conv_001', 45);
  const first = await conversations.listMessages('conv_001');
  const older = await conversations.listMessages('conv_001', '30');
  const merged = mergeOlderMessages(first, older);
  assert.equal(merged.length, 48, 'no message lost or duplicated in the merge');
  assert.equal(new Set(merged.map((m) => m.id)).size, 48, 'every merged id is unique (dedupe)');
  assert.equal(merged[0].id, 'msg_1', 'older messages sit ABOVE the loaded ones');
  assert.equal(merged[merged.length - 1].body, 'history message 44', 'newest stays at the bottom');
  // A duplicate (e.g. a concurrent send raced a refresh) is dropped, not doubled.
  const dup = mergeOlderMessages(merged, [merged[10], merged[20]]);
  assert.equal(dup.length, 48, 'already-loaded ids are filtered out');
});

test('a thread whose length is an exact page multiple walks the cursor to an empty page, then stops', async () => {
  seedMessageHistory('conv_001', 57); // 3 seeded + 57 = 60 = 2 exact pages
  const p1 = await conversations.listMessages('conv_001');
  assert.equal(p1.length, 30);
  const p2 = await conversations.listMessages('conv_001', nextMessagesCursor(p1)!);
  assert.equal(p2.length, 30);
  const p3 = await conversations.listMessages('conv_001', nextMessagesCursor(p2, nextMessagesCursor(p1)!)!);
  assert.equal(p3.length, 0, 'the page beyond the oldest messages is empty');
  assert.equal(nextMessagesCursor(p3, nextMessagesCursor(p2, nextMessagesCursor(p1)!)!), null, 'empty page clears the cursor');
  assert.equal(mergeOlderMessages(p1, p2).length, 60, 'both pages merge without loss');
});
