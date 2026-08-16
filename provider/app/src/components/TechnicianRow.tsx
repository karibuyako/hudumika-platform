import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar, Pill } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import type { Technician, TechnicianStatus } from '@hudumika/contract';

const STATUS_TONE: Record<TechnicianStatus, 'success' | 'info' | 'neutral'> = {
  idle: 'success',
  on_job: 'info',
  offline: 'neutral',
};

/** Technician roster row with busy state. */
export function TechnicianRow({ technician, onPress, trailing }: {
  technician: Technician;
  onPress?: () => void;
  trailing?: React.ReactNode;
}) {
  const status = technician.status ?? 'idle';
  const content = (
    <View style={styles.row}>
      <Avatar name={technician.name} size={40} />
      <View style={{ flex: 1 }}>
        <Text style={styles.name}>{technician.name}</Text>
        <Text style={styles.meta}>
          {technician.trade.replace(/_/g, ' ')}
          {technician.skills?.length ? ` · ${technician.skills.slice(0, 2).join(', ')}` : ''}
        </Text>
      </View>
      <Pill label={t(`technicians.status.${status}`)} tone={STATUS_TONE[status]} />
      {trailing}
    </View>
  );
  if (onPress) {
    return (
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={technician.name} style={({ pressed }) => [{ backgroundColor: pressed ? Colors.surfacePress : 'transparent' }]}>
        {content}
      </Pressable>
    );
  }
  return content;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, padding: Spacing.lg },
  name: { fontSize: FontSize.md, color: Colors.text, fontFamily: 'PlusJakartaSans_700Bold' },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2, fontFamily: 'PlusJakartaSans_500Medium' },
});
