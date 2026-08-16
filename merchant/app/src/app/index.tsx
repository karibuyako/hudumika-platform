import { Redirect } from 'expo-router';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, Animated, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';
import { useSessionStore } from '@/store/session';

export default function Splash() {
  const status = useSessionStore((s) => s.status);
  const [done, setDone] = useState(false);
  useSyncExternalStore(onLocaleChange, () => 0);
  // eslint-disable-next-line react-hooks/refs
  const scale = useRef(new Animated.Value(0.6)).current;
  // eslint-disable-next-line react-hooks/refs
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (reduce) {
        scale.setValue(1);
        opacity.setValue(1);
        return;
      }
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, useNativeDriver: true, friction: 5 }),
        Animated.timing(opacity, { toValue: 1, duration: 400, useNativeDriver: true }),
      ]).start();
    });
    const t = setTimeout(() => setDone(true), 1200);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/refs
  }, [scale, opacity]);

  if (done && status !== 'boot') {
    if (status === 'authed') return <Redirect href="/dashboard" />;
    return <Redirect href="/login" />;
  }

  return (
    <View style={styles.root}>
      <Animated.View
        // eslint-disable-next-line react-hooks/refs
        style={{ opacity, transform: [{ scale }], alignItems: 'center', gap: Spacing.lg }}>
        <View style={styles.logo}>
          <Icon name="flame" size={44} color={Colors.primary} />
        </View>
        <View style={{ alignItems: 'center' }}>
          <Text style={styles.title}>Merchant Pro</Text>
          <Text style={styles.sub}>{t('app.tagline')}</Text>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: {
    width: 88,
    height: 88,
    borderRadius: 26,
    backgroundColor: Colors.black,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: FontSize.xxl,
    fontWeight: '800',
    color: Colors.black,
  },
  sub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 4,
    letterSpacing: 0.6,
  },
});