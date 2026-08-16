import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BookingCard } from '@/components/BookingCard';
import { Empty, ErrorCard, Icon, Pill, Row, Screen } from '@/components/ui';
import { Colors, FontSize, NumberStyle, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { dayLabel } from '@/lib/format';
import { useJobsStore } from '@/store/jobs';
import type { Booking } from '@hudumika/contract';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function startOfWeek(offset: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow + offset * 7);
  return d;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

interface DayJobs {
  date: Date;
  jobs: Booking[];
}

export default function CalendarScreen() {
  const active = useJobsStore((s) => s.active);
  const incoming = useJobsStore((s) => s.incoming);
  const loading = useJobsStore((s) => s.loading);
  const error = useJobsStore((s) => s.error);
  const refreshBookings = useJobsStore((s) => s.refreshBookings);

  const [weekOffset, setWeekOffset] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useFocusEffect(
    useCallback(() => {
      refreshBookings();
    }, [refreshBookings]),
  );

  const bookings = useMemo(() => [...active, ...incoming], [active, incoming]);

  const days: DayJobs[] = useMemo(() => {
    const weekStart = startOfWeek(weekOffset);
    return Array.from({ length: 7 }, (_, i) => {
      const date = new Date(weekStart);
      date.setDate(weekStart.getDate() + i);
      const jobs = bookings.filter((b) => sameDay(new Date(b.scheduledFor), date));
      return { date, jobs };
    });
  }, [weekOffset, bookings]);

  const weekJobs = days.reduce((sum, d) => sum + d.jobs.length, 0);
  const weekStart = days[0].date;
  const weekEnd = days[6].date;
  const today = new Date();

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshBookings();
    setRefreshing(false);
  }, [refreshBookings]);

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Pressable onPress={() => setWeekOffset((w) => w - 1)} accessibilityRole="button" accessibilityLabel={t('calendar.title')} hitSlop={8} style={styles.navBtn}>
            <Icon name="chevron-back" size={18} color={Colors.text} />
          </Pressable>
          <Text style={styles.weekTitle}>
            {t('calendar.weekOf')} {dayLabel(weekStart.getTime())}–{dayLabel(weekEnd.getTime())}
          </Text>
          <Pressable onPress={() => setWeekOffset((w) => w + 1)} accessibilityRole="button" accessibilityLabel={t('calendar.title')} hitSlop={8} style={styles.navBtn}>
            <Icon name="chevron-forward" size={18} color={Colors.text} />
          </Pressable>
        </Row>

        <Row gap={Spacing.sm}>
          {days.map((d, i) => {
            const isToday = sameDay(d.date, today);
            return (
              <View key={i} style={[styles.dayCell, isToday && styles.dayCellToday]}>
                <Text style={[styles.dayName, isToday && styles.dayTextToday]}>{WEEKDAYS[i]}</Text>
                <Text style={[styles.dayNum, isToday && styles.dayTextToday]}>{d.date.getDate()}</Text>
              </View>
            );
          })}
        </Row>

        {loading && weekJobs === 0 ? (
          <View style={styles.center}>
            <ActivityIndicator color={Colors.primary} />
          </View>
        ) : error && weekJobs === 0 ? (
          <ErrorCard message={error} onRetry={refreshBookings} />
        ) : weekJobs === 0 ? (
          <Empty icon="calendar-outline" title={t('calendar.noJobs')} />
        ) : (
          days.map((d, i) => {
            if (d.jobs.length === 0) return null;
            return (
              <View key={d.date.getTime()} style={{ gap: Spacing.md }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={styles.dayTitle}>
                    {WEEKDAYS[i]} · {dayLabel(d.date.getTime())}
                  </Text>
                  {d.jobs.length > 1 ? <Pill label={t('calendar.conflict')} tone="danger" /> : null}
                </Row>
                {d.jobs.map((b) => (
                  <BookingCard key={b.id} booking={b} onPress={() => router.push(`/jobs/${b.id}`)} />
                ))}
              </View>
            );
          })
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: Spacing.lg, paddingBottom: 120, gap: Spacing.md },
  center: { alignItems: 'center', paddingVertical: 80 },
  navBtn: {
    width: 34,
    height: 34,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  weekTitle: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text },
  dayCell: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
  },
  dayCellToday: { backgroundColor: Colors.primary },
  dayName: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '700' },
  dayNum: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '800', fontVariant: NumberStyle.fontVariant },
  dayTextToday: { color: Colors.white },
  dayTitle: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text },
});
