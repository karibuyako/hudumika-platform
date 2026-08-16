import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar, Pill, Row } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import type { ProviderStaff, ProviderStaffRole } from '@hudumika/contract';

const ROLE_TONE: Record<ProviderStaffRole, 'neutral' | 'info' | 'warning' | 'success'> = {
  owner: 'neutral',
  dispatcher: 'info',
  technician: 'warning',
  supervisor: 'success',
};

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'danger'> = {
  invited: 'neutral',
  active: 'success',
  suspended: 'danger',
};

/** Team member row (staff) with role + status pills. */
export function StaffRow({ staff, onPress, trailing }: {
  staff: ProviderStaff;
  onPress?: () => void;
  trailing?: React.ReactNode;
}) {
  const content = (
    <View style={styles.row}>
      <Avatar name={staff.name} size={40} />
      <View style={{ flex: 1 }}>
        <Text style={styles.name}>{staff.name}</Text>
        <Text style={styles.meta}>{staff.phone}</Text>
      </View>
      <Row gap={6}>
        <Pill label={t(`staff.role.${staff.role}`)} tone={ROLE_TONE[staff.role]} />
        {staff.status ? <Pill label={t(`staff.status.${staff.status}`)} tone={STATUS_TONE[staff.status] ?? 'neutral'} /> : null}
      </Row>
      {trailing}
    </View>
  );
  if (onPress) {
    return (
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={staff.name} style={({ pressed }) => [{ backgroundColor: pressed ? Colors.surfacePress : 'transparent' }]}>
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
