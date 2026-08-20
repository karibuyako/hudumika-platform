import { useEffect, useState } from 'react';
import { AccessibilityInfo, Text, View } from 'react-native';

import { Icon } from '@/components/ui';
import { Colors, FontSize } from '@/constants/theme';
import { mmss } from '@/lib/format';

/** Deadline countdown: mm:ss via src/lib/format.ts mmss, informational only
 *  (server authoritative). Respects AccessibilityInfo.isReduceMotionEnabled —
 *  when reduce motion is on, the tick interval is disabled and the initial
 *  mm:ss is shown statically (no 1s animation). */
export function OrderTimer({ deadlineAt, warnAfter = 90 }: { deadlineAt: number; warnAfter?: number }) {
  const [remaining, setRemaining] = useState(() => Math.max(0, Math.floor((deadlineAt - Date.now()) / 1000)));
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion).catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (reduceMotion) return;
    const t = setInterval(() => {
      setRemaining(Math.max(0, Math.floor((deadlineAt - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(t);
  }, [deadlineAt, reduceMotion]);

  // When reduce motion is enabled, recompute remaining on deadlineAt change without interval.
  useEffect(() => {
    if (reduceMotion) setRemaining(Math.max(0, Math.floor((deadlineAt - Date.now()) / 1000)));
  }, [deadlineAt, reduceMotion]);

  const warn = remaining <= warnAfter;
  const danger = remaining <= 30;
  return (
    <View
      accessible
      accessibilityRole="timer"
      accessibilityLabel={mmss(remaining)}
      style={{
        backgroundColor: danger ? Colors.dangerSoft : warn ? Colors.warningSoft : Colors.surface,
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 4,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
      }}>
      <Icon name="time-outline" size={13} color={danger ? Colors.danger : warn ? Colors.warning : Colors.textSecondary} />
      <Text
        style={{
          fontSize: FontSize.sm,
          fontWeight: '700',
          color: danger ? Colors.danger : warn ? Colors.warning : Colors.textSecondary,
          fontVariant: ['tabular-nums'],
        }}>
        {mmss(remaining)}
      </Text>
    </View>
  );
}