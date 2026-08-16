import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { Icon } from '@/components/ui';
import { Colors, FontSize } from '@/constants/theme';
import { mmss } from '@/lib/format';

export function OrderTimer({ deadlineAt, warnAfter = 90 }: { deadlineAt: number; warnAfter?: number }) {
  const [remaining, setRemaining] = useState(() => Math.max(0, Math.floor((deadlineAt - Date.now()) / 1000)));
  useEffect(() => {
    const t = setInterval(() => {
      setRemaining(Math.max(0, Math.floor((deadlineAt - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(t);
  }, [deadlineAt]);
  const warn = remaining <= warnAfter;
  const danger = remaining <= 30;
  return (
    <View
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