/* Rating display — values always come from the API (never hardcoded). */
import { Text } from 'react-native';

import { Colors, Fonts, FontSize, NumberStyle } from '@/constants/theme';
import { Icon, Row } from './ui';

export function Rating({ rating, reviewCount, size = 13 }: { rating: number; reviewCount?: number; size?: number }) {
  return (
    <Row gap={4}>
      <Icon name="star" size={size} color={Colors.gold} />
      <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary, fontFamily: Fonts.sansSemibold, fontVariant: NumberStyle.fontVariant }}>
        {Number.isFinite(rating) ? rating.toFixed(1) : '—'}
      </Text>
      {reviewCount !== undefined ? (
        <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans }}>
          ({reviewCount})
        </Text>
      ) : null}
    </Row>
  );
}
