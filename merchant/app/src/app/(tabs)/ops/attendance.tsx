import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Chip, Empty, Icon, Pill, Row, Screen } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { clock } from '@/lib/format';
import type { AttendanceSource, MerchantStaff } from '@/api/types';
import { api } from '@/api/client';
import { useStaffOpsStore } from '@/store/staff-ops';
import { useMessageStore } from '@/store/messages';

const DAY = 86400000;

const RANGE_FILTERS: { key: 'today' | 'week' | 'month'; label: I18nKey; from: (now: number) => number }[] = [
  { key: 'today', label: 'so.filterToday', from: () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); } },
  { key: 'week', label: 'so.filterWeek', from: (now) => now - 6 * DAY },
  { key: 'month', label: 'so.filterMonth', from: (now) => now - 29 * DAY },
];

const SOURCE_LABEL: Record<AttendanceSource, I18nKey> = { app: 'so.sourceApp', pos: 'so.sourcePos' };

const iso = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function AttendanceScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const attendance = useStaffOpsStore((s) => s.attendance);
  const hydrateAttendance = useStaffOpsStore((s) => s.hydrateAttendance);
  const clockIn = useStaffOpsStore((s) => s.clockIn);
  const clockOut = useStaffOpsStore((s) => s.clockOut);
  const pushMessage = useMessageStore((s) => s.push);

  const [staffList, setStaffList] = useState<MerchantStaff[]>([]);
  const [rangeKey, setRangeKey] = useState<'today' | 'week' | 'month'>('today');
  const [staffFilter, setStaffFilter] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<MerchantStaff[]>('/merchants/me/staff', { retries: 1 }).then(setStaffList).catch(() => undefined);
  }, []);

  const range = useMemo(() => {
    const now = Date.now();
    const from = RANGE_FILTERS.find((r) => r.key === rangeKey)!.from(now);
    return { from: iso(from), to: iso(now) };
  }, [rangeKey]);

  useEffect(() => {
    hydrateAttendance(range.from, range.to, staffFilter ?? undefined);
  }, [hydrateAttendance, range, staffFilter]);

  const staffName = (id: string) => staffList.find((s) => s.id === id)?.name ?? id;
  const myOpen = attendance.rows.find((r) => r.clockedOutAt === null);

  const doClockIn = async () => {
    setBusy(true);
    setError('');
    const res = await clockIn();
    setBusy(false);
    if (res.ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({ type: 'system', title: t('so.clockedInToast'), body: clock(Date.now()) });
    } else {
      setError(res.message ?? t('so.errClock'));
    }
  };

  const doClockOut = async () => {
    setBusy(true);
    setError('');
    const res = await clockOut();
    setBusy(false);
    if (res.ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({ type: 'system', title: t('so.clockedOutToast'), body: clock(Date.now()) });
    } else {
      setError(res.message ?? t('so.errClock'));
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('so.attTitle')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <Row gap={8} style={{ flexWrap: 'wrap', marginTop: Spacing.md }}>
          {RANGE_FILTERS.map((r) => (
            <Chip key={r.key} label={t(r.label)} selected={rangeKey === r.key} onPress={() => setRangeKey(r.key)} />
          ))}
        </Row>
        <Row gap={8} style={{ flexWrap: 'wrap', marginTop: Spacing.sm }}>
          <Chip label={t('so.attAllStaff')} selected={staffFilter === null} onPress={() => setStaffFilter(null)} />
          {staffList.map((s) => (
            <Chip key={s.id} label={s.name} selected={staffFilter === s.id} onPress={() => setStaffFilter(s.id)} />
          ))}
        </Row>

        <Card style={styles.selfCard}>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.selfTitle}>{t('so.filterToday')}</Text>
              <Text style={styles.selfSub}>
                {myOpen ? `${t('so.openChip')} · ${clock(myOpen.clockedInAt)}` : t('so.attEmptySub')}
              </Text>
            </View>
            {myOpen ? (
              <Btn label={t('so.clockOut')} variant="dark" size="sm" loading={busy} onPress={doClockOut} />
            ) : (
              <Btn label={t('so.clockIn')} variant="primary" size="sm" loading={busy} onPress={doClockIn} />
            )}
          </Row>
          {error ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs, marginTop: Spacing.sm }}>{error}</Text> : null}
        </Card>

        {attendance.error ? (
          <View style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.lg }}>
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('so.errLoad')}</Text>
            <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => hydrateAttendance(range.from, range.to, staffFilter ?? undefined)} />
          </View>
        ) : null}

        <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
          {!attendance.loading && attendance.rows.length === 0 ? <Empty icon="finger-print-outline" title={t('so.attEmpty')} sub={t('so.attEmptySub')} /> : null}
          {attendance.rows.map((r) => (
            <Card key={r.id} style={{ gap: Spacing.sm }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Row gap={10} style={{ flex: 1 }}>
                  <View style={styles.iconBox}>
                    <Icon name="person-outline" size={18} color={Colors.info} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.name} numberOfLines={1}>{staffName(r.staffId)}</Text>
                    <Text style={styles.meta}>
                      {t('so.inAt', { time: clock(r.clockedInAt) })}
                      {r.clockedOutAt ? ` · ${t('so.outAt', { time: clock(r.clockedOutAt) })}` : ''}
                      {r.durationMinutes !== null ? ` · ${t('so.duration', { n: r.durationMinutes })}` : ''}
                    </Text>
                  </View>
                </Row>
                {r.clockedOutAt === null ? (
                  <Pill label={t('so.openChip')} tone="success" />
                ) : (
                  <Pill label={t(SOURCE_LABEL[r.source])} tone="neutral" />
                )}
              </Row>
            </Card>
          ))}
        </View>
      </Screen>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    backgroundColor: Colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  topTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  selfCard: {
    marginTop: Spacing.md,
    backgroundColor: Colors.primarySoft,
    borderWidth: 1,
    borderColor: `${Colors.primary}44`,
  },
  selfTitle: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text },
  selfSub: { fontSize: FontSize.xs, color: Colors.textTertiary },
  iconBox: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: Colors.infoSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flexShrink: 1 },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary },
});
