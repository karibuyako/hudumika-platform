/* Onboarding local state (MASTER-BLUEPRINT §3): the carousel skip flag and
 * the default payment-method preference (client-side only — the contract has
 * no payment-method mutation endpoints, so the default is honest device-local
 * state, never server truth).
 *
 * Persistence follows the addresses store pattern: read once at module load,
 * write-through on every change.
 */
import { create } from 'zustand';

const ONBOARDED_KEY = 'consumer.onboardingDone';
const PAYMENT_METHOD_KEY = 'consumer.paymentMethod';

function loadFlag(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === '1';
  } catch {
    return false;
  }
}

function saveFlag(v: boolean): void {
  try {
    localStorage.setItem(ONBOARDED_KEY, v ? '1' : '0');
  } catch {
    /* storage unavailable — keep in-memory flag */
  }
}

function loadDefaultMethod(): string | null {
  try {
    return localStorage.getItem(PAYMENT_METHOD_KEY);
  } catch {
    return null;
  }
}

function saveDefaultMethod(id: string | null): void {
  try {
    if (id) localStorage.setItem(PAYMENT_METHOD_KEY, id);
    else localStorage.removeItem(PAYMENT_METHOD_KEY);
  } catch {
    /* storage unavailable */
  }
}

interface OnboardingState {
  /** True once the carousel was completed or skipped — returning users jump
   * straight to the city picker. */
  onboardingDone: boolean;
  markOnboardingDone: () => void;
  /** Locally persisted default payment method id (client preference). */
  defaultMethodId: string | null;
  setDefaultMethod: (id: string | null) => void;
}

export const useOnboardingStore = create<OnboardingState>()((set, get) => ({
  onboardingDone: loadFlag(),
  defaultMethodId: loadDefaultMethod(),

  markOnboardingDone: () => {
    if (get().onboardingDone) return;
    saveFlag(true);
    set({ onboardingDone: true });
  },

  setDefaultMethod: (defaultMethodId) => {
    saveDefaultMethod(defaultMethodId);
    set({ defaultMethodId });
  },
}));

/** Storage-level read — a fresh app launch must skip the carousel without
 * relying on the module having been loaded (tests read this too). */
export function isOnboardingDone(): boolean {
  return loadFlag();
}
