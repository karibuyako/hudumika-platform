import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { dateISO } from '@/lib/format';
import type { Notification } from '@hudumika/contract';

const TYPE_ICON: Record<string, 'briefcase' | 'wallet' | 'star' | 'chatbubble' | 'alert-circle' | 'megaphone' | 'shield-checkmark'> = {
  booking: 'briefcase',
  job: 'briefcase',
  payout: 'wallet',
  review: 'star',
  ticket: 'chatbubble',
  dispute: 'alert-circle',
  trust: 'shield-checkmark',
  lead: 'megaphone',
};

/** Notification row with unread dot; deepLink opens booking/ticket/statement. */
export function NotificationRow({ notification, onPress }: {
  notification: Notification;
  onPress?: () => void;
}) {
  const icon = TYPE_ICON[notification.type] ?? 'notifications';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={notification.title}
      accessibilityState={{ selected: notification.read }}
      style={({ pressed }) => [{ backgroundColor: pressed ? Colors.surfacePress : 'transparent' }]}>
      <View style={styles.row}>
        <View style={[styles.iconBox, !notification.read && styles.iconBoxUnread]}>
          <Icon name={icon} size={16} color={notification.read ? Colors.textTertiary : Colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, !notification.read && styles.unread]}>{notification.title}</Text>
          <Text style={styles.body} numberOfLines={2}>{notification.body}</Text>
          <Text style={styles.ts}>{dateISO(notification.createdAt)}</Text>
        </View>
        {!notification.read ? <View style={styles.dot} /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, padding: Spacing.lg },
  iconBox: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBoxUnread: { backgroundColor: Colors.primarySoft },
  title: { fontSize: FontSize.sm, color: Colors.text, fontFamily: 'PlusJakartaSans_600SemiBold' },
  unread: { fontFamily: 'PlusJakartaSans_800ExtraBold', color: Colors.text },
  body: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2, lineHeight: 16 },
  ts: { fontSize: FontSize.xs, color: Colors.textFaint, marginTop: 2 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.danger },
});
