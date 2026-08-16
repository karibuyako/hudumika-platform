/* StatusPill: label copy via t('status.*') + tone mapping (Pill colors).
 * Tones asserted through the rendered Text/View style colors (theme tokens),
 * which is the Pill's only tone signal. */
import { render } from '@testing-library/react-native';

import { StatusPill } from '@/components/StatusPill';
import { Colors } from '@/constants/theme';
import { t, type I18nKey } from '@/i18n';

const LABEL_COLOR = (tone: 'success' | 'danger' | 'neutral' | 'info' | 'warning') =>
  tone === 'success' ? Colors.success : tone === 'danger' ? Colors.danger : tone === 'info' ? Colors.info : tone === 'warning' ? Colors.warning : Colors.textSecondary;

describe('StatusPill', () => {
  it('renders the label and success tone for a delivered status', async () => {
    const { getByText } = await render(<StatusPill status="delivered" />);
    const label = getByText(t('status.delivered'));
    expect(label).toHaveStyle({ color: LABEL_COLOR('success') });
  });

  it('renders the label and danger tone for a cancelled status', async () => {
    const { getByText } = await render(<StatusPill status="cancelled" />);
    const label = getByText(t('status.cancelled'));
    expect(label).toHaveStyle({ color: LABEL_COLOR('danger') });
  });

  it('renders the label and neutral tone for a closed status', async () => {
    const { getByText } = await render(<StatusPill status="closed" />);
    const label = getByText(t('status.closed'));
    expect(label).toHaveStyle({ color: LABEL_COLOR('neutral') });
  });

  it('falls back gracefully for an unknown status (key copy, neutral tone, no crash)', async () => {
    const { getByText } = await render(<StatusPill status="made_up_status" />);
    const label = getByText(t('status.made_up_status' as I18nKey));
    expect(label).toHaveStyle({ color: LABEL_COLOR('neutral') });
  });
});
