/* Push permission sheet — explanatory copy BEFORE the OS notification prompt
 * (SECURITY.md / NOTIFICATIONS.md step 1: explain why before requesting).
 * Allow requests the native permission and registers the Expo push token
 * (fire-and-forget, never throws); "Not now" dismisses without asking — the
 * prompt can be re-opened later from Settings. Mirror of
 * LocationPermissionSheet (same structure/tokens/a11y).
 */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Btn, Icon, SheetModal } from '@/components/ui';
import { Colors, FontSize, Fonts, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { registerPushForUser } from '@/lib/push';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Called after Allow finishes (granted or denied) — the caller usually
   * closes the sheet and continues the flow. */
  onRegistered?: () => void;
}

export function NotificationPermissionSheet({ visible, onClose, onRegistered }: Props) {
  const [requesting, setRequesting] = useState(false);

  const allow = async () => {
    if (requesting) return;
    setRequesting(true);
    try {
      // Permission prompt → token → device-local persistence. Never throws;
      // on web this resolves to a null no-op (push is native-only).
      await registerPushForUser();
      onRegistered?.();
    } finally {
      setRequesting(false);
    }
  };

  return (
    <SheetModal visible={visible} onClose={onClose} title={t('notifications.push.title')}>
      <View style={styles.body}>
        <View style={styles.iconWrap}>
          <Icon name="notifications-outline" size={26} color={Colors.primaryDeep} />
        </View>
        <Text style={styles.copy} accessibilityRole="alert">
          {t('notifications.push.permissionCopy')}
        </Text>
      </View>
      <Btn label={t('notifications.push.allow')} onPress={allow} size="lg" loading={requesting} />
      <Btn label={t('notifications.push.notNow')} onPress={onClose} variant="subtle" size="lg" />
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  body: { alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.sm },
  iconWrap: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: Colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copy: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontFamily: Fonts.sans,
    textAlign: 'center',
    lineHeight: 19,
  },
});
