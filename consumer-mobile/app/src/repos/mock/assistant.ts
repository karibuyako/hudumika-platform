/* In-memory assistant repository — POST /assistant/chat (Xiaomei-lite,
 * mock-first: the mock IS the server until the model ships).
 *
 * Replies and suggestions are SERVER text: the screen renders them verbatim,
 * never through i18n. Live replies will come from the model — this rule-based
 * engine only mirrors that contract (reply + suggestions + contextUsed).
 *
 * Deterministic keyword intent matching over the seeded domain (mockState.ts):
 * a message matches the FIRST intent whose keyword list it hits; every intent
 * returns a short (1–3 sentence) canned reply with 2–3 tappable suggestions
 * and contextUsed reflecting the matched intent. Unknown messages get the
 * helpful fallback. Validation mirrors the contract body: message is required
 * and maxLength 1000 (422 VALIDATION_FAILED otherwise).
 *
 * ASSISTANT_GREETING is exported for the screen's first-open bubble — the
 * greeting intent serves a fresh copy of the same data, so the copy lives in
 * exactly one place (the server-owned module). */
import { ApiError } from '@/api/client';
import { getState } from './mockState';
import type { MockState } from './mockState';
import type { AssistantReply } from '@hudumika/contract';
import type { AssistantRepository } from '../index';

const MAX_MESSAGE_LENGTH = 1000;

/** Server-owned first-open copy (rendered verbatim, like any reply). */
export const ASSISTANT_GREETING: AssistantReply = {
  reply: "Habari! I'm Xiaomei, your HUDumika assistant — I can help you order food, book services, track orders and more. What would you like to do?",
  suggestions: ['Order food', 'Book a service', 'Get help'],
  contextUsed: ['intent:greeting'],
};

type IntentKey = 'greeting' | 'payment' | 'vertical' | 'booking' | 'food' | 'help' | 'order' | 'account';

const INTENTS: { key: IntentKey; keywords: string[] }[] = [
  { key: 'greeting', keywords: ['hello', 'hi', 'hey', 'jambo', 'habari', 'morning', 'evening', 'thanks', 'thank'] },
  { key: 'payment', keywords: ['pay', 'payment', 'refund', 'mpesa', 'card', 'wallet', 'money', 'charge', 'cash', 'airtel', 'tigo', 'halotel', 'ezy'] },
  { key: 'vertical', keywords: ['hotel', 'travel', 'trip', 'flight', 'event', 'stay', 'accommodation', 'vacation', 'holiday', 'bus', 'train'] },
  { key: 'booking', keywords: ['booking', 'service', 'plumber', 'clean', 'repair', 'provider', 'reservation', 'electrician', 'technician'] },
  { key: 'food', keywords: ['food', 'restaurant', 'eat', 'hungry', 'dish', 'menu', 'chips', 'pilau', 'chicken', 'drink', 'meal', 'lunch', 'dinner', 'snack', 'chapati', 'fish'] },
  { key: 'help', keywords: ['help', 'support', 'ticket', 'issue', 'problem', 'complain', 'agent', 'human'] },
  { key: 'order', keywords: ['order', 'track', 'deliver', 'rider', 'cancel', 'reorder', 'waybill', 'eta', 'shipment'] },
  { key: 'account', keywords: ['account', 'profile', 'name', 'address', 'password', 'language', 'phone'] },
];

/** Tokenizer: lowercase, strip punctuation, split on whitespace. */
function tokens(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function matches(text: string, keywords: string[]): boolean {
  const toks = tokens(text);
  return keywords.some((kw) => toks.some((tok) => tok === kw || tok.startsWith(kw)));
}

function replyFor(key: IntentKey): AssistantReply {
  const state = getState();
  let reply: string;
  let suggestions: string[];
  switch (key) {
    case 'greeting':
      return { ...ASSISTANT_GREETING, suggestions: [...ASSISTANT_GREETING.suggestions] };
    case 'payment':
      reply = 'We support M-Pesa, Tigo Pesa, Airtel Money, cards and cash on delivery. Refunds land back in your wallet or original payment method within a few days.';
      suggestions = ['Check my wallet', 'Payment methods', 'Get help'];
      break;
    case 'vertical':
      reply = 'We now cover hotels, travel and events too — book a stay, plan a trip or find tickets, all in one place.';
      suggestions = ['Book a hotel', 'Plan a trip', 'Browse events'];
      break;
    case 'booking': {
      const hasBooking = state.bookings.length > 0;
      reply = hasBooking
        ? 'Your service bookings live in the Bookings section — track, reschedule or cancel them there. I can also point you to the right service category.'
        : 'You can book services like plumbing, cleaning and repairs from the Services tab. I can point you to the right category.';
      suggestions = ['Book a service', 'View my bookings', 'Get help'];
      break;
    }
    case 'food': {
      const dishes = popularDishes(state, 3);
      reply = dishes.length
        ? `Try ${dishes.join(', ')} from ${state.merchants[0]?.businessName ?? 'our merchants'} — all popular right now. Browse the full menu in the app, or I can help you reorder something.`
        : 'You can browse restaurants on the Home tab and order anything from their menus. I can help you pick something popular.';
      suggestions = ['Order food', 'Browse restaurants', 'View my orders'];
      break;
    }
    case 'help':
      reply = 'For anything that needs a human, open a support ticket or browse the help center from the Me tab. I can also answer quick questions right here.';
      suggestions = ['Open a support ticket', 'Browse help articles', 'Ask something else'];
      break;
    case 'order': {
      const active = state.orders.find((o) => o.id === 'ord_active_001');
      reply = active
        ? `You can track ${active.no ?? active.id} in the Orders tab — open it for live rider location, or chat with the merchant. Cancelling and reordering work from there too.`
        : 'You can track your orders in the Orders tab — open any order for live rider location, or chat with the merchant. Cancellations and reorders live there too.';
      suggestions = ['Track my order', 'Cancel an order', 'Reorder last order'];
      break;
    }
    case 'account':
      reply = 'Your profile, addresses and security settings live in the Me tab — you can update your name, language and payment methods there.';
      suggestions = ['Update my profile', 'Manage addresses', 'Get help'];
      break;
  }
  return { reply, suggestions, contextUsed: [`intent:${key}`] };
}

/** Up to n dish names from the seeded catalogues (deterministic per seed). */
function popularDishes(state: MockState, n: number): string[] {
  const first = state.catalogues.values().next().value;
  return (first?.items ?? []).slice(0, n).map((i) => i.name);
}

function matchIntent(message: string): IntentKey | 'unknown' {
  for (const intent of INTENTS) {
    if (matches(message, intent.keywords)) return intent.key;
  }
  return 'unknown';
}

function unknownReply(): AssistantReply {
  return {
    reply: "I'm not sure I caught that — but I can help you order food, book a service or track an order. Try one of these:",
    suggestions: ['Order food', 'Book a service', 'Get help'],
    contextUsed: ['intent:unknown'],
  };
}

function assertValidMessage(message: string): void {
  const trimmed = message.trim();
  if (!trimmed) throw new ApiError(422, 'VALIDATION_FAILED', 'Message cannot be empty');
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    throw new ApiError(422, 'VALIDATION_FAILED', `Message exceeds the ${MAX_MESSAGE_LENGTH}-character limit`);
  }
}

export class MockAssistantRepository implements AssistantRepository {
  async chat(message: string, _context?: Record<string, unknown>): Promise<AssistantReply> {
    assertValidMessage(message);
    const key = matchIntent(message);
    return key === 'unknown' ? unknownReply() : replyFor(key);
  }
}
