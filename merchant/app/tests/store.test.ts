import './shims';

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';
import { api, ApiError, setRefreshToken, setToken } from '@/api/client';
import type { StoreServer } from '@/api/types';
import { useSessionStore } from '@/store/session';
import { useAuthStore } from '@/store/auth';
import { useOrderStore } from '@/store/orders';
import { useCatalogStore } from '@/store/catalog';
import { useFinanceStore } from '@/store/finance';
import { useCampaignStore } from '@/store/campaigns';
import { useCouponStore } from '@/store/coupons';
import { useStoreStore } from '@/store/store';
import { useChatStore } from '@/store/chat';
import { useMessageStore } from '@/store/messages';
import { useReviewStore } from '@/store/reviews';

const server = setupServer(...(ALL_HTTP_HANDLERS as never[]));

let ownerToken: string | null = null;

/* Some store actions fire their api call without awaiting it (fire-and-forget
 * PATCH/POST). Poll the mock db until the mutation lands so assertions on the
 * server side stay deterministic. */
async function waitFor(cond: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

before(async () => {
  server.listen({ onUnhandledRequest: 'bypass' });
  db.reset();
  seedDatabase();
  const { requestId, debugCode } = await useSessionStore.getState().requestOtp('+255700000000', 'login');
  await useSessionStore.getState().verifyOtp(requestId, debugCode, 'login');
  ownerToken = useSessionStore.getState().token;
  assert.ok(ownerToken, 'owner session token issued');
});

beforeEach(() => {
  setToken(ownerToken);
});

after(() => {
  server.close();
});

/* ================= Session & auth ================= */

test('session: request-otp -> verify-otp success sets token + merchant profile', async () => {
  useSessionStore.setState({ status: 'anon', token: null, me: null, perms: [] });
  const { requestId, debugCode } = await useSessionStore.getState().requestOtp('+255700000002', 'login');
  assert.ok(requestId);
  assert.match(debugCode, /^\d{6}$/);

  const me = await useSessionStore.getState().verifyOtp(requestId, debugCode, 'login');
  const s = useSessionStore.getState();
  assert.equal(s.status, 'authed');
  assert.ok(s.token, 'token stored in the session store');
  assert.equal(me.staff.phone, '+255700000002', 'staff profile identifies the signed-in user');
  assert.ok(s.perms.includes('orders:manage'), 'manager profile permissions loaded');
});

test('session: wrong OTP is rejected with OTP_INVALID and state stays anon', async () => {
  useSessionStore.setState({ status: 'anon', token: null, me: null, perms: [] });
  const { requestId } = await useSessionStore.getState().requestOtp('+255700000003', 'login');
  await assert.rejects(
    () => useSessionStore.getState().verifyOtp(requestId, '000000', 'login'),
    (e: unknown) => e instanceof ApiError && e.code === 'OTP_INVALID',
  );
  const s = useSessionStore.getState();
  assert.equal(s.status, 'anon');
  assert.equal(s.token, null);
});

test('session: restore() rehydrates from a stored token; logout revokes and clears', async () => {
  useSessionStore.setState({ status: 'boot', token: null, me: null, perms: [] });
  setToken(ownerToken);
  await useSessionStore.getState().restore();
  let s = useSessionStore.getState();
  assert.equal(s.status, 'authed');
  assert.equal(s.me?.merchant.phone, '+255700000000');

  await useSessionStore.getState().logout();
  s = useSessionStore.getState();
  assert.equal(s.status, 'anon');
  assert.equal(s.token, null);
  assert.equal(s.me, null);
  assert.equal(localStorage.getItem('merchant.token'), null, 'logout clears the stored token');

  // logout revoked the owner session — re-issue one so later tests stay authorized
  const again = await useSessionStore.getState().requestOtp('+255700000000', 'login');
  await useSessionStore.getState().verifyOtp(again.requestId, again.debugCode, 'login');
  ownerToken = useSessionStore.getState().token;
  assert.ok(ownerToken, 'fresh owner session token issued');
});

test('session: restore() with an invalid token and no refresh token falls back to anon', async () => {
  useSessionStore.setState({ status: 'boot', token: null, me: null, perms: [] });
  // A stored refresh token would auto-recover the session (401 → refresh →
  // retry, API.md); clearing it pins the "no recovery possible" → anon path.
  setRefreshToken(null);
  setToken('definitely-not-a-session-token');
  await useSessionStore.getState().restore();
  const s = useSessionStore.getState();
  assert.equal(s.status, 'anon');
  assert.equal(s.me, null);
});

test('auth: login wrapper returns false on a bad code and leaves the session anon', async () => {
  useSessionStore.setState({ status: 'anon', token: null, me: null, perms: [] });
  const ok = await useAuthStore.getState().login('+255700000003', '000000');
  assert.equal(ok, false);
  assert.equal(useSessionStore.getState().status, 'anon');
});

/* ================= Orders ================= */

test('orders: hydrate loads the seeded queue including new + preparing', async () => {
  useOrderStore.setState({ orders: [], loaded: false });
  await useOrderStore.getState().hydrate();
  const s = useOrderStore.getState();
  assert.equal(s.loaded, true);
  assert.ok(s.orders.length >= 4, 'seeded orders loaded');
  assert.ok(s.orders.some((o) => o.status === 'new'));
  assert.ok(s.orders.some((o) => o.status === 'preparing'));
});

test('orders: acceptOrder moves a new order to preparing (server-confirmed)', async () => {
  useOrderStore.setState({ orders: [], loaded: false });
  await useOrderStore.getState().hydrate();
  const target = useOrderStore.getState().orders.find((o) => o.status === 'new')!;
  assert.ok(target, 'a new order is available');
  await useOrderStore.getState().acceptOrder(target.id);
  const order = useOrderStore.getState().orders.find((o) => o.id === target.id)!;
  assert.equal(order.status, 'preparing');
  assert.equal(db.table('orders').find(target.id)?.status, 'preparing', 'server row advanced');
});

test('orders: acceptOrder survives a version conflict by refetching once', async () => {
  useOrderStore.setState({ orders: [], loaded: false });
  await useOrderStore.getState().hydrate();
  const target = useOrderStore.getState().orders.find((o) => o.status === 'new')!;
  // a concurrent device bumps the version between hydrate and accept
  db.table('orders').update(target.id, { version: (target.version ?? 1) + 1 });
  await useOrderStore.getState().acceptOrder(target.id);
  const order = useOrderStore.getState().orders.find((o) => o.id === target.id)!;
  assert.equal(order.status, 'preparing', 'conflict refetch + retry accepts the order');
  assert.ok((order.version ?? 0) >= 2, 'state carries the fresh server version');
});

test('orders: rejectOrder with a reason sets cancelled + cancelReason + reasonCode', async () => {
  useOrderStore.setState({ orders: [], loaded: false });
  await useOrderStore.getState().hydrate();
  const target = useOrderStore.getState().orders.find((o) => o.status === 'new')!;
  await useOrderStore.getState().rejectOrder(target.id, 'Store too busy', 'STORE_BUSY');
  const order = useOrderStore.getState().orders.find((o) => o.id === target.id)!;
  assert.equal(order.status, 'cancelled');
  assert.equal(order.cancelReason, 'Store too busy');
  assert.equal(db.table('orders').find(target.id)?.cancelReasonCode, 'STORE_BUSY', 'reasonCode persisted server-side');
});

test('orders: acceptAllOrders batch-accepts every queued new order', async () => {
  useOrderStore.setState({ orders: [], loaded: false });
  await useOrderStore.getState().hydrate();
  const queued = useOrderStore.getState().orders.filter((o) => o.status === 'new').map((o) => o.id);
  assert.ok(queued.length >= 1, 'at least one queued order');
  await useOrderStore.getState().acceptAllOrders();
  const s = useOrderStore.getState();
  for (const id of queued) {
    assert.equal(s.orders.find((o) => o.id === id)?.status, 'preparing', `batch-accepted ${id}`);
    assert.equal(db.table('orders').find(id)?.status, 'preparing', `${id} advanced server-side`);
  }
});

/* ================= Catalog ================= */

test('catalog: hydrate loads products + categories', async () => {
  useCatalogStore.setState({ products: [], categories: [], loaded: false });
  await useCatalogStore.getState().hydrate();
  const s = useCatalogStore.getState();
  assert.equal(s.loaded, true);
  assert.ok(s.products.length >= 20, 'full product list loaded');
  assert.ok(s.categories.length >= 3);
  assert.ok(s.products.some((p) => p.id === 'p1'));
});

test('catalog: toggleVisible flips visibility and persists to the server', async () => {
  useCatalogStore.setState({ products: [], categories: [], loaded: false });
  await useCatalogStore.getState().hydrate();
  const wasVisible = useCatalogStore.getState().products.find((p) => p.id === 'p1')?.visible ?? true;
  await useCatalogStore.getState().toggleVisible('p1');
  let after = useCatalogStore.getState().products.find((p) => p.id === 'p1')!;
  assert.equal(after.visible, !wasVisible);
  assert.equal(db.table('products').find('p1')?.visible, !wasVisible, 'visibility persisted server-side');
  await useCatalogStore.getState().toggleVisible('p1');
  after = useCatalogStore.getState().products.find((p) => p.id === 'p1')!;
  assert.equal(after.visible, wasVisible, 'toggle restores the original visibility');
});

test('catalog: createProduct appends to state; adjustStock round-trips; deleteProduct removes', async () => {
  useCatalogStore.setState({ products: [], categories: [], loaded: false });
  await useCatalogStore.getState().hydrate();
  const before = useCatalogStore.getState().products.length;
  const created = await useCatalogStore.getState().createProduct({ name: 'Test Skewer', price: 12, categoryId: 'c1', stock: 10 });
  assert.ok(created?.id, 'product created');
  assert.equal(useCatalogStore.getState().products.length, before + 1);
  assert.ok(db.table('products').find(created.id), 'product persisted server-side');

  await useCatalogStore.getState().adjustStock(created.id, 7);
  assert.equal(useCatalogStore.getState().products.find((p) => p.id === created.id)?.stock, 7);

  const deleted = await useCatalogStore.getState().deleteProduct(created.id);
  assert.equal(deleted, true);
  assert.ok(!useCatalogStore.getState().products.some((p) => p.id === created.id), 'product removed from state');
});

/* ================= Finance ================= */

test('finance: hydrate loads cents-exact TZS ledger shape + settlements + invoices', async () => {
  useFinanceStore.setState({ balance: 0, pendingSettlement: 0, transactions: [], settlements: [], invoices: [], loaded: false });
  await useFinanceStore.getState().hydrate();
  const s = useFinanceStore.getState();
  assert.equal(s.loaded, true);
  assert.ok(Number.isFinite(s.balance) && s.balance >= 0);
  assert.equal(Math.round(s.balance * 100) / 100, s.balance, 'balance is cents-exact (no float drift)');
  assert.ok(s.transactions.length > 0);
  for (const t of s.transactions) {
    assert.equal(Math.round(t.amount * 100) / 100, t.amount, `amount ${t.id} is cents-exact`);
    assert.ok(['order', 'commission', 'withdraw', 'refund'].includes(t.type), `type ${t.type} mapped`);
  }
  assert.ok(s.settlements.length > 0);
  for (const set of s.settlements) {
    assert.equal(Math.round((set.gross - set.commission - set.tax) * 100) / 100, set.net, 'settlement reconciles gross - fees');
    assert.ok(['paid', 'pending'].includes(set.payoutStatus));
  }
  assert.ok(s.invoices.length > 0);
  const pending = s.settlements.filter((x) => x.payoutStatus === 'pending').reduce((sum, x) => sum + x.net, 0);
  assert.equal(Math.round(pending * 100) / 100, s.pendingSettlement, 'pendingSettlement sums pending nets');
});

/* ================= Campaigns ================= */

test('campaigns: hydrate lists mine + platform; createCampaign prepends; stopCampaign expires', async () => {
  useCampaignStore.setState({ campaigns: [], platformCampaigns: [] });
  await useCampaignStore.getState().hydrate();
  assert.ok(useCampaignStore.getState().campaigns.length > 0, 'my campaigns loaded');
  assert.ok(useCampaignStore.getState().platformCampaigns.length > 0, 'platform campaigns loaded');

  const before = useCampaignStore.getState().campaigns.length;
  await useCampaignStore.getState().createCampaign({
    type: 'coupon',
    title: 'Test ¥10 off',
    budget: 100,
    start: Date.now() - 1000,
    end: Date.now() + 86400000,
    couponAmount: 10,
    target: 'All',
    productIds: [],
  });
  let s = useCampaignStore.getState();
  assert.equal(s.campaigns.length, before + 1);
  assert.equal(s.campaigns[0].title, 'Test ¥10 off');
  assert.equal(s.campaigns[0].status, 'active', 'live campaign starts active');

  const id = s.campaigns[0].id;
  await useCampaignStore.getState().stopCampaign(id);
  s = useCampaignStore.getState();
  assert.equal(s.campaigns[0].status, 'expired', 'stopped campaign marked expired in state');
  assert.equal(db.table('campaigns').find(id)?.status, 'expired', 'stopped campaign persisted server-side');
});

/* ================= Coupons (redemption) ================= */

test('coupons: verify redeems a valid code + updates stats; duplicate and expired rejected', async () => {
  useCouponStore.setState({ records: [], stats: { count: 0, totalAmount: 0 } });
  await useCouponStore.getState().hydrate();
  const beforeCount = useCouponStore.getState().stats.count;
  const beforeTotal = useCouponStore.getState().stats.totalAmount;
  assert.ok(Number.isInteger(beforeTotal), 'hydrated TZS totals are integers');

  const res = await useCouponStore.getState().verify('MT6666');
  assert.equal(res.ok, true);
  assert.equal(res.amount, 15);
  let s = useCouponStore.getState();
  assert.equal(s.stats.count, beforeCount + 1, 'stats.count incremented');
  assert.equal(s.stats.totalAmount, beforeTotal + 15, 'stats.totalAmount reflects the redemption');
  assert.ok(Number.isInteger(s.stats.totalAmount), 'TZS totals stay integer');
  assert.equal(s.records.find((r) => r.code === 'MT6666')?.status, 'redeemed');

  const again = await useCouponStore.getState().verify('MT6666');
  assert.equal(again.ok, false);
  assert.match(again.reason ?? '', /already been redeemed/i);
  assert.equal(useCouponStore.getState().stats.count, s.stats.count, 'duplicate verify does not double-count');

  const expired = await useCouponStore.getState().verify('BBQ2026');
  assert.equal(expired.ok, false);
  assert.match(expired.reason ?? '', /expired/i);
});

/* ================= Store settings ================= */

test('store: hydrate maps server fields; toggleOpen flips and persists', async () => {
  const server = await api.get<{ store: StoreServer }>('/stores/s_demo');
  useStoreStore.getState().hydrate(server.store);
  let s = useStoreStore.getState();
  assert.equal(s.store.name, 'Skewer House BBQ · Kariakoo');
  assert.equal(s.store.open, true);
  assert.equal(s.store.minOrder, 30);

  await useStoreStore.getState().toggleOpen();
  s = useStoreStore.getState();
  assert.equal(s.store.open, false, 'toggle flips the local state');
  await waitFor(() => db.table('stores').find('s_demo')?.open === false, 'toggle PATCH to reach the server');
  assert.equal(db.table('stores').find('s_demo')?.open, false, 'toggle persisted server-side');

  await useStoreStore.getState().toggleOpen();
  await waitFor(() => db.table('stores').find('s_demo')?.open === true, 'restore PATCH to reach the server');
  assert.equal(db.table('stores').find('s_demo')?.open, true, 'store restored to open');
});

test('store: updateOrderSettings merges locally and persists server-side', async () => {
  const server = await api.get<{ store: StoreServer }>('/stores/s_demo');
  useStoreStore.getState().hydrate(server.store);
  const original = { ...useStoreStore.getState().orderSettings };
  useStoreStore.getState().updateOrderSettings({ autoAccept: true });
  const s = useStoreStore.getState();
  assert.equal(s.orderSettings.autoAccept, true);
  assert.equal(s.orderSettings.preOrderEnabled, true, 'unpatched keys preserved');
  await waitFor(() => db.table('stores').find('s_demo')?.orderSettings.autoAccept === true, 'orderSettings PATCH to reach the server');
  assert.equal(db.table('stores').find('s_demo')?.orderSettings.autoAccept, true);
  useStoreStore.getState().updateOrderSettings({ autoAccept: original.autoAccept });
  await waitFor(() => db.table('stores').find('s_demo')?.orderSettings.autoAccept === original.autoAccept, 'orderSettings restore PATCH');
});

/* ================= Chat & messages ================= */

test('chat: hydrate loads threads; send appends the message and clears unread', async () => {
  useChatStore.setState({ threads: [], unreadTotal: 0 });
  await useChatStore.getState().hydrate();
  let s = useChatStore.getState();
  const ch1 = s.threads.find((t) => t.id === 'ch1');
  assert.ok(ch1, 'seeded thread present');
  assert.ok(s.unreadTotal >= 1, 'seeded unread count');

  await useChatStore.getState().send('ch1', 'Coming right up!');
  s = useChatStore.getState();
  const updated = s.threads.find((t) => t.id === 'ch1')!;
  assert.equal(updated.lastMessage, 'Coming right up!');
  assert.ok(updated.messages.some((m) => m.text === 'Coming right up!'), 'message appended to the thread');
  assert.equal(updated.unread, 0, 'merchant reply clears the unread flag');

  useChatStore.getState().markRead('ch1');
  assert.equal(useChatStore.getState().threads.find((t) => t.id === 'ch1')?.unread, 0);
});

test('messages: hydrate loads notifications; markAllRead marks every message read', async () => {
  useMessageStore.setState({ messages: [] });
  await useMessageStore.getState().hydrate();
  const s = useMessageStore.getState();
  assert.ok(s.messages.length > 0, 'notifications loaded');
  assert.ok(s.messages.some((m) => !m.read), 'seed includes unread notifications');

  useMessageStore.getState().markAllRead();
  assert.ok(useMessageStore.getState().messages.every((m) => m.read), 'all local messages marked read');
  await waitFor(
    async () => {
      const res = await api.get<{ unread: number }>('/notifications');
      return res.unread === 0;
    },
    'markAllRead to reach the server',
  );
});

/* ================= Reviews ================= */

test('reviews: hydrate loads reviews + average; reply attaches the reply text', async () => {
  useReviewStore.setState({ reviews: [], avgRating: 0 });
  await useReviewStore.getState().hydrate();
  const s = useReviewStore.getState();
  assert.ok(s.reviews.length > 0, 'reviews loaded');
  assert.ok(s.avgRating > 0, 'average rating computed');
  const target = s.reviews.find((r) => !r.reply);
  assert.ok(target, 'seed includes an unreplied review');

  await useReviewStore.getState().reply(target.id, 'Thank you — we will do better!');
  const updated = useReviewStore.getState().reviews.find((r) => r.id === target.id)!;
  assert.equal(updated.reply, 'Thank you — we will do better!');
  assert.equal(db.table('reviews').find(target.id)?.reply, 'Thank you — we will do better!', 'reply persisted server-side');
});
