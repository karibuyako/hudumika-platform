/* Skeleton loading primitives — per-section, not one giant loader. */
import { StyleProp, View, ViewStyle } from 'react-native';

import { Colors, Radius, Spacing } from '@/constants/theme';
import { Card } from './ui';

export function Skeleton({ width = '100%', height = 14, radius = Radius.sm, style }: {
  width?: number | `${number}%`;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[{ width, height, borderRadius: radius, backgroundColor: Colors.border }, style]} />;
}

export function SkeletonCard({ rows = 2, height = 14 }: { rows?: number; height?: number }) {
  return (
    <Card style={{ gap: Spacing.sm }}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={height} width={i === rows - 1 ? '60%' : '100%'} />
      ))}
    </Card>
  );
}
