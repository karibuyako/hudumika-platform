/**
 * Customer-side simulator.
 * Emulates the (external) customer platform + customer app pushing real
 * traffic into the merchant backend through the same HTTP API used in
 * production (authenticated with the internal service key).
 */

const INTERNAL_KEY = 'demo-customer-platform';

const CUSTOMER_MSGS = [
  'Hi, will my order take long?',
  'Could you add extra chili sauce?',
  'Do you deliver to Mlimani City?',
  'Is the lamb skewer spicy?',
  'Can I change my pickup time to 19:00?',
];

const REFUND_REASONS = [
  'Item arrived cold',
  'Wrong item received',
  'Missing side dish',
  'Food spilled in transit',
  'Too spicy for my taste',
];

const RUSH_NOTES = [
  'Sorry to rush — my meeting starts soon',
  'Can you prioritize this one? In a hurry',
  'Please deliver before 12:30 if possible',
  'Rushing this order, lunch break is short',
];

let orderToken: ReturnType<typeof setTimeout> | null = null;
let ambientToken: ReturnType<typeof setTimeout> | null = null;
let started = false;

const rand = (min: number, max: number) => min + Math.floor(Math.random() * (max - min));

async function internalFetch(path: string, body: unknown) {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-key': INTERNAL_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error?.message ?? `internal call failed (${res.status})`);
  }
  return res.json();
}

async function placeOrder() {
  const catalog = (await fetch('/api/products', { headers: { 'x-internal-key': INTERNAL_KEY } })
    .then((r) => r.json())
    .catch(() => ({}))) as { products?: { id: string; name: string; price: number }[] };
  const products = (catalog.products ?? []).filter((p) => p.price > 0);
  if (!products.length) return;
  const picked = [...products].sort(() => Math.random() - 0.5).slice(0, rand(1, 3));
  const items = picked.map((p) => ({ productId: p.id, qty: rand(1, 2), variants: [] }));
  let subtotal = items.reduce((s, i) => {
    const p = products.find((x) => x.id === i.productId);
    return s + (p?.price ?? 0) * i.qty;
  }, 0);
  for (const p of products) {
    if (subtotal >= 30 || items.length >= 6) break;
    if (items.some((i) => i.productId === p.id)) continue;
    items.push({ productId: p.id, qty: 1, variants: [] });
    subtotal += p.price;
  }
  const scheduled = Math.random() < 0.08;
  try {
    await internalFetch('/orders', {
      items,
      deliveryType: Math.random() < 0.12 ? 'pickup' : 'delivery',
      note: Math.random() < 0.2 ? 'No cilantro, extra spicy please' : '',
      scheduledAt: scheduled ? Date.now() + rand(30, 90) * 60000 : undefined,
    });
  } catch {
    /* out of stock etc — retry later */
  }
}

async function ambientEvent() {
  const roll = Math.random();
  try {
    if (roll < 0.3) {
      // Customer messages a merchant
      const threads = (await fetch('/api/chat/threads', { headers: { 'x-internal-key': INTERNAL_KEY } })
        .then((r) => r.json())
        .catch(() => ({}))) as { threads?: { id: string }[] };
      const list = threads.threads ?? [];
      if (list.length) {
        const t = list[rand(0, list.length)];
        await internalFetch(`/chat/threads/${t.id}/customer-messages`, {
          text: CUSTOMER_MSGS[rand(0, CUSTOMER_MSGS.length)],
        });
      }
    } else if (roll < 0.5) {
      // Customer requests a refund on a completed order
      const orders = (await fetch('/api/orders?status=completed', { headers: { 'x-internal-key': INTERNAL_KEY } })
        .then((r) => r.json())
        .catch(() => ({}))) as { orders?: { id: string; refund?: unknown }[] };
      const eligible = (orders.orders ?? []).filter((o) => !o.refund);
      if (eligible.length) {
        const o = eligible[rand(0, eligible.length)];
        await internalFetch(`/orders/${o.id}/refund`, {
          reason: REFUND_REASONS[rand(0, REFUND_REASONS.length)],
          reasonCode: 'CUSTOMER_REQUEST',
        });
      }
    } else if (roll < 0.6) {
      // Customer rushes a pending order
      const orders = (await fetch('/api/orders?status=new', { headers: { 'x-internal-key': INTERNAL_KEY } })
        .then((r) => r.json())
        .catch(() => ({}))) as { orders?: { id: string }[] };
      const list = orders.orders ?? [];
      if (list.length) {
        const o = list[rand(0, list.length)];
        await internalFetch(`/orders/${o.id}/rush`, { note: RUSH_NOTES[rand(0, RUSH_NOTES.length)] });
      }
    }
  } catch {
    /* transient */
  }
}

function scheduleOrder() {
  orderToken = setTimeout(async () => {
    await placeOrder();
    scheduleOrder();
  }, rand(22000, 55000));
}

function scheduleAmbient() {
  ambientToken = setTimeout(async () => {
    await ambientEvent();
    scheduleAmbient();
  }, rand(90000, 200000));
}

export function startSimulator() {
  if (started) return;
  started = true;
  scheduleOrder();
  scheduleAmbient();
}

export function stopSimulator() {
  started = false;
  if (orderToken) clearTimeout(orderToken);
  if (ambientToken) clearTimeout(ambientToken);
  orderToken = null;
  ambientToken = null;
}
