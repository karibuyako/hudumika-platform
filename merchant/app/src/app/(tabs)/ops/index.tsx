import { router } from 'expo-router';
import { useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Card, Icon, IconName, ListRow, Row, Screen, SectionTitle } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing, shadow } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';

/* Ops landing — staff scheduling/attendance/commissions/approvals (P8b) plus
 * the platform integration screens (webhooks + integrations + tasks). */

const STAFF_ROWS: { label: 'ops.shifts' | 'ops.attendance' | 'ops.performance' | 'ops.commissions' | 'ops.approvals'; sub: 'ops.shiftsSub' | 'ops.attendanceSub' | 'ops.performanceSub' | 'ops.commissionsSub' | 'ops.approvalsSub'; icon: IconName; route: '/ops/shifts' | '/ops/attendance' | '/ops/performance' | '/ops/commissions' | '/ops/approvals'; tint: string }[] = [
  { label: 'ops.shifts', sub: 'ops.shiftsSub', icon: 'calendar-outline', route: '/ops/shifts', tint: Colors.primary },
  { label: 'ops.attendance', sub: 'ops.attendanceSub', icon: 'finger-print-outline', route: '/ops/attendance', tint: Colors.info },
  { label: 'ops.performance', sub: 'ops.performanceSub', icon: 'speedometer-outline', route: '/ops/performance', tint: Colors.violet },
  { label: 'ops.commissions', sub: 'ops.commissionsSub', icon: 'cash-outline', route: '/ops/commissions', tint: Colors.warning },
  { label: 'ops.approvals', sub: 'ops.approvalsSub', icon: 'checkmark-done-outline', route: '/ops/approvals', tint: Colors.success },
];

const PLATFORM_ROWS: { label: string; icon: IconName; route: string; tint: string }[] = [
  { label: 'wh.title', icon: 'link-outline', route: '/ops/webhooks', tint: Colors.info },
  { label: 'int.title', icon: 'git-network-outline', route: '/ops/integrations', tint: Colors.violet },
  { label: 'tsk.title', icon: 'checkbox-outline', route: '/ops/tasks', tint: Colors.warning },
];

export default function OpsLandingScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  return (
    <Screen scroll>
      <Text style={styles.sub}>{t('ops.sub')}</Text>

      <SectionTitle title={t('ops.title')} icon="people" />
      <View style={{ gap: Spacing.md }}>
        {STAFF_ROWS.map((row) => (
          <Card key={row.route} style={{ paddingVertical: 0, overflow: 'hidden' }} accessibilityLabel={t(row.label)}>
            <ListRow icon={row.icon} title={t(row.label)} sub={t(row.sub)} onPress={() => router.push(row.route as never)} />
          </Card>
        ))}
      </View>

      <SectionTitle title={t('tsk.title')} icon="apps" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm }}>
        {PLATFORM_ROWS.map((row) => (
          <Pressable
            key={row.route}
            onPress={() => router.push(row.route as never)}
            accessibilityRole="button"
            accessibilityLabel={t(row.label as never)}
            style={({ pressed }) => [styles.chip, pressed && { opacity: 0.7 }]}>
            <Row gap={6}>
              <Icon name={row.icon} size={15} color={row.tint} />
              <Text style={styles.chipText}>{t(row.label as never)}</Text>
            </Row>
          </Pressable>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  sub: {
    fontSize: FontSize.sm,
    color: Colors.textTertiary,
    lineHeight: 19,
    marginTop: Spacing.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
    ...shadow.card,
  },
  chipText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '600' },
});
