/* ErrorState: message (default t('common.error')), optional requestId copy,
 * optional retry button that fires onRetry. */
import { fireEvent, render } from '@testing-library/react-native';

import { ErrorState } from '@/components/ErrorState';
import { t } from '@/i18n';

/* Minimal shape of the rendered tree node (RNTL query results expose
 * `props`/`parent`); v14's getByRole only matches elements with an explicit
 * `accessible` prop, so walk up from the copy to the alert container. */
interface TestNode {
  props: { accessibilityRole?: string };
  parent: TestNode | null;
}

function hasAlertAncestor(node: unknown): boolean {
  let current: TestNode | null = node as TestNode;
  while (current) {
    if (current.props?.accessibilityRole === 'alert') return true;
    current = current.parent;
  }
  return false;
}

describe('ErrorState', () => {
  it('renders the default error message when none is given', async () => {
    const { getByText } = await render(<ErrorState />);
    expect(getByText(t('common.error'))).toBeTruthy();
  });

  it('renders a custom message and the requestId reference', async () => {
    const { getByText } = await render(<ErrorState message="Boom" requestId="req-123" />);
    expect(getByText('Boom')).toBeTruthy();
    expect(getByText(t('error.requestId', { id: 'req-123' }))).toBeTruthy();
  });

  it('fires onRetry when the retry button is pressed', async () => {
    const onRetry = jest.fn();
    const { getByText } = await render(<ErrorState message="Boom" onRetry={onRetry} />);
    await fireEvent.press(getByText(t('common.retry')));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders no retry button when onRetry is not provided', async () => {
    const { queryByText } = await render(<ErrorState message="Boom" />);
    expect(queryByText(t('common.retry'))).toBeNull();
  });

  it('exposes the alert accessibility role', async () => {
    const { getByText } = await render(<ErrorState message="Boom" />);
    expect(hasAlertAncestor(getByText('Boom'))).toBe(true);
  });
});
