/* MoneyText: integer TZS via formatTZS (en-TZ grouping), signed rows render
 * the sign. The accessibilityLabel is the exact integer (no grouping). */
import { render } from '@testing-library/react-native';

import { MoneyText } from '@/components/MoneyText';

describe('MoneyText', () => {
  it('formats the amount with en-TZ integer grouping', async () => {
    const { getByText } = await render(<MoneyText amountTZS={12500} />);
    expect(getByText('TZS 12,500')).toBeTruthy();
  });

  it('formats large amounts with full grouping', async () => {
    const { getByText } = await render(<MoneyText amountTZS={1234567} />);
    expect(getByText('TZS 1,234,567')).toBeTruthy();
  });

  it('renders zero plainly', async () => {
    const { getByText } = await render(<MoneyText amountTZS={0} />);
    expect(getByText('TZS 0')).toBeTruthy();
  });

  it('renders a plus sign for positive signed amounts', async () => {
    const { getByText } = await render(<MoneyText amountTZS={5000} signed />);
    expect(getByText('+TZS 5,000')).toBeTruthy();
  });

  it('renders a minus sign for negative signed amounts', async () => {
    const { getByText } = await render(<MoneyText amountTZS={-25000} signed />);
    expect(getByText('−TZS 25,000')).toBeTruthy();
  });

  it('omits the sign for zero signed amounts', async () => {
    const { getByText } = await render(<MoneyText amountTZS={0} signed />);
    expect(getByText('TZS 0')).toBeTruthy();
  });

  it('exposes the exact integer via accessibilityLabel', async () => {
    const { getByLabelText } = await render(<MoneyText amountTZS={12500} />);
    expect(getByLabelText('TZS 12500')).toBeTruthy();
  });
});
