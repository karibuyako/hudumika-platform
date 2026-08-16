import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';
import { http as rawHttp } from 'msw';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';
import { subscribe } from '@/mock/events';
import type { ServerEvent } from '@/api/types';

import './shims';
import { setToken } from '@/api/client';
import { useChatStore } from '@/store/chat';
import { useMessageStore } from '@/store/messages';
import { useReviewStore } from '@/store/reviews';

const server = setupServer(...(ALL_HTTP_HANDLERS as never[]));

let token: string | null = null;

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: boolean; internal?: boolean; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const url = path.startsWith('/api') ? path : `/api${path}`;
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
  if (opts.auth !== false) headers.authorization = `Bearer ${token ?? ''}`;
  if (opts.internal) headers['x-internal-key'] = 'demo-customer-platform';
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
  return { status: res.status, body, headers: res.headers };
}

async function loginAs(phone: string): Promise<string> {
  const req = await call('POST', '/auth/request-otp', { auth: false, body: { channel: 'phone', destination: phone, purpose: 'login' } });
  const ok = await call('POST', '/auth/verify-otp', { auth: false, body: { requestId: req.body.requestId, code: req.body.debugCode, purpose: 'login' } });
  return ok.body.accessToken;
}

before(async () => {
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

/* ================= M3: MESSAGE_* error-code fidelity (MESSAGES.md §Send) ================= */

test('messages: empty body → 400 MESSAGE_EMPTY on the contract path (yaml MESSAGE_EMPTY)', async () => {
  const empty = await call('POST', '/conversations/ch1/messages', { body: { body: '   ' } });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error.code, 'MESSAGE_EMPTY');
  assert.equal(empty.body.code, 'MESSAGE_EMPTY', 'contract top-level code present');
});

test('messages: body over 2000 chars → 400 MESSAGE_TOO_LONG', async () => {
  const res = await call('POST', '/conversations/ch1/messages', { body: { body: 'x'.repeat(2001) } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'MESSAGE_TOO_LONG');

  const ok = await call('POST', '/conversations/ch1/messages', { body: { body: 'x'.repeat(2000) } });
  assert.equal(ok.status, 200, '2000 chars is accepted');
});

test('messages: legacy send path uses the same MESSAGE_EMPTY code (drift parity)', async () => {
  const legacy = await call('POST', '/chat/threads/ch1/messages', { body: { text: '  ' } });
  assert.equal(legacy.status, 400);
  assert.equal(legacy.body.error.code, 'MESSAGE_EMPTY');
  const contract = await call('POST', '/conversations/ch1/messages', { body: { text: '  ' } });
  assert.equal(contract.body.error.code, legacy.body.error.code, 'parity holds between paths');
});

/* ================= M2: attachments (MESSAGES.md §Send — max 4, MESSAGE_ATTACHMENT_INVALID) ================= */

test('messages: 5 attachments → 400 MESSAGE_ATTACHMENT_INVALID; typed URIs pass and persist', async () => {
  const tooMany = await call('POST', '/conversations/ch1/messages', {
    body: { body: 'photo dump', attachments: [1, 2, 3, 4, 5].map((i) => ({ mediaType: 'image', url: `file:///a${i}.jpg` })) },
  });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.body.error.code, 'MESSAGE_ATTACHMENT_INVALID');

  const badType = await call('POST', '/conversations/ch1/messages', {
    body: { body: 'bad', attachments: [{ mediaType: 'video', url: 'file:///a.mp4' }] },
  });
  assert.equal(badType.status, 400);
  assert.equal(badType.body.error.code, 'MESSAGE_ATTACHMENT_INVALID');

  const noUrl = await call('POST', '/conversations/ch1/messages', {
    body: { body: 'bad', attachments: [{ mediaType: 'image', url: '' }] },
  });
  assert.equal(noUrl.status, 400);
  assert.equal(noUrl.body.error.code, 'MESSAGE_ATTACHMENT_INVALID');

  const ok = await call('POST', '/conversations/ch1/messages', {
    body: { body: 'Menu photo attached', attachments: [{ mediaType: 'image', url: 'file:///menu.jpg' }] },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.message.attachments.length, 1);
  const history = await call('GET', '/conversations/ch1/messages');
  const last = history.body[history.body.length - 1];
  assert.equal(last.body, 'Menu photo attached');
  assert.equal(last.attachments[0].mediaType, 'image');
});

/* ================= M6: archived conversations refuse writes (409 CONVERSATION_ARCHIVED) ================= */

test('messages: archived thread refuses writes with 409 CONVERSATION_ARCHIVED', async () => {
  const created = await call('POST', '/conversations', {
    body: { merchantId: 'm_demo', subject: 'Archive test', initialMessage: 'Hello' },
  });
  assert.equal(created.status, 201);
  await call('POST', `/conversations/${created.body.id}/archive`, {});

  const res = await call('POST', `/conversations/${created.body.id}/messages`, { body: { body: 'still here?' } });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'CONVERSATION_ARCHIVED');
  assert.equal(res.body.code, 'CONVERSATION_ARCHIVED');
});

test('messages: blocked thread refuses writes with 409 CONVERSATION_BLOCKED', async () => {
  const created = await call('POST', '/conversations', {
    body: { merchantId: 'm_demo', subject: 'Block test', initialMessage: 'Hello' },
  });
  assert.equal(created.status, 201);
  await call('POST', `/conversations/${created.body.id}/block`, { body: { reason: 'Moderation demo' } });

  const res = await call('POST', `/conversations/${created.body.id}/messages`, { body: { body: 'can you hear me?' } });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'CONVERSATION_BLOCKED');
});

