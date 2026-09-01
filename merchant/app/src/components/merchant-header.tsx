import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Badge, Icon } from '@/components/ui';
import { Colors, FontSize, Radius } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';
import { useMessageStore } from '@/store/messages';
import { useStoreStore } from '@/store/store';
import { useSyncExternalStore } from 'react';

export function MerchantHeader() {
  const store = useStoreStore((s) => s.store);
  const unread = useMessageStore((s) => s.messages.filter((m) => !m.read).length);
  useSyncExternalStore(onLocaleChange, () => 0);

  return (
    <View style={styles.header}>
      <View style={styles.logo}>
        <Icon name="leaf" size={22} color={Colors.primary} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.name} numberOfLines={1}>{store.name}</Text>
        <View style={styles.subRow}>
          <Text style={styles.sub}>{store.category}</Text>
          <View style={[styles.dot, { backgroundColor: store.open ? Colors.success : Colors.textTertiary }]} />
          <Text style={[styles.open, { color: store.open ? Colors.success : Colors.textTertiary }]}>
            {t(store.open ? 'header.open' : 'header.closed')}
          </Text>
          <Text style={styles.sub}>· {store.hours.open} – {store.hours.close}</Text>
        </View>
      </View>
      <Pressable
        onPress={() => router.push('/dashboard/messages')}
        accessibilityRole="button"
        accessibilityLabel={t('dashboard.liveAlerts')}
        style={({ pressed }) => [styles.bell, pressed && { backgroundColor: Colors.surfacePress }]}>
        <Icon name="notifications-outline" size={20} color={Colors.text} />
        <View style={styles.badgeWrap}>
          <Badge count={unread} />
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: Colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  logo: {
    width: 42,
    height: 42,
    borderRadius: 13,
    backgroundColor: Colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 },
  sub: { fontSize: FontSize.xs, color: Colors.textTertiary },
  open: { fontSize: FontSize.xs, fontWeight: '700' },
  dot: { width: 6, height: 6, borderRadius: 3 },
  bell: {
    width: 38,
    height: 38,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeWrap: { position: 'absolute', top: 5, right: 5 },
});