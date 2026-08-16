/* In-memory marketing repository — GET /marketing/live-deals (LIVE DEALS
 * ZONE, 神抢手-lite): scheduled flash-sale sessions with countdowns, plus the
 * live broadcast CHAT (GET/POST /marketing/live-deals/{id}/chat — mock-only
 * until the contract ships a live-chat surface, docs/CONTRACT-ADDITIONS.md
 * #20, parity harness allow-list).
 *
 * The mock is the server: session status is DERIVED from the current time at
 * list time (a session whose startsAt ≤ now < endsAt is 'live'; before its
 * startsAt it is 'scheduled'; from its endsAt onward it is 'ended') — the
 * seeded `status` field is never trusted, mirroring the live backend.
 *
 * Seeds are module-local (mockState.ts stays untouched — it owns the shared
 * merchant registry, READ-ONLY here): every deal references a REAL seeded
 * merchant by id, and merchantName is copied from the merchant record so the
 * demo list always resolves against the store. resetMockState() re-seeds the
 * merchant registry; resetMockMarketingState() re-seeds this module.
 */
import { ApiError } from '@/api/client';
import { uid } from '@/lib/format';
import { clone, getState } from './mockState';
import type { LiveDealSession } from '@hudumika/contract';
import type { LiveChatMessage, LiveDealsResult, MarketingRepository } from '../index';

/** Dev/test-only clock seam: fixed "now" (ms epoch) used by the status
 * derivation. Pass null to return to the real wall clock. */
let mockNow: number | null = null;

export function setMockNow(now: number | null): void {
  mockNow = now;
}

function currentNow(): number {
  return mockNow ?? Date.now();
}

const HOUR_MS = 3_600_000;

/** A session is live while startsAt ≤ now < endsAt; before that it is
 * scheduled; from endsAt onward it is ended (boundaries: startsAt inclusive,
 * endsAt exclusive). */
