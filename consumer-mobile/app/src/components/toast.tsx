/* Toast — top-positioned, success/error/info variants, auto-dismiss
 * (DESIGN-SYSTEM "Toast"). Every mutation confirms via toast; errors via the
 * inline form error, not toasts. */
import { useEffect, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Colors, Fonts, FontSize, Radius, Spacing, shadow } from '@/constants/theme';
import { useUiStore } from '@/store/ui';
import { Icon, type IconName } from './ui';

const AUTO_DISMISS_MS = 3200;

export function Toast() {
  const insets = useSafeAreaInsets();
  const toastState = useUiStore((s) => s.toast);
  const dismiss = useUiStore((s) => s.dismissToast);
  const [opacity] = useState(() => new Animated.Value(0));
  const [translateY] = useState(() => new Animated.Value(-12));

  useEffect(() => {
    if (!toastState) return;
    opacity.setValue(0);
    translateY.setValue(-12);
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
      Animated.spring(translateY, { toValue: 0, damping: 18, stiffness: 240, useNativeDriver: true }),
    ]).start();
    const timer = setTimeout(dismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toastState, opacity, translateY, dismiss]);

  if (!toastState) return null;

  const variant: Record<'success' | 'error' | 'info', { bg: string; fg: string; icon: IconName }> = {
    success: { bg: Colors.success, fg: Colors.white, icon: 'checkmark-circle' },
    error: { bg: Colors.danger, fg: Colors.white, icon: 'alert-circle' },
    info: { bg: Colors.ink, fg: Colors.white, icon: 'information-circle' },
  };
  const v = variant[toastState.kind];

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.wrap, { top: insets.top + 8, opacity, transform: [{ translateY }] }]}
      accessibilityRole="alert"
      accessibilityLabel={toastState.message}>
      <View style={[styles.toast, { backgroundColor: v.bg, ...shadow.card }]}>
        <Icon name={v.icon} size={18} color={v.fg} />
        <Text style={[styles.text, { color: v.fg }]} numberOfLines={2}>
          {toastState.message}
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: Spacing.lg,
    right: Spacing.lg,
    zIndex: 1000,
    alignItems: 'center',
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: Radius.pill,
    maxWidth: 480,
  },
  text: { fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, flexShrink: 1 },
});