import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon, IconName } from '@/components/ui';
import { Colors, FontSize, Radius } from '@/constants/theme';
import { t } from '@/i18n';
import { useMessageStore } from '@/store/messages';
import type { MessageType } from '@/types';

const TYPE_ICONS: Record<MessageType, IconName> = {
  order: 'receipt-outline',
  review: 'star-outline',
  system: 'megaphone-outline',
};

export function ToastHost() {
  const messages = useMessageStore((s) => s.messages);
  const [current, setCurrent] = useState<{ id: string; title: string; body: string; type: MessageType } | null>(null);
  const anim = useRef(new Animated.Value(0)).current;
  const lastSeen = useRef<string | null>(null);
  const reduceMotion = useRef(false);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      reduceMotion.current = v;
    });
  }, []);

  const hide = () => {
    if (reduceMotion.current) {
      anim.setValue(0);
      setCurrent(null);
      return;
    }
    Animated.timing(anim, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => setCurrent(null));
  };

  useEffect(() => {
    const msg = messages[0];
    if (!msg) return;
    if (msg.id === lastSeen.current) return;
    const key = `${msg.id}:${msg.ts}`;
    if (key === lastSeen.current) return;
    lastSeen.current = key;
    setCurrent({ id: msg.id, title: msg.title, body: msg.body, type: msg.type });
    if (reduceMotion.current) {
      anim.setValue(1);
    } else {
      Animated.timing(anim, { toValue: 1, duration: 250, useNativeDriver: true }).start();
    }
    const timer = setTimeout(hide, 3600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages[0]?.id, messages[0]?.ts]);

  if (!current) return null;
  return (
    <Animated.View
      pointerEvents="box-none"
      // eslint-disable-next-line react-hooks/refs
      style={[styles.host, { opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-40, 0] }) }] }]}>
      <Pressable
        onPress={hide}
        accessibilityRole="alert"
        accessibilityLabel={`${current.title}. ${current.body}`}
        style={styles.toast}>
        <View style={styles.iconWrap}>
          <Icon name={TYPE_ICONS[current.type]} size={18} color={Colors.textSecondary} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text }} numberOfLines={1}>
            {current.title}
          </Text>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary }} numberOfLines={1}>
            {current.body}
          </Text>
        </View>
        <Pressable
          onPress={hide}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}>
          <Icon name="close" size={15} color={Colors.textTertiary} />
        </Pressable>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    top: 54,
    left: 16,
    right: 16,
    zIndex: 100,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: Colors.card,
    borderRadius: Radius.md,
    padding: 12,
    shadowColor: Colors.black,
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
});