/* M16e — Assistant (Xiaomei-lite): POST /assistant/chat mock behavior.
 *
 * Covers: known-intent replies (typed AssistantReply, 2–3 suggestions,
 * contextUsed reflecting the intent), the exported greeting copy, seeded-
 * domain food suggestions, unknown → helpful fallback, and validation that
 * mirrors the contract body (message required, maxLength 1000 → 422
 * VALIDATION_FAILED). Reply copy is server-owned — assertions check shape,
 * length and determinism, never the exact strings. */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { rejectsApiError, resetMockState } from './helpers';
import { MockAssistantRepository, ASSISTANT_GREETING } from '@/repos/mock/assistant';
import { getState } from '@/repos/mock/mockState';

const assistant = new MockAssistantRepository();

beforeEach(() => resetMockState());

const KNOWN_INTENTS: { message: string; intent: string }[] = [
  { message: 'hello', intent: 'intent:greeting' },
  { message: 'my refund has not arrived yet', intent: 'intent:payment' },
  { message: 'book a hotel in Zanzibar', intent: 'intent:vertical' },
  { message: 'I need a plumber at my place', intent: 'intent:booking' },
  { message: 'I want to order chicken and chips', intent: 'intent:food' },
  { message: 'help me please', intent: 'intent:help' },
  { message: 'cancel my order', intent: 'intent:order' },
  { message: 'update my profile name', intent: 'intent:account' },
];

test('known intents return a typed AssistantReply with suggestions and the matched intent in contextUsed', async () => {
  for (const c of KNOWN_INTENTS) {
    const reply = await assistant.chat(c.message);
    assert.equal(typeof reply.reply, 'string', `${c.message}: reply is a string`);
    assert.ok(reply.reply.length > 0, `${c.message}: reply is non-empty`);
    assert.ok(Array.isArray(reply.suggestions), `${c.message}: suggestions is an array`);
    assert.ok(reply.suggestions.length >= 2 && reply.suggestions.length <= 3, `${c.message}: 2–3 suggestions`);
    assert.ok(reply.suggestions.every((s) => typeof s === 'string' && s.length > 0), `${c.message}: suggestions are non-empty strings`);
    assert.ok((reply.contextUsed ?? []).includes(c.intent), `${c.message} → ${c.intent}`);
    // Replies stay short: at most 3 sentences (server copy, rendered verbatim).
    const sentences = reply.reply.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    assert.ok(sentences.length <= 3, `${c.message}: reply stays short (${sentences.length} sentences)`);
  }
});

test('the greeting intent serves the exported first-open copy', async () => {
  const reply = await assistant.chat('Hello');
  assert.equal(reply.reply, ASSISTANT_GREETING.reply);
  assert.deepEqual(reply.suggestions, ASSISTANT_GREETING.suggestions);
  assert.ok((reply.contextUsed ?? []).includes('intent:greeting'));
});

test('food replies mention dishes from the seeded catalogues', async () => {
  const seeded = getState().catalogues.values().next().value?.items.slice(0, 3).map((i) => i.name) ?? [];
  assert.ok(seeded.length > 0, 'seed catalogue must have dishes');
  const reply = await assistant.chat('what should I eat today?');
  for (const dish of seeded) {
    assert.ok(reply.reply.includes(dish), `reply mentions seeded dish "${dish}"`);
  }
});

test('unknown intents return the helpful fallback with 3 suggestions', async () => {
  const reply = await assistant.chat('what is the meaning of life?');
  assert.ok(reply.reply.length > 0);
  assert.ok((reply.contextUsed ?? []).includes('intent:unknown'));
  assert.deepEqual(reply.suggestions, ['Order food', 'Book a service', 'Get help']);
});

test('replies are deterministic for the same message', async () => {
  const first = await assistant.chat('where is my order?');
  const second = await assistant.chat('where is my order?');
  assert.deepEqual(first, second);
});

test('messages over the contract maxLength (1000) are rejected with VALIDATION_FAILED', async () => {
  await rejectsApiError(assistant.chat('x'.repeat(1001)), 422, 'VALIDATION_FAILED');
  // Exactly 1000 chars is valid.
  const reply = await assistant.chat('x'.repeat(1000));
  assert.ok(reply.reply.length > 0);
});

test('empty and whitespace-only messages are rejected with VALIDATION_FAILED', async () => {
  await rejectsApiError(assistant.chat(''), 422, 'VALIDATION_FAILED');
  await rejectsApiError(assistant.chat('   '), 422, 'VALIDATION_FAILED');
});
