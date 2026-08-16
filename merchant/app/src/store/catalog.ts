import { create } from 'zustand';

import { api } from '@/api/client';
import type { CategoryRow, ProductRow } from '@/api/types';

interface CatalogState {
  products: ProductRow[];
  categories: CategoryRow[];
  loaded: boolean;
  hydrate: () => Promise<void>;
  createProduct: (input: Partial<ProductRow> & { name: string; price: number }) => Promise<ProductRow | null>;
  updateProduct: (id: string, patch: Partial<ProductRow>) => Promise<ProductRow | null>;
  deleteProduct: (id: string) => Promise<boolean>;
  toggleVisible: (id: string) => Promise<void>;
  adjustStock: (id: string, set: number) => Promise<void>;
}

export const useCatalogStore = create<CatalogState>()((set, get) => ({
  products: [],
  categories: [],
  loaded: false,

  hydrate: async () => {
    try {
      const [productsRes, categoriesRes] = await Promise.all([
        api.get<{ products: ProductRow[] }>('/products', { retries: 1 }),
        api.get<{ categories: CategoryRow[] }>('/categories', { retries: 1 }),
      ]);
      set({ products: productsRes.products, categories: categoriesRes.categories, loaded: true });
    } catch {
      /* keep stale data */
    }
  },

  createProduct: async (input) => {
    try {
      const res = await api.post<{ product: ProductRow }>('/catalogue-items', input);
      set((s) => ({ products: [...s.products, res.product] }));
      return res.product;
    } catch {
      return null;
    }
  },

  updateProduct: async (id, patch) => {
    const prev = get().products;
    set((s) => ({ products: s.products.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
    try {
      const res = await api.patch<{ product: ProductRow }>(`/catalogue-items/${id}`, patch);
      set((s) => ({ products: s.products.map((p) => (p.id === id ? res.product : p)) }));
      return res.product;
    } catch {
      set({ products: prev });
      return null;
    }
  },

  deleteProduct: async (id) => {
    try {
      await api.delete(`/catalogue-items/${id}`);
      set((s) => ({ products: s.products.filter((p) => p.id !== id) }));
      return true;
    } catch {
      return false;
    }
  },

  toggleVisible: async (id) => {
    const p = get().products.find((x) => x.id === id);
    if (!p) return;
    await get().updateProduct(id, { visible: !p.visible });
  },

  adjustStock: async (id, set) => {
    await get().updateProduct(id, { stock: set });
  },
}));
