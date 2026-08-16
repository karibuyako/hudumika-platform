/* NotificationPermissionSheet: copy + Allow/Not-now. Allow runs
 * registerPushForUser (a documented no-op under node — not mocked) and then
 * fires onRegistered; Not-now fires onClose. */
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { NotificationPermissionSheet } from '@/components/NotificationPermissionSheet';
import { t } from '@/i18n';

describe('NotificationPermissionSheet', () => {
  it('renders the explanatory copy and the Allow / Not now buttons', async () => {
    const { getByText } = await render(<NotificationPermissionSheet visible onClose={jest.fn()} />);

    expect(getByText(t('notifications.push.title'))).toBeTruthy();
    expect(getByText(t('notifications.push.permissionCopy'))).toBeTruthy();
    expect(getByText(t('notifications.push.allow'))).toBeTruthy();
    expect(getByText(t('notifications.push.notNow'))).toBeTruthy();
  });

  it('fires onRegistered after Allow completes', async () => {
    const onRegistered = jest.fn();
    const { getByText } = await render(
      <NotificationPermissionSheet visible onClose={jest.fn()} onRegistered={onRegistered} />,
    );

    await fireEvent.press(getByText(t('notifications.push.allow')));
    await waitFor(() => expect(onRegistered).toHaveBeenCalledTimes(1));
  });

  it('fires onClose when Not now is pressed', async () => {
    const onClose = jest.fn();
    const { getByText } = await render(<NotificationPermissionSheet visible onClose={onClose} />);

    await fireEvent.press(getByText(t('notifications.push.notNow')));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not fire onRegistered when the sheet is dismissed', async () => {
    const onRegistered = jest.fn();
    const { getByText } = await render(
      <NotificationPermissionSheet visible onClose={jest.fn()} onRegistered={onRegistered} />,
    );

    await fireEvent.press(getByText(t('notifications.push.notNow')));
    expect(onRegistered).not.toHaveBeenCalled();
  });
});
