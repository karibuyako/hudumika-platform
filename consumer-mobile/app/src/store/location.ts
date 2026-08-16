/* Selected city + service area (client-only, persisted). Marketplace data
 * (merchants, delivery fees, ETAs) always comes from the server keyed by this. */
import { create } from 'zustand';
import type { ServiceArea } from '@hudumika/contract';

export interface SelectedCity {
  id: string;
  name: string;
  /** Chosen/detected service area (id or name) within the city. */
  serviceArea?: string;
  /** The city's serviceable areas — used by address service-area validation
   * (kept here so stores/screens never re-fetch the cities list). */
  serviceAreas?: ServiceArea[];
}

const KEY = 'consumer.city';

function load(): SelectedCity | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as SelectedCity) : null;
  } catch {
    return null;
  }
}

interface LocationState {
  city: SelectedCity | null;
  addressLabel: string | null;
  setCity: (city: SelectedCity) => void;
  setAddressLabel: (label: string | null) => void;
}

export const useLocationStore = create<LocationState>()((set) => ({
  city: load(),
  addressLabel: null,
  setCity: (city) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(city));
    } catch {
      /* storage unavailable */
    }
    set({ city });
  },
  setAddressLabel: (addressLabel) => set({ addressLabel }),
}));