/* ================= M5: block is staff-only (403 CONVERSATION_FORBIDDEN) ================= */

test('block: non-staff merchant session gets 403 CONVERSATION_FORBIDDEN', async () => {
  const invite = await call('POST', '/staff', { body: { name: 'Cashier One', phone: '+255700000007', role: 'staff' } });
  assert.equal(invite.status, 200);
  const staffToken = await loginAs('+255700000007');

  const created = await call('POST', '/conversations', {
    body: { merchantId: 'm_demo', subject: 'Staff block test', initialMessage: 'Hello' },
  });
  assert.equal(created.status, 201);

  const res = await call('POST', `/conversations/${created.body.id}/block`, { auth: false, body: { reason: 'nope' }, headers: { authorization: `Bearer ${staffToken}` } });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'CONVERSATION_FORBIDDEN');

  const owner = await call('POST', `/conversations/${created.body.id}/block`, { body: { reason: 'staff moderation' } });
  assert.equal(owner.status, 200, 'owner with the support scope can block');
});

/* ================= M4: conversation.blocked notification (MESSAGES.md §Blocked state) ================= */

test('block: emits conversation.blocked + a deepLink-carrying in-app notification to both sides', async () => {
  const seen: ServerEvent[] = [];
  const unsub = subscribe((e) => seen.push(e));
  try {
    const created = await call('POST', '/conversations', {
      body: { merchantId: 'm_demo', subject: 'Event test', initialMessage: 'Hello' },
    });
    assert.equal(created.status, 201);
    const block = await call('POST', `/conversations/${created.body.id}/block`, { body: { reason: 'Spam behaviour' } });
    assert.equal(block.status, 200);

    const blocked = seen.find((e) => e.type === 'conversation.blocked');
    assert.ok(blocked, 'conversation.blocked event emitted');
    assert.equal((blocked as { conversation: { status: string } }).conversation.status, 'blocked');

    const noteEvent = seen.find((e) => e.type === 'notification.created');
    assert.ok(noteEvent, 'in-app notification created on block');
    const note = (noteEvent as { notification: { category: string; title: string; deepLink: string | null } }).notification;
    assert.equal(note.category, 'im');
    assert.match(note.title, /blocked/i);
    assert.equal(note.deepLink, `/dashboard/im/${created.body.id}`, 'push tap routes via deepLink');

    const list = await call('GET', '/notifications/me?unreadOnly=true');
    assert.ok(list.body.notifications.some((n: any) => n.deepLink === `/dashboard/im/${created.body.id}`), 'block notification listed');
  } finally {
    unsub();
  }
});

/* ================= M3: 429 MESSAGE_RATE_LIMITED + Retry-After (MESSAGES.md §Send) ================= */

test('messages: rate limit returns 429 MESSAGE_RATE_LIMITED with retryAfterSeconds + Retry-After header', async () => {
  const created = await call('POST', '/conversations', {
    body: { merchantId: 'm_demo', subject: 'Rate limit test', initialMessage: 'Hello' },
  });
  assert.equal(created.status, 201);
  const id = created.body.id;

  /* Fire a burst of valid sends concurrently so the 10s window cannot reset
   * between attempts; the requests past the cap must 429. */
  const burst = await Promise.all(
    Array.from({ length: 30 }, (_, i) => call('POST', `/conversations/${id}/messages`, { body: { body: `burst ${i}` } })),
  );
  const limited = burst.find((r) => r.status === 429);
  assert.ok(limited, 'a 429 was eventually returned');
  assert.equal(limited!.body.error.code, 'MESSAGE_RATE_LIMITED');
  assert.ok(typeof limited!.body.error.details?.retryAfterSeconds === 'number' && limited!.body.error.details.retryAfterSeconds >= 1);
  assert.ok(Number(limited!.headers.get('retry-after')) >= 1, 'Retry-After header honored');
  assert.ok(burst.filter((r) => r.status === 200).length <= 20, 'only the window budget succeeds');
});

