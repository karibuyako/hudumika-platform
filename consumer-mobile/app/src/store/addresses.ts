/* Saved addresses (persistent local state — the offline cache). AddressSnapshot
 * is sent with the order/booking; lat/lon only for the active checkout context,
 * never analytics.
 *
 * Server sync: the contract has NO saved-address surface today — UserUpdate
 * (PATCH /users/me) supports only fullName/email/avatarUrl/locale, and no
 * addresses endpoint exists — so this store is the client draft + cache, and
 * the app NEVER seeds fake addresses or a fake contact phone (SECURITY.md: no
 * hardcoded phones). When the contract gains a saved-address surface, add a
 * hydrate()/push() seam here; until then the store is local-only.
 */
import { create } from 'zustand';
import type { AddressSnapshot } from '@hudumika/contract';
import { isServiceable } from '@/lib/geolocation';
import { uid } from '@/lib/format';
import { useLocationStore } from '@/store/location';

export interface SavedAddress extends AddressSnapshot {
  id: string;
  /** Service-area name the address belongs to (store-local — not in the
   * contract AddressSnapshot; used by isServiceable + the form chips). */
  serviceArea?: string;
  /** Store-local delivery instructions (contract AddressSnapshot has no field). */
  deliveryInstructions?: string;
}

const KEY = 'consumer.addresses';

function load(): SavedAddress[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as SavedAddress[]) : [];
  } catch {
    return [];
  }
}

function persist(addresses: SavedAddress[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(addresses));
  } catch {
    /* storage unavailable — keep in-memory draft */
  }
}

interface AddressesState {
  addresses: SavedAddress[];
  selectedId: string | null;
  addAddress: (a: Omit<SavedAddress, 'id'>) => SavedAddress;
  updateAddress: (id: string, patch: Partial<SavedAddress>) => void;
  removeAddress: (id: string) => void;
  setDefault: (id: string) => void;
  /** Select an address for checkout. Refuses (returns false) when the address
   * is outside the selected city's service areas, so checkout never submits
   * an unserviceable delivery address. */
  select: (id: string | null) => boolean;
}

export const useAddressesStore = create<AddressesState>()((set, get) => ({
  addresses: load(),
  selectedId: null,

  addAddress: (a) => {
    const address: SavedAddress = { ...a, id: uid('addr') };
    const addresses = [...get().addresses, address];
    persist(addresses);
    set({ addresses, selectedId: address.id });
    return address;
  },

  updateAddress: (id, patch) => {
    const addresses = get().addresses.map((a) => (a.id === id ? { ...a, ...patch } : a));
    persist(addresses);
    set({ addresses });
  },

  removeAddress: (id) => {
    const addresses = get().addresses.filter((a) => a.id !== id);
    persist(addresses);
    set({ addresses, selectedId: get().selectedId === id ? null : get().selectedId });
  },

  setDefault: (id) => {
    set({ selectedId: id });
  },

  select: (selectedId) => {
    if (selectedId) {
      const address = get().addresses.find((a) => a.id === selectedId);
      const city = useLocationStore.getState().city;
      if (address && !isServiceable(address, city)) {
        return false;
      }
    }
    set({ selectedId });
    return true;
  },
}));
