import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/ui';
import { Colors, FontSize, NumberStyle, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { clock } from '@/lib/format';
import type { AvailabilityWindow } from '@hudumika/contract';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface WeekCell {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

function keyOf(day: number, start: string): string {
  return `${day}:${start}`;
}

/** Weekly availability grid — tap a cell to toggle a window; 5-minute steps. */
export function AvailabilityWeek({ windows, onToggle, disabled }: {
  windows: AvailabilityWindow[];
  onToggle: (window: AvailabilityWindow) => void;
  disabled?: boolean;
}) {
  const [week, setWeek] = useState<Date[]>([]);

  useEffect(() => {
    const now = new Date();
    const mondayOffset = (now.getDay() + 6) % 7;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayOffset);
    setWeek(Array.from({ length: 7 }, (_, i) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)));
  }, []);

  const byDay: Record<number, AvailabilityWindow[]> = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const w of windows) byDay[w.dayOfWeek]?.push(w);

  const toggle = (dayOfWeek: number, start: string, end: string, active: boolean) => {
    onToggle({ dayOfWeek, startTime: start, endTime: end, active: !active });
  };

  return (
    <View style={{ gap: Spacing.sm }}>
      {week.map((day, idx) => {
        const dayWindows = byDay[idx] ?? [];
        const isToday = day.toDateString() === new Date().toDateString();
        return (
          <View key={day.toDateString()} style={styles.row}>
            <View style={[styles.dayCol, isToday && styles.dayColToday]}>
              <Text style={[styles.dayName, isToday && { color: Colors.primaryDeep }]}>{DAYS[day.getDay()]}</Text>
              <Text style={styles.dayNum}>{day.getDate()}</Text>
            </View>
            <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {dayWindows.length === 0 ? (
                <Pressable
                  onPress={() => toggle(idx, '09:00', '17:00', false)}
                  disabled={disabled}
                  accessibilityRole="button"
                  accessibilityLabel={`${DAYS[day.getDay()]} add window`}
                  style={({ pressed }) => [styles.addCell, pressed && { opacity: 0.7 }]}>
                  <Icon name="add" size={14} color={Colors.textTertiary} />
                </Pressable>
              ) : (
                dayWindows.map((w) => (
                  <Pressable
                    key={keyOf(w.dayOfWeek, w.startTime)}
                    onPress={() => toggle(w.dayOfWeek, w.startTime, w.endTime, w.active ?? true)}
                    disabled={disabled}
                    accessibilityRole="button"
                    accessibilityLabel={`${DAYS[day.getDay()]} ${w.startTime}–${w.endTime}`}
                    accessibilityState={{ checked: (w.active ?? true) }}
                    style={({ pressed }) => [
                      styles.windowCell,
                      (w.active ?? true) ? styles.windowOn : styles.windowOff,
                      pressed && { opacity: 0.7 },
                    ]}>
                    <Text style={[styles.windowText, (w.active ?? true) && { color: Colors.primaryDeep }]}>
                      {clock(Date.parse(`2026-01-05T${w.startTime}:00`))}–{clock(Date.parse(`2026-01-05T${w.endTime}:00`))}
                    </Text>
                  </Pressable>
                ))
              )}
            </View>
          </View>
        );
      })}
      <Text style={styles.hint}>
        {t('home.pausedSub')} · tap a cell to toggle it
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: Spacing.md, alignItems: 'center' },
  dayCol: { width: 44, alignItems: 'center', borderRadius: Radius.md, paddingVertical: 6 },
  dayColToday: { backgroundColor: Colors.primarySoft },
  dayName: { fontSize: FontSize.xs, color: Colors.textSecondary, fontFamily: 'PlusJakartaSans_700Bold' },
  dayNum: { fontSize: FontSize.xs, color: Colors.textTertiary, fontVariant: NumberStyle.fontVariant },
  addCell: {
    minWidth: 80,
    minHeight: 36,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  windowCell: { minHeight: 36, borderRadius: Radius.md, paddingHorizontal: Spacing.sm, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  windowOn: { backgroundColor: Colors.primarySoft, borderColor: Colors.primary },
  windowOff: { backgroundColor: Colors.surface, borderColor: Colors.borderStrong },
  windowText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontFamily: 'PlusJakartaSans_600SemiBold' },
  hint: { fontSize: FontSize.xs, color: Colors.textFaint, textAlign: 'center', marginTop: Spacing.xs },
});
