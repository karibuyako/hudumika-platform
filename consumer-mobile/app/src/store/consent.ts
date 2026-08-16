/* Privacy/consent layer (MASTER-BLUEPRINT §21): per-purpose, revocable
 * consent persisted locally. Consent is the user's choice record — it gates
 * which system prompts are shown and what the app may collect; it never
 * replaces the OS permission prompt (that stays with the OS dialogs).
 *
 * Persistence follows the addresses store pattern: read once at module load,
 * write-through on every change.
 */
import { create } from 'zustand';

export const CONSENT_PURPOSES = [
  'location',
  'notifications',
  'marketing',
  'contacts',
  'camera',
  'microphone',
  'photos',
  'backgroundLocation',
  'personalization',
] as const;

export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export type ConsentMap = Record<ConsentPurpose, boolean>;

const KEY = 'consumer.consents';

function defaults(): ConsentMap {
  return Object.fromEntries(CONSENT_PURPOSES.map((p) => [p, false])) as ConsentMap;
}

function load(): ConsentMap {
  const d = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const parsed = JSON.parse(raw) as Partial<ConsentMap>;
    return { ...d, ...parsed };
  } catch {
    return d;
  }
}

function persist(consents: ConsentMap) {
  try {
    localStorage.setItem(KEY, JSON.stringify(consents));
  } catch {
    /* storage unavailable */
  }
}

interface ConsentState {
  consents: ConsentMap;
  grant: (purpose: ConsentPurpose) => void;
  revoke: (purpose: ConsentPurpose) => void;
}

export const useConsentStore = create<ConsentState>()((set, get) => ({
  consents: load(),

  grant: (purpose) => {
    if (get().consents[purpose]) return;
    const consents = { ...get().consents, [purpose]: true };
    persist(consents);
    set({ consents });
  },

  revoke: (purpose) => {
    if (!get().consents[purpose]) return;
    const consents = { ...get().consents, [purpose]: false };
    persist(consents);
    set({ consents });
  },
}));
