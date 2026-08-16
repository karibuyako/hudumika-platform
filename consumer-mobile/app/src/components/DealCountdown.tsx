/* Group-buy sale countdown (GROUP-BUY.md): "Ends in 2d 3h" pill while the
 * sale clock runs, "Ended" pill once salesEndAt passes. Static text refreshed
 * on a minute interval; the timer is skipped under reduced motion (the text
 * refreshes on the next deal reload instead). Pure client display — the
 * server status remains the purchase authority. */
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Colors, Fonts, FontSize, NumberStyle, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { formatDealCountdown } from '@/lib/dates';
import { useUiStore } from '@/store/ui';

/** Ticking "now" for deal clocks — 60s refresh, cleared on unmount, skipped
 * under reduced motion. */
export function useDealClock(refreshMs = 60_000): number {
  const reducedMotion = useUiStore((s) => s.reducedMotion);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (reducedMotion) return;
    const id = setInterval(() => setNow(Date.now()), refreshMs);
    return () => clearInterval(id);
  }, [reducedMotion, refreshMs]);
  return now;
}

/** Pass a screen-level `now` to share one interval across all cards. */
export function DealCountdownPill({ endsAt, now }: { endsAt?: string | null; now?: number }) {
  const tick = useDealClock();
  const countdown = formatDealCountdown(endsAt, now ?? tick);
  const ended = countdown === null;
  return (
    <View style={[styles.pill, ended ? styles.pillEnded : styles.pillLive]} accessibilityRole="text">
      <Text style={[styles.text, ended && styles.textEnded, { fontVariant: NumberStyle.fontVariant }]}>
        {ended ? t('status.ended') : t('groupBuy.endsIn', { t: countdown })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
    borderRadius: Radius.pill,
  },
  pillLive: { backgroundColor: Colors.dangerSoft },
  pillEnded: { backgroundColor: Colors.surface },
  text: { color: Colors.danger, fontSize: FontSize.xs, fontFamily: Fonts.sansBold, letterSpacing: 0.3 },
  textEnded: { color: Colors.textSecondary },
});
