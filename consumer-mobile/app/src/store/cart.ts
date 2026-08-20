/* Client cart — a DRAFT only. Per-merchant CartGroups; each group becomes its
 * own Order (checkout is per group, see /checkout?merchantId=). Totals shown
 * are advisory previews; the server recomputes every price
 * (ORDER_PRICE_CHANGED → refresh catalogue). Money is integer TZS. */
import { create } from 'zustand';

export interface CartOptionChoice {
  group?: string;
  choice?: string;
}

export interface CartItem {
  catalogueItemId: string;
  name: string;
  /** BASE catalogue price only — option/addon prices are NOT folded in here.
   * The server validates this against the catalogue and prices options itself. */
  unitPriceTZS: number;
  quantity: number;
  /** Selected option-group choices ({group, choice} keyed lines). */
  options?: CartOptionChoice[];
  /** Selected addon names — sent to the server, which prices them. */
  addons?: string[];
  /** Advisory option+addon price preview (from the catalogue at add time).
   * Never sent to the server; shown in cart/checkout previews only. */
  optionsPriceTZS?: number;
  note?: string;
}

export interface CartGroup {
  merchantId: string;
  merchantName: string;
  items: CartItem[];
}

interface CartState {
  groups: CartGroup[];
  addItem: (group: { merchantId: string; merchantName: string }, item: CartItem) => void;
  updateQuantity: (merchantId: string, lineKey: string, delta: number) => void;
  setNote: (merchantId: string, lineKey: string, note: string) => void;
  removeItem: (merchantId: string, lineKey: string) => void;
  clearGroup: (merchantId: string) => void;
  clear: () => void;
}

const clampQty = (q: number) => Math.min(99, Math.max(1, Math.round(q)));

/** Stable line identity — variant lines of the same catalogue item (different
 * options/addons) are DISTINCT lines: every line-scoped action targets exactly
 * the line whose key matches, never all variants of the item. */
export function cartItemKey(i: CartItem): string {
  return `${i.catalogueItemId}|${JSON.stringify(i.options ?? [])}|${JSON.stringify(i.addons ?? [])}`;
}

export const useCartStore = create<CartState>()((set) => ({
  groups: [],

  addItem: (group, item) =>
    set((s) => {
      const existing = s.groups.find((g) => g.merchantId === group.merchantId);
      if (!existing) {
        return { groups: [...s.groups, { merchantId: group.merchantId, merchantName: group.merchantName, items: [{ ...item, quantity: clampQty(item.quantity) }] }] };
      }
      const groups = s.groups.map((g) => {
        if (g.merchantId !== group.merchantId) return g;
        const found = g.items.find((i) => cartItemKey(i) === cartItemKey(item));
        const items = found
          ? g.items.map((i) => (cartItemKey(i) === cartItemKey(item) ? { ...i, quantity: clampQty(i.quantity + item.quantity) } : i))
          : [...g.items, { ...item, quantity: clampQty(item.quantity) }];
        return { ...g, items };
      });
      return { groups };
    }),

  updateQuantity: (merchantId, lineKey, delta) =>
    set((s) => ({
      groups: s.groups
        .map((g) => {
          if (g.merchantId !== merchantId) return g;
          const isKey = lineKey.includes('|');
          const items = g.items
            .map((i) => {
              const match = isKey ? cartItemKey(i) === lineKey : i.catalogueItemId === lineKey;
              if (!match) return i;
              const next = i.quantity + delta;
              return next <= 0 ? { ...i, quantity: 0 } : { ...i, quantity: clampQty(next) };
            })
            .filter((i) => i.quantity > 0);
          return { ...g, items };
        })
        .filter((g) => g.items.length > 0),
    })),

  setNote: (merchantId, lineKey, note) =>
    set((s) => {
      const isKey = lineKey.includes('|');
      return {
        groups: s.groups.map((g) =>
          g.merchantId === merchantId
            ? { ...g, items: g.items.map((i) => ((isKey ? cartItemKey(i) === lineKey : i.catalogueItemId === lineKey) ? { ...i, note } : i)) }
            : g,
        ),
      };
    }),

  removeItem: (merchantId, lineKey) =>
    set((s) => {
      const isKey = lineKey.includes('|');
      return {
        groups: s.groups
          .map((g) =>
            g.merchantId === merchantId
              ? { ...g, items: g.items.filter((i) => (isKey ? cartItemKey(i) !== lineKey : i.catalogueItemId !== lineKey)) }
              : g,
          )
          .filter((g) => g.items.length > 0),
      };
    }),

  clearGroup: (merchantId) =>
    set((s) => ({ groups: s.groups.filter((g) => g.merchantId !== merchantId) })),

  clear: () => set({ groups: [] }),
}));

/* Advisory preview only — the server is the authority at checkout. Includes
 * the client-side option/addon preview (optionsPriceTZS); the server prices
 * options again from the catalogue. */
export function groupSubtotal(group: CartGroup): number {
  return group.items.reduce((acc, i) => acc + (i.unitPriceTZS + (i.optionsPriceTZS ?? 0)) * i.quantity, 0);
}
