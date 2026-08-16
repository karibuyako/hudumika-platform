/* Rating: numeric rating (toFixed(1)) + review count copy "(n)". */
import { render } from '@testing-library/react-native';

import { Rating } from '@/components/Rating';

describe('Rating', () => {
  it('renders the numeric rating with one decimal', async () => {
    const { getByText } = await render(<Rating rating={4.5} />);
    expect(getByText('4.5')).toBeTruthy();
  });

  it('renders the review count in parentheses when provided', async () => {
    const { getByText } = await render(<Rating rating={4} reviewCount={12} />);
    expect(getByText('4.0')).toBeTruthy();
    expect(getByText('(12)')).toBeTruthy();
  });

  it('renders no review count when not provided', async () => {
    const { queryByText } = await render(<Rating rating={3.8} />);
    expect(queryByText(/\(\d+\)/)).toBeNull();
  });

  it('renders an em dash for a non-finite rating', async () => {
    const { getByText } = await render(<Rating rating={Number.NaN} />);
    expect(getByText('—')).toBeTruthy();
  });
});
