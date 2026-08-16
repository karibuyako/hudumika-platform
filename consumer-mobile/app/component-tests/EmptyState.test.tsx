/* EmptyState: icon + title + optional sub copy; CTA (Btn) fires onAction. */
import { fireEvent, render } from '@testing-library/react-native';

import { EmptyState } from '@/components/EmptyState';
import type { IconName } from '@/components/ui';

describe('EmptyState', () => {
  it('renders title and sub copy', async () => {
    const { getByText } = await render(
      <EmptyState icon="heart-outline" title="No favourites yet" sub="Favourites you save appear here" />,
    );
    expect(getByText('No favourites yet')).toBeTruthy();
    expect(getByText('Favourites you save appear here')).toBeTruthy();
  });

  it('renders the CTA and fires onAction on press', async () => {
    const onAction = jest.fn();
    const { getByText } = await render(
      <EmptyState icon="search-outline" title="Nothing here" actionLabel="Browse" onAction={onAction} />,
    );
    await fireEvent.press(getByText('Browse'));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('renders no CTA when onAction is not provided', async () => {
    const { queryByText } = await render(<EmptyState icon="cart-outline" title="Cart is empty" />);
    expect(queryByText('Browse')).toBeNull();
  });

  it('accepts every icon name in the icon set (type check passes for a known name)', async () => {
    const icon: IconName = 'heart-outline';
    const { getByText } = await render(<EmptyState icon={icon} title="Known icon" />);
    expect(getByText('Known icon')).toBeTruthy();
  });
});
