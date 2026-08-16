import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';
import { http as rawHttp } from 'msw';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';

const server = setupServer(...(ALL_HTTP_HANDLERS as never[]));

let token: string | null = null;

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: boolean; internal?: boolean; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  const url = path.startsWith('/api') ? path : `/api${path}`;
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
  if (opts.auth !== false) headers.authorization = `Bearer ${token ?? ''}`;
  const res = await fetch(`http://localhost${url}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, body };
}

before(async () => {
  server.use(rawHttp.get('http://localhost/api/ping', () => Response.json({ pong: true })));
  server.listen({ onUnhandledRequest: 'bypass' });
  db.reset();
  seedDatabase();
  const req = await call('POST', '/auth/request-otp', { auth: false, body: { channel: 'phone', destination: '+255700000000', purpose: 'login' } });
  const ok = await call('POST', '/auth/verify-otp', { auth: false, body: { requestId: req.body.requestId, code: req.body.debugCode, purpose: 'login' } });
  token = ok.body.accessToken;
});

beforeEach(() => {
  token = token; // owner session for every test in this file
});

after(() => {
  server.close();
});

/* ================= P6: Conversations (contract /conversations) ================= */

test('conversations: unread-count reflects the seeded unread thread', async () => {
  const res = await call('GET', '/conversations/unread-count');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.count, 'number');
  assert.equal(res.body.count, 1, 'ch1 has one unread message at seed time');
});

test('conversations: detail returns participants with masked phone + linked order fields', async () => {
  const res = await call('GET', '/conversations/ch1');
  assert.equal(res.status, 200);
  const c = res.body;
  assert.equal(c.id, 'ch1');
  assert.equal(c.status, 'open');
  assert.equal(c.lastMessagePreview, 'Can I swap the side to cucumber salad?');
  assert.equal(c.unreadCount, 1);
  assert.ok(Array.isArray(c.participants));
  assert.ok(c.participants.some((p: any) => p.role === 'customer' && p.displayName === 'Emily Wang'));
  assert.match(String(c.participants.find((p: any) => p.role === 'customer')?.maskedPhone ?? ''), /^\+2557\*+/, 'phone arrives masked');
  assert.equal(typeof c.createdAt, 'number');
  assert.equal(typeof c.updatedAt, 'number');
});

test('conversations: detail 404s for unknown ids', async () => {
  const res = await call('GET', '/conversations/does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'CONVERSATION_NOT_FOUND');
});

test('conversations: message history maps the thread store to ChatMessage rows', async () => {
  const res = await call('GET', '/conversations/ch1/messages');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.equal(res.body.length, 2);
  const [first, second] = res.body;
  assert.equal(first.conversationId, 'ch1');
  assert.equal(first.authorRole, 'customer');
  assert.equal(first.body, 'Hi! I just placed order MT88004 🍢');
  assert.equal(typeof first.createdAt, 'number');
  assert.equal(second.body, 'Can I swap the side to cucumber salad?');
  assert.ok(Array.isArray(second.attachments));
});

test('conversations: POST creates a conversation (201), archive 204 + badge decrements, block requires reason', async () => {
  const created = await call('POST', '/conversations', {
    body: { merchantId: 'm_demo', subject: 'Demo conversation', initialMessage: 'Hello, I have a question about my order.' },
  });
  assert.equal(created.status, 201);
  const cv = created.body;
  assert.equal(cv.status, 'open');
  assert.equal(cv.subject, 'Demo conversation');
  assert.equal(cv.lastMessagePreview, 'Hello, I have a question about my order.');

  const afterCreate = await call('GET', '/conversations/unread-count');
  assert.equal(afterCreate.body.count, 2, 'new conversation contributes to the badge');

  const missing = await call('POST', '/conversations/does-not-exist/archive', {});
  assert.equal(missing.status, 404, 'archive of a non-scoped id is 404');

  const noReason = await call('POST', `/conversations/${cv.id}/block`, { body: {} });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.error.code, 'BLOCK_REASON_REQUIRED');

  const archived = await call('POST', `/conversations/${cv.id}/archive`, {});
  assert.equal(archived.status, 204);
  const detail = await call('GET', `/conversations/${cv.id}`);
  assert.equal(detail.body.status, 'archived');
  assert.equal(detail.body.unreadCount, 0, 'archiving clears the unread badge');
  const afterArchive = await call('GET', '/conversations/unread-count');
  assert.equal(afterArchive.body.count, 1, 'badge decrements after archive');

  const block = await call('POST', `/conversations/${cv.id}/block`, { body: { reason: 'Demo moderation' } });
  assert.equal(block.status, 200);
  assert.equal(block.body.status, 'blocked');
  assert.equal(block.body.blockReason, 'Demo moderation');
  const afterBlock = await call('GET', '/conversations/unread-count');
  assert.equal(afterBlock.body.count, 1, 'blocked conversations are excluded from the badge');

  const blockedArchive = await call('POST', `/conversations/${cv.id}/archive`, {});
  assert.equal(blockedArchive.status, 409);
  assert.equal(blockedArchive.body.error.code, 'CONVERSATION_BLOCKED');
});

/* ================= P6: Notification preferences (contract /notifications/me/preferences) ================= */

test('notification preferences: seeded GET returns the four channel maps with boolean event keys', async () => {
  const res = await call('GET', '/notifications/me/preferences');
  assert.equal(res.status, 200);
  for (const channel of ['push', 'sms', 'email', 'inApp']) {
    assert.ok(res.body[channel], `${channel} map present`);
    assert.equal(typeof res.body[channel]['order.created'], 'boolean');
  }
  assert.equal(res.body.push['order.created'], true);
  assert.equal(res.body.sms['order.created'], false, 'sms default off');
});

test('notification preferences: PUT round-trip persists and returns the saved shape', async () => {
  const before = await call('GET', '/notifications/me/preferences');
  const next = {
    push: { ...before.body.push, 'review.received': false },
    sms: { ...before.body.sms, 'order.status': true },
    email: { ...before.body.email },
    inApp: { ...before.body.inApp },
  };
  const put = await call('PUT', '/notifications/me/preferences', { body: next });
  assert.equal(put.status, 200);
  assert.equal(put.body.push['review.received'], false);
  assert.equal(put.body.sms['order.status'], true);
  const readBack = await call('GET', '/notifications/me/preferences');
  assert.equal(readBack.body.push['review.received'], false, 'PUT persists across GET');
  assert.equal(readBack.body.sms['order.status'], true);
  assert.equal(readBack.body.email['order.created'], true, 'unchanged channels keep their values');

  await call('PUT', '/notifications/me/preferences', { body: before.body });
});

test('notification preferences: PUT rejects non-boolean values and missing channels', async () => {
  const bad = await call('PUT', '/notifications/me/preferences', {
    body: { push: { 'order.created': 'yes' }, sms: {}, email: {}, inApp: {} },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'INVALID_PREFERENCES');

  const missing = await call('PUT', '/notifications/me/preferences', { body: { push: {} } });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'INVALID_PREFERENCES');
});

/* ================= P6: Order alert settings (contract /notifications/me/order-settings) ================= */

test('order alert settings: seeded GET returns contract shape', async () => {
  const res = await call('GET', '/notifications/me/order-settings');
  assert.equal(res.status, 200);
  assert.equal(res.body.acceptanceMethod, 'manual');
  assert.equal(typeof res.body.voiceAlerts, 'boolean');
  assert.ok(Array.isArray(res.body.channels));
  assert.ok(res.body.channels.includes('push'));
  assert.equal(res.body.autoAcceptWithinSeconds, 60);
  assert.ok(res.body.quietHours);
  assert.equal(res.body.quietHours.enabled, false);
});

test('order alert settings: PUT round-trip with auto-accept + channels', async () => {
  const put = await call('PUT', '/notifications/me/order-settings', {
    body: { acceptanceMethod: 'auto', voiceAlerts: false, channels: ['push', 'sms'], quietHours: { enabled: true, from: '23:00', to: '06:00' }, autoAcceptWithinSeconds: 120 },
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.acceptanceMethod, 'auto');
  assert.equal(put.body.voiceAlerts, false);
  assert.deepEqual(put.body.channels, ['push', 'sms']);
  assert.equal(put.body.autoAcceptWithinSeconds, 120);
  assert.equal(put.body.quietHours.enabled, true);

  const readBack = await call('GET', '/notifications/me/order-settings');
  assert.equal(readBack.body.acceptanceMethod, 'auto', 'PUT persists');

  await call('PUT', '/notifications/me/order-settings', {
    body: { acceptanceMethod: 'manual', voiceAlerts: true, channels: ['push', 'in_app'], quietHours: { enabled: false, from: '22:00', to: '08:00' }, autoAcceptWithinSeconds: 60 },
  });
});

test('order alert settings: PUT validates enums and the 30–300 auto-accept window', async () => {
  const badMethod = await call('PUT', '/notifications/me/order-settings', {
    body: { acceptanceMethod: 'sometimes', voiceAlerts: true, channels: ['push'] },
  });
  assert.equal(badMethod.status, 400);
  assert.equal(badMethod.body.error.code, 'INVALID_ACCEPTANCE_METHOD');

  const badChannel = await call('PUT', '/notifications/me/order-settings', {
    body: { acceptanceMethod: 'manual', voiceAlerts: true, channels: ['push', 'telegram'] },
  });
  assert.equal(badChannel.status, 400);
  assert.equal(badChannel.body.error.code, 'INVALID_CHANNELS');

  const badWindow = await call('PUT', '/notifications/me/order-settings', {
    body: { acceptanceMethod: 'auto', voiceAlerts: true, channels: ['push'], autoAcceptWithinSeconds: 10 },
  });
  assert.equal(badWindow.status, 400);
  assert.equal(badWindow.body.error.code, 'INVALID_AUTO_ACCEPT');
});

/* ================= P6: Per-item notification read (contract /notifications/{id}/read) ================= */

test('notification read: 204 marks read; repeat is idempotent; unknown id is 404', async () => {
  const list = await call('GET', '/notifications');
  const unread = list.body.notifications.find((n: any) => !n.read);
  assert.ok(unread, 'seed contains an unread notification');

  const first = await call('POST', `/notifications/${unread.id}/read`, {});
  assert.equal(first.status, 204);
  assert.equal(db.table('notifications').find(unread.id)?.read, true, 'row flipped to read');

  const second = await call('POST', `/notifications/${unread.id}/read`, {});
  assert.equal(second.status, 204, 'already-read mark is idempotent');

  const missing = await call('POST', '/notifications/does-not-exist/read', {});
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
});

/* ================= P6: Support tickets + help center (contract /support/tickets/*, /help/articles) ================= */

test('support: ticket detail returns contract TicketDetail with opening + agent messages', async () => {
  const res = await call('GET', '/support/tickets/ticket1');
  assert.equal(res.status, 200);
  const t = res.body.ticket;
  assert.equal(t.id, 'ticket1');
  assert.equal(t.subject, 'Delivery zone coverage question');
  assert.equal(t.status, 'in_progress', "seed 'replied' maps to contract in_progress");
  assert.equal(t.priority, 'normal');
  assert.ok(t.createdAt);
  const authors = t.messages.map((m: any) => m.authorRole);
  assert.ok(authors.includes('merchant'), 'opening message authored by the merchant');
  assert.ok(authors.includes('agent'), 'agent reply preserved');
  const agentMsg = t.messages.find((m: any) => m.authorRole === 'agent');
  assert.match(String(agentMsg.body), /radius expansion/i);
});

test('support: replying appends a merchant-authored message and returns the detail', async () => {
  const reply = await call('POST', '/support/tickets/ticket2/messages', { body: { body: 'Please re-check the photo, I uploaded a new one.' } });
  assert.equal(reply.status, 201);
  const t = reply.body.ticket;
  assert.equal(t.status, 'in_progress', 'replied ticket moves open → in_progress');
  const appended = t.messages[t.messages.length - 1];
  assert.equal(appended.authorRole, 'merchant');
  assert.equal(appended.body, 'Please re-check the photo, I uploaded a new one.');

  const detail = await call('GET', '/support/tickets/ticket2');
  assert.equal(detail.body.ticket.messages.length, t.messages.length, 'reply persisted');

  const empty = await call('POST', '/support/tickets/ticket2/messages', { body: { body: '   ' } });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error.code, 'EMPTY_MESSAGE');

  const missing = await call('GET', '/support/tickets/does-not-exist');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'TICKET_NOT_FOUND');
});

test('help: articles list returns the FAQ bundle (10 rows across 8 areas) with q/category filters', async () => {
  const res = await call('GET', '/help/articles');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.equal(res.body.length, 10, '2 legacy rows + 8-area FAQ bundle');
  assert.ok(res.body.every((a: any) => a.id && a.title && a.category && a.body));
  assert.equal(new Set(res.body.map((a: any) => a.category)).size, 9, '8 doc areas + legacy operations');
  assert.ok(res.body.some((a: any) => a.deepLink), 'FAQ articles carry screen deep links');
  assert.ok(res.body.some((a: any) => a.escalateToTicket), 'escalation articles flagged');

  const filtered = await call('GET', '/help/articles?category=orders');
  assert.equal(filtered.body.length, 2, 'seed + FAQ orders article');
  assert.ok(filtered.body.every((a: any) => a.category === 'orders'));

  const q = await call('GET', '/help/articles?q=refund');
  assert.equal(q.body.length, 1);
  assert.equal(q.body[0].id, 'help_seed_1');
});

/* ================= P6: Reviews (contract /reviews*, merchant + mock-only customer actions) ================= */

test('reviews: PATCH toggles visibility state with validation; rating/body edits round-trip', async () => {
  const list = await call('GET', '/reviews');
  const target = list.body.reviews.find((r: any) => r.id === 'r3');

  const hidden = await call('PATCH', `/reviews/${target.id}`, { body: { state: 'hidden' } });
  assert.equal(hidden.status, 200);
  assert.equal(hidden.body.review.state, 'hidden');

  const readBack = await call('GET', '/reviews');
  assert.equal(readBack.body.reviews.find((r: any) => r.id === 'r3').state, 'hidden', 'visibility persisted');

  const badState = await call('PATCH', `/reviews/${target.id}`, { body: { state: 'spam' } });
  assert.equal(badState.status, 400);
  assert.equal(badState.body.error.code, 'INVALID_STATE');

  const badRating = await call('PATCH', `/reviews/${target.id}`, { body: { rating: 9 } });
  assert.equal(badRating.status, 400);
  assert.equal(badRating.body.error.code, 'INVALID_RATING');

  const edited = await call('PATCH', `/reviews/${target.id}`, { body: { rating: 3, body: 'Updated by the merchant demo.' } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.review.rating, 3);
  assert.equal(edited.body.review.content, 'Updated by the merchant demo.');

  await call('PATCH', `/reviews/${target.id}`, { body: { state: 'published', rating: 2, body: target.content } });
});

test('reviews: DELETE removes the review (204) and it disappears from the list', async () => {
  const created = await call('POST', '/reviews', { body: { targetType: 'merchant', targetId: 'm_demo', rating: 4, body: 'Great grill, will order again.' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.state, 'published');

  const del = await call('DELETE', `/reviews/${created.body.id}`, {});
  assert.equal(del.status, 204);

  const list = await call('GET', '/reviews');
  assert.ok(!list.body.reviews.some((r: any) => r.id === created.body.id), 'deleted review gone from list');

  const again = await call('DELETE', `/reviews/${created.body.id}`, {});
  assert.equal(again.status, 404);
});

test('reviews: reply-delete removes the merchant reply (204-adjacent contract surface)', async () => {
  const target = (await call('GET', '/reviews')).body.reviews.find((r: any) => r.id === 'r4');
  assert.ok(target.reply, 'r4 seeded with a reply');

  const del = await call('DELETE', `/reviews/${target.id}/reply`, {});
  assert.equal(del.status, 200);
  assert.equal(del.body.review.reply, undefined, 'reply cleared');

  await call('POST', `/reviews/${target.id}/reply`, { body: { text: target.reply } });
});

test('reviews: helpful vote toggles counts + myVote; untoggle returns to null', async () => {
  const target = (await call('GET', '/reviews')).body.reviews.find((r: any) => r.id === 'r1');

  const vote = await call('POST', `/reviews/${target.id}/helpful`, { body: { helpful: true } });
  assert.equal(vote.status, 200);
  assert.equal(vote.body.helpfulCount, 1);
  assert.equal(vote.body.notHelpfulCount, 0);
  assert.equal(vote.body.myVote, true);

  const readBack = await call('GET', '/reviews');
  assert.equal(readBack.body.reviews.find((r: any) => r.id === 'r1').helpfulCount, 1, 'count persisted on the row');

  const untoggle = await call('POST', `/reviews/${target.id}/helpful`, { body: { helpful: true } });
  assert.equal(untoggle.body.helpfulCount, 0, 'same vote untoggles');
  assert.equal(untoggle.body.myVote, null);

  const bad = await call('POST', `/reviews/${target.id}/helpful`, { body: { helpful: 'yes' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'INVALID_VOTE');
});

test('reviews: report requires reason and returns a ReviewReport (201)', async () => {
  const target = (await call('GET', '/reviews')).body.reviews.find((r: any) => r.id === 'r5');

  const missing = await call('POST', `/reviews/${target.id}/report`, { body: {} });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'REPORT_REASON_REQUIRED');

  const report = await call('POST', `/reviews/${target.id}/report`, { body: { reason: 'Suspected fake review' } });
  assert.equal(report.status, 201);
  assert.equal(report.body.reviewId, target.id);
  assert.equal(report.body.reason, 'Suspected fake review');
  assert.equal(report.body.state, 'open');
});

test('reviews: POST create validates rating/body (customer write, mock-only)', async () => {
  const badRating = await call('POST', '/reviews', { body: { targetType: 'merchant', targetId: 'm_demo', rating: 0, body: 'x' } });
  assert.equal(badRating.status, 422);
  assert.equal(badRating.body.error.code, 'VALIDATION_ERROR');

  const badType = await call('POST', '/reviews', { body: { targetType: 'landlord', targetId: 'm_demo', rating: 4, body: 'x' } });
  assert.equal(badType.status, 422);

  const ok = await call('POST', '/reviews', { body: { targetType: 'merchant', targetId: 'm_demo', rating: 5, body: 'Five stars!' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.rating, 5);
  await call('DELETE', `/reviews/${ok.body.id}`, {});
});