export function deriveLiveDealStatus(session: Pick<LiveDealSession, 'startsAt' | 'endsAt'>, now: number): LiveDealSession['status'] {
  const start = Date.parse(session.startsAt);
  const end = Date.parse(session.endsAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return 'ended';
  if (now < start) return 'scheduled';
  if (now >= end) return 'ended';
  return 'live';
}

interface SeedSession {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  deals: { merchantIndex: number; title: string; priceTZS: number; originalPriceTZS: number; quantityLimit: number }[];
}

let seeds: SeedSession[] | null = null;

function buildSeeds(now: number): SeedSession[] {
  const iso = (ms: number) => new Date(ms).toISOString();
  return [
    {
      id: 'lds_live_001',
      title: 'Midday Flash Feast',
      // Live NOW: started an hour ago, runs for two more hours.
      startsAt: iso(now - HOUR_MS),
      endsAt: iso(now + 2 * HOUR_MS),
      deals: [
        { merchantIndex: 0, title: 'Chicken & Chips two-for-one', priceTZS: 12000, originalPriceTZS: 24000, quantityLimit: 2 },
        { merchantIndex: 1, title: 'Family beef pilau bucket', priceTZS: 30000, originalPriceTZS: 45000, quantityLimit: 4 },
        { merchantIndex: 2, title: 'Nyama choma platter', priceTZS: 18000, originalPriceTZS: 25000, quantityLimit: 2 },
      ],
    },
    {
      id: 'lds_sched_002',
      title: 'Evening Chill Deals',
      // Scheduled: starts tomorrow at the same local moment, runs three hours.
      startsAt: iso(now + 26 * HOUR_MS),
      endsAt: iso(now + 29 * HOUR_MS),
      deals: [
        { merchantIndex: 3, title: 'Samaki wa kupaka + ugali', priceTZS: 9000, originalPriceTZS: 13000, quantityLimit: 3 },
        { merchantIndex: 4, title: 'Mango smoothie pair', priceTZS: 6000, originalPriceTZS: 8000, quantityLimit: 5 },
      ],
    },
  ];
}

function ensureSeeds(): void {
  if (seeds !== null) return;
  // Seeds are built relative to the CURRENT clock so setMockNow() drives both
  // the seed windows and the status derivation in tests.
  seeds = buildSeeds(currentNow());
}

/* ---- Live broadcast chat (mock-only-until-adopted, #20) ----
 * Module-local threads: seeded viewer messages per session (deterministic
 * timestamps relative to the clock seam so tests can pin them), plus the
 * user's own posts. postLiveChat is idempotent per key — the same key replays
 * the stored message and never double-posts (same rule as raise/create
 * elsewhere). */
interface SeedChatMessage {
  authorName: string;
  body: string;
  minutesAgo: number;
}

const chatSeeds: Record<string, SeedChatMessage[]> = {
  lds_live_001: [
    { authorName: 'Asha', body: 'That chicken and chips two-for-one is unbeatable', minutesAgo: 42 },
    { authorName: 'Juma', body: 'Anyone tried the nyama choma platter yet?', minutesAgo: 31 },
    { authorName: 'Neema', body: 'Just ordered the pilau bucket — will report back', minutesAgo: 12 },
    { authorName: 'Baraka', body: 'Limit of 2 per customer — moving fast!', minutesAgo: 4 },
  ],
  lds_sched_002: [],
};

const chatThreads = new Map<string, LiveChatMessage[]>();
const chatPostReplays = new Map<string, LiveChatMessage>();

export function resetMockLiveChatState(): void {
  chatThreads.clear();
  chatPostReplays.clear();
}

/** Resolve (and lazily build) the thread for a session; unknown sessions 404
 * with the generic NOT_FOUND code (no live-chat codes exist in the error
 * registry yet — flagging for Team 6). */
function ensureChatThread(sessionId: string): LiveChatMessage[] {
  const existing = chatThreads.get(sessionId);
  if (existing) return existing;
  if (!seeds!.some((s) => s.id === sessionId)) {
    throw new ApiError(404, 'NOT_FOUND', `Live deal session ${sessionId} not found`, false);
  }
  const now = currentNow();
  const thread = (chatSeeds[sessionId] ?? []).map((m, i) => ({
    id: `chat_${sessionId}_${i + 1}`,
    authorName: m.authorName,
    body: m.body,
    at: new Date(now - m.minutesAgo * 60_000).toISOString(),
  }));
  chatThreads.set(sessionId, thread);
  return thread;
}

export function resetMockMarketingState(): void {
  seeds = null;
  mockNow = null;
  resetMockLiveChatState();
}

function toSession(seed: SeedSession): LiveDealSession {
  const state = getState();
  const now = currentNow();
  const deals = seed.deals.map((d) => {
    const merchant = state.merchants[d.merchantIndex];
    if (!merchant) throw new ApiError(500, 'INTERNAL_ERROR', `Live-deal seed references unknown merchant index ${d.merchantIndex}`);
    return {
      merchantId: merchant.id,
      merchantName: merchant.businessName,
      title: d.title,
      priceTZS: d.priceTZS,
      originalPriceTZS: d.originalPriceTZS,
      quantityLimit: d.quantityLimit,
    };
  });
  return {
    id: seed.id,
    title: seed.title,
    startsAt: seed.startsAt,
    endsAt: seed.endsAt,
    status: deriveLiveDealStatus(seed, now),
    deals,
  };
}

export class MockMarketingRepository implements MarketingRepository {
  async listLiveDeals(): Promise<LiveDealsResult> {
    ensureSeeds();
    const sessions = seeds!.map(toSession).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    return { sessions: clone(sessions), nextCursor: null };
  }

  async fetchLiveChat(sessionId: string): Promise<LiveChatMessage[]> {
    ensureSeeds();
    return clone(ensureChatThread(sessionId));
  }

  async postLiveChat(sessionId: string, message: string, idempotencyKey: string): Promise<LiveChatMessage> {
    ensureSeeds();
    const replay = chatPostReplays.get(idempotencyKey);
    if (replay) return clone(replay);
    const thread = ensureChatThread(sessionId);
    if (!message.trim()) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Chat message must not be empty', false);
    }
    const sent: LiveChatMessage = {
      id: uid('chat'),
      // The seeded demo user always carries a fullName; the fallback covers
      // a payload without one (contract field is optional).
      authorName: getState().user.fullName ?? 'Demo Customer',
      body: message.trim(),
      at: new Date(currentNow()).toISOString(),
    };
    thread.push(sent);
    chatPostReplays.set(idempotencyKey, sent);
    return clone(sent);
  }
}