/* ================= M9: conversation list status filter + cursor pagination ================= */

test('conversations: GET /conversations honors ?status= and ?limit=/cursor= (defaults stay full)', async () => {
  const created = await call('POST', '/conversations', { body: { merchantId: 'm_demo', subject: 'Filter A', initialMessage: 'Hi' } });
  await call('POST', `/conversations/${created.body.id}/archive`, {});

  const all = await call('GET', '/conversations');
  assert.ok(all.body.threads.length >= 4, 'full list returned by default');

  const archived = await call('GET', '/conversations?status=archived');
  assert.equal(archived.status, 200);
  assert.ok(archived.body.threads.length >= 1);
  assert.ok(archived.body.threads.every((t: any) => (t.status ?? 'open') === 'archived'));

  const open = await call('GET', '/conversations?status=open');
  assert.ok(open.body.threads.every((t: any) => (t.status ?? 'open') === 'open'));

  const blocked = await call('GET', '/conversations?status=blocked');
  assert.ok(blocked.body.threads.every((t: any) => t.status === 'blocked'));

  const page = await call('GET', '/conversations?limit=2');
  assert.equal(page.body.threads.length, 2);
  const page2 = await call('GET', `/conversations?limit=2&cursor=${page.body.threads[page.body.threads.length - 1].id}`);
  assert.equal(page2.body.threads.length, 2);
  assert.notEqual(page2.body.threads[0].id, page.body.threads[0].id, 'cursor advances past the first page');
});

test('messages: GET /conversations/{id}/messages supports limit + cursor, newest last', async () => {
  const all = await call('GET', '/conversations/ch2/messages');
  assert.ok(all.body.length >= 3);
  const last = all.body[all.body.length - 1];

  const page = await call('GET', '/conversations/ch2/messages?limit=2');
  assert.equal(page.body.length, 2);
  assert.equal(page.body[1].id, last.id, 'page ends at the newest message');
  const prev = await call('GET', `/conversations/ch2/messages?limit=2&cursor=${page.body[0].id}`);
  assert.equal(prev.body.length, 1, 'one message is older than the cursor');
  assert.ok(!page.body.some((m: any) => m.id === prev.body[0].id), 'cursor page does not repeat messages');
});

/* ================= P1/N: notification center cursor pagination + unreadOnly ================= */

test('notifications: GET /notifications/me honors unreadOnly/limit/cursor with nextCursor', async () => {
  const page = await call('GET', '/notifications/me?limit=2');
  assert.equal(page.status, 200);
  assert.equal(page.body.notifications.length, 2);
  assert.ok(page.body.nextCursor, 'nextCursor present when more rows exist');

  const page2 = await call('GET', `/notifications/me?limit=2&cursor=${page.body.nextCursor}`);
  assert.equal(page2.body.notifications.length, 2);
  assert.ok(page2.body.notifications[0].ts <= page.body.notifications[0].ts, 'cursor advances (desc ts)');

  const unread = await call('GET', '/notifications/me?unreadOnly=true');
  assert.ok(unread.body.notifications.length >= 1);
  assert.ok(unread.body.notifications.every((n: any) => !n.read));
});

test('notifications: seeded deepLink values route to known app routes', async () => {
  const list = await call('GET', '/notifications/me');
  const withDl = list.body.notifications.filter((n: any) => typeof n.deepLink === 'string');
  assert.ok(withDl.length >= 2, 'm3/m4 + im notifications carry deepLink');
  for (const n of withDl) {
    assert.ok(/^\/(orders|dashboard|store|products|ops|marketing|finance)/.test(n.deepLink), `deepLink targets an app route: ${n.deepLink}`);
  }
});

/* ================= N1: push token registration (mock-only endpoint) ================= */

