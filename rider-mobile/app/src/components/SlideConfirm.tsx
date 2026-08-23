/* Slide-to-confirm — Meituan-style slider to prevent mis-tap on critical actions.
 * Used for rider_arrived_pickup / picked_up / delivering / rider_arrived_dropoff / delivered.
 * Works with touch + mouse (web). Falls back to button when `disabled`.
 */
import { useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import type { ViewStyle } from 'react-native';

import { Colors, Fonts, FontSize, Radius } from '@/constants/theme';
import { t } from '@/i18n';

interface Props {
  label: string;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
}

export function SlideConfirm({ label, onConfirm, disabled, loading, style }: Props) {
  const [offset, setOffset] = useState(0);
  const widthRef = useRef(0);
  const confirmedRef = useRef(false);

  const THRESHOLD = 0.82;

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !disabled && !loading,
      onMoveShouldSetPanResponder: () => !disabled && !loading,
      onPanResponderGrant: () => setOffset(0),
      onPanResponderMove: (_, gs) => {
        const w = widthRef.current || 320;
        const thumbW = 52;
        const max = w - thumbW - 8;
        const next = Math.max(0, Math.min(max, gs.dx));
        setOffset(next);
      },
      onPanResponderRelease: (_, gs) => {
        const w = widthRef.current || 320;
        const thumbW = 52;
        const max = w - thumbW - 8;
        const progress = max > 0 ? offset / max : gs.dx / max;
        if (progress >= THRESHOLD) {
          confirmedRef.current = true;
          void onConfirm();
        }
        setOffset(0);
      },
      onPanResponderTerminate: () => setOffset(0),
    }),
  ).current;

  if (disabled) {
    return (
      <View style={[styles.track, styles.trackDisabled, style]}>
        <Text style={styles.labelDisabled}>{label}</Text>
      </View>
    );
  }

  return (
    <View
      style={[styles.track, style]}
      onLayout={(e) => (widthRef.current = e.nativeEvent.layout.width)}
      {...panResponder.panHandlers}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy: loading }}>
      <View style={[styles.fill, { width: `${Math.min(100, (offset / Math.max(1, (widthRef.current || 320) - 60)) * 100)}%` }]} />
      <View style={[styles.thumb, { transform: [{ translateX: offset }] }]}>
        <Text style={styles.thumbIcon}>{loading ? '…' : '›'}</Text>
      </View>
      <Text style={styles.label}>{loading ? t('common.loading') : label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 54,
    borderRadius: Radius.pill,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
    position: 'relative',
  },
  trackDisabled: {
    opacity: 0.45,
    backgroundColor: Colors.surface,
  },
  fill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: Colors.successSoft,
    borderRadius: Radius.pill,
  },
  thumb: {
    position: 'absolute',
    left: 4,
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: Colors.success,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  thumbIcon: { color: Colors.white, fontSize: 22, fontFamily: Fonts.sansExtraBold, marginLeft: 2 },
  label: { color: Colors.text, fontSize: FontSize.sm, fontFamily: Fonts.sansBold, letterSpacing: 0.3 },
  labelDisabled: { color: Colors.textTertiary, fontSize: FontSize.sm, fontFamily: Fonts.sansMedium },
});
