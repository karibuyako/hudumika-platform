import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/ui';
import { Colors, FontSize, NumberStyle, Spacing } from '@/constants/theme';
import { mmss } from '@/lib/format';

/** Scoped countdown — one component owns its tick so lists never re-render per second. */
export function CountdownPill({ expiresAt, dangerUnder = 30, onExpire }: {
  expiresAt: number | string;
  dangerUnder?: number;
  onExpire?: () => void;
}) {
  const deadline = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
  const [remaining, setRemaining] = useState(() => Math.max(0, Math.floor((deadline - Date.now()) / 1000)));

  useEffect(() => {
    const tick = () => setRemaining(Math.max(0, Math.floor((deadline - Date.now()) / 1000)));
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [deadline]);

  useEffect(() => {
    if (remaining === 0) onExpire?.();
  }, [remaining, onExpire]);

  const danger = remaining <= dangerUnder;

  return (
    <View style={[styles.pill, danger && styles.pillDanger]}>
      <Icon name="timer" size={14} color={danger ? Colors.danger : Colors.textTertiary} />
      <Text style={[styles.text, { color: danger ? Colors.danger : Colors.text }, { fontVariant: NumberStyle.fontVariant }]}>{mmss(remaining)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.surface,
    borderRadius: 999,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
  },
  pillDanger: { backgroundColor: Colors.dangerSoft },
  text: { fontSize: FontSize.md, fontFamily: 'PlusJakartaSans_700Bold' },
});
