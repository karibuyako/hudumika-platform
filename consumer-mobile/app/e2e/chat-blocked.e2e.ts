/* TESTING.md §4 — Chat from order / Blocked chat.
 *
 * Messages tab → the seeded BLOCKED conversation ("General", conv_002)
 * renders read-only: the "This conversation was closed by HUDumika support"
 * banner (t('messages.blocked')), NO composer, NO "Send", NO "Archive",
 * and the system notice in the thread. Then the OPEN conversation
 * ("Order #HD-OR-482913 help", conv_001) sends a message that appears in
 * the thread.
 *
 * Real labels (verified against src/app/(tabs)/messages/index.tsx,
 * src/app/messages/[conversationId].tsx, src/repos/mock/mockState.ts):
 *  - Conversation rows are Cards matched by their subject text.
 *  - The composer input carries accessibilityLabel "Write a message…"
 *    (t('messages.placeholder')); the send CTA is "Send" (t('messages.send')).
 *  - conv_002 carries a system message with body "This conversation was
 *    closed by HUDumika support" — the same string as the banner, hence the
 *    atIndex(0) assertions.
 *  - The open thread already contains "Hi, is my order ready?" and "Asante!
 *    Your rider is 5 minutes away." (seeded).
 */
import { beforeAll, beforeEach, describe, it } from '@jest/globals';
import { by, element, expect, waitFor } from 'detox';
import { bootToHome, expectVisible, relaunchToHome, tapTab } from './helpers';

const BLOCKED_BANNER = 'This conversation was closed by HUDumika support';

describe('CHAT + BLOCKED CHAT (TESTING.md §4 "Blocked chat" + "Chat from order")', () => {
  beforeAll(async () => {
    await bootToHome();
  });

  beforeEach(async () => {
    await relaunchToHome();
  });

  it('blocked conversation renders read-only — no composer, no send', async () => {
    await tapTab('Messages');
    await expectVisible('Order #HD-OR-482913 help');
    await expectVisible('General');

    // Open the blocked conversation (conv_002, subject "General").
    await element(by.text('General')).tap();

    // Blocked banner + the same copy as the thread's system notice.
    await expectVisible(BLOCKED_BANNER, 15000, 0);
    await expectVisible(BLOCKED_BANNER, 15000, 1);

    // Read-only: no composer input, no send CTA, no archive action.
    await expect(element(by.label('Write a message…'))).toNotExist();
    await expect(element(by.text('Send'))).toNotExist();
    await expect(element(by.text('Archive'))).toNotExist();
  });

  it('open conversation — send a message and see it in the thread', async () => {
    await tapTab('Messages');
    await element(by.text('Order #HD-OR-482913 help')).tap();

    // Seeded thread renders before we send.
    await expectVisible('Hi, is my order ready?');
    await expectVisible('Asante! Your rider is 5 minutes away.');

    // Composer visible (unlike the blocked thread).
    await element(by.label('Write a message…')).tap();
    await element(by.label('Write a message…')).typeText('Mambo! Can I get an update?');
    await element(by.text('Send')).tap();

    // Optimistic bubble → server-confirmed message renders in the thread.
    await waitFor(element(by.text('Mambo! Can I get an update?'))).toBeVisible().withTimeout(15000);
  });
});
