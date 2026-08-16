/* Badge (ui.tsx): count renders; zero/negative hides; >99 collapses to 99+. */
import { render } from '@testing-library/react-native';

import { Badge } from '@/components/ui';

describe('Badge', () => {
  it('renders the count', async () => {
    const { getByText, getByLabelText } = await render(<Badge count={5} />);
    expect(getByText('5')).toBeTruthy();
    expect(getByLabelText('5 unread')).toBeTruthy();
  });

  it('renders nothing for a zero count', async () => {
    const { toJSON } = await render(<Badge count={0} />);
    expect(toJSON()).toBeNull();
  });

  it('renders nothing for a negative count', async () => {
    const { toJSON } = await render(<Badge count={-3} />);
    expect(toJSON()).toBeNull();
  });

  it('collapses counts above 99 to 99+', async () => {
    const { getByText } = await render(<Badge count={150} />);
    expect(getByText('99+')).toBeTruthy();
  });
});
