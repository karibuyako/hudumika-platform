/* Headless render smoke for the Assistant screen (verification-only:
 * /assistant renders without crashing — no unmatched keys, no missing repo —
 * and the send path round-trips through the real mock repository). Deleted
 * after the verification run (same convention as TravelSmoke.test.tsx). */
import React from 'react';
import { render, screen, userEvent } from '@testing-library/react-native';

import { t } from '@/i18n';

jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }) }));

jest.setTimeout(20000);

describe('assistant screen headless', () => {
  it('/assistant renders the header, greeting bubble and quick-start chips', async () => {
    await render(React.createElement(require('@/app/assistant').default));
    expect(screen.getByText(t('assistant.title'))).toBeTruthy();
    // Greeting is server text rendered verbatim (never an unmatched key).
    expect(screen.getByText(/Habari! I'm Xiaomei/)).toBeTruthy();
    expect(screen.getByText('Order food')).toBeTruthy();
    expect(screen.getByText('Book a service')).toBeTruthy();
    expect(screen.getByText('Get help')).toBeTruthy();
    expect(screen.getByLabelText(t('assistant.placeholder'))).toBeTruthy();
    expect(screen.getByLabelText(t('assistant.send'))).toBeTruthy();
  });

  it('sending a message round-trips the mock chat and renders the reply bubble', async () => {
    await render(React.createElement(require('@/app/assistant').default));
    const input = screen.getByLabelText(t('assistant.placeholder'));
    await userEvent.type(input, 'where is my order?');
    await userEvent.press(screen.getByLabelText(t('assistant.send')));
    // Order-intent reply is served by the real MockAssistantRepository.
    expect(await screen.findByText(/Orders tab/)).toBeTruthy();
    expect(screen.getByText('Track my order')).toBeTruthy();
    expect(screen.getByText('Cancel an order')).toBeTruthy();
  });

  it('the empty composer cannot send (no error, no bubble)', async () => {
    await render(React.createElement(require('@/app/assistant').default));
    await userEvent.press(screen.getByLabelText(t('assistant.send')));
    expect(screen.queryByText(t('assistant.error'))).toBeNull();
  });
});
