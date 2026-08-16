/* Empty state with CTA (per-screen state contract). */
import { StyleSheet, Text, View } from 'react-native';

import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { Btn, Icon, type IconName } from './ui';

const styles = StyleSheet.create({
  empty: { alignItems: 'center', paddingVertical: Spacing.xxl * 1.5, gap: Spacing.sm },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

/* Consumer: empty state with CTA + error state with retry (per-screen contract). */
export function EmptyState({ icon, title, sub, actionLabel, onAction }: {
  icon: IconName;
  title: string;
  sub?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Icon name={icon} size={28} color={Colors.textTertiary} />
      </View>
      <Text style={{ color: Colors.textSecondary, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold }}>{title}</Text>
      {sub ? <Text style={{ color: Colors.textFaint, fontSize: FontSize.xs, fontFamily: Fonts.sans, textAlign: 'center' }}>{sub}</Text> : null}
      {actionLabel && onAction ? <Btn label={actionLabel} onPress={onAction} variant="ghost" size="sm" style={{ marginTop: Spacing.sm }} /> : null}
    </View>
  );
}