test('push: POST /devices/push-token registers a per-device token; empty token → PUSH_TOKEN_INVALID', async () => {
  const ok = await call('POST', '/devices/push-token', { body: { token: 'ExponentPushToken[abc123]', platform: 'ios' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.registered, true);
  assert.equal(db.table('pushTokens').where((p: any) => p.token === 'ExponentPushToken[abc123]').length, 1, 'token stored server-side');

  const bad = await call('POST', '/devices/push-token', { body: { token: '  ' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'PUSH_TOKEN_INVALID');
});

/* ================= N2: locked system events (NOTIFICATIONS.md §Preferences) ================= */

test('preferences: PUT forces locked system events on across every channel', async () => {
  const next = {
    push: { 'order.created': false, 'system.announcement': false, 'payout.failed': false },
    sms: {},
    email: {},
    inApp: {},
  };
  const put = await call('PUT', '/notifications/me/preferences', { body: next });
  assert.equal(put.status, 200);
  assert.equal(put.body.push['order.created'], false, 'normal events stay as sent');
  assert.equal(put.body.push['system.announcement'], true, 'system events forced on');
  assert.equal(put.body.push['payout.failed'], true, 'high-priority payout failures forced on');
  assert.equal(put.body.inApp['system.announcement'], true);

  const readBack = await call('GET', '/notifications/me/preferences');
  assert.equal(readBack.body.push['system.announcement'], true, 'locked state persists');
});

/* ================= M7/M8: badge freshness + mark-read rollback (store-level) ================= */

test('chat store: markRead rolls back the optimistic unread on failure', async () => {
  server.use(rawHttp.post('http://localhost/api/conversations/ch2/read', () => Response.json({ error: { code: 'HTTP_ERROR' } }, { status: 500 })));
  useChatStore.setState({
    threads: [{ id: 'ch2', customerName: 'X', customerInitial: 'X', lastMessage: 'hi', lastTs: Date.now(), unread: 3, context: '', messages: [] }],
    unreadTotal: 3,
  });
  const markRead = useChatStore.getState().markRead;
  markRead('ch2');
  assert.equal(useChatStore.getState().threads[0].unread, 0, 'optimistic clear');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(useChatStore.getState().threads[0].unread, 3, 'rollback restores unread');
  server.restoreHandlers();
});

test('chat store: send failure keeps the draft + marks the message failed (retry affordance)', async () => {
  server.use(rawHttp.post('http://localhost/api/conversations/ch2/messages', () => Response.json({ error: { code: 'HTTP_ERROR' } }, { status: 500 })));
  useChatStore.setState({
    threads: [{ id: 'ch2', customerName: 'X', customerInitial: 'X', lastMessage: 'hi', lastTs: Date.now(), unread: 0, context: '', messages: [] }],
    pendingSends: {},
    failedSends: {},
  });
  const send = useChatStore.getState().send;
  const res = await send('ch2', 'draft kept', [{ mediaType: 'image', url: 'file:///a.jpg' }]);
  assert.equal(res.ok, false);
  const draft = useChatStore.getState().failedSends['ch2'];
  assert.ok(draft, 'failed draft preserved');
  assert.equal(draft.text, 'draft kept');
  assert.equal(draft.attachments.length, 1);
  const msgs = useChatStore.getState().threads[0].messages;
  assert.ok(msgs.some((m) => (m as { failed?: boolean }).failed), 'optimistic row marked failed');
  server.restoreHandlers();
});

test('messages store: markOneRead rolls back on failure; badge refresh covers chat.message via upsert', async () => {
  server.use(rawHttp.post('http://localhost/api/notifications/n_seed_read/read', () => Response.json({ error: { code: 'HTTP_ERROR' } }, { status: 500 })));
  useMessageStore.setState({
    messages: [{ id: 'n_seed_read', type: 'system', title: 't', body: 'b', ts: Date.now(), read: false }],
  });
  useMessageStore.getState().markOneRead('n_seed_read');
  assert.equal(useMessageStore.getState().messages[0].read, true, 'optimistic read');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(useMessageStore.getState().messages[0].read, false, 'rollback on error');
  server.restoreHandlers();
});

test('chat store: upsert (chat.message event path) refreshes the unread badge', async () => {
  setToken(token!);
  useChatStore.setState({ conversationUnread: 999 });
  const thread = { id: 'ch1', customerName: 'Emily Wang', customerInitial: 'E', lastMessage: 'hi', lastTs: Date.now(), unread: 1, context: '', messages: [] };
  useChatStore.getState().upsert(thread);
  await new Promise((r) => setTimeout(r, 80));
  const fresh = useChatStore.getState().conversationUnread;
  assert.ok(fresh !== 999, `badge refreshed after event (${fresh})`);
});

/* ================= S3: review report store action ================= */

test('reviews store: report posts to the contract endpoint and records the reported state', async () => {
  setToken(token!);
  const report = useReviewStore.getState().report;
  await report('r1', 'Suspected paid review');
  assert.equal(useReviewStore.getState().reported['r1'], true, 'reported flag set');
  const list = await call('GET', '/reviews');
  assert.ok(list.body.reviews.find((r: any) => r.id === 'r1'));
});
