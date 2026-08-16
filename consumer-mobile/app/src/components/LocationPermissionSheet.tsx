/* Location permission sheet — explanatory copy BEFORE the browser geolocation
 * prompt (SECURITY.md: explain why before asking). Allow triggers the Web
 * Geolocation API prompt; "Not now" / backdrop closes without asking.
 * No native modules: on platforms without navigator.geolocation the wrapper
 * fails fast (UNSUPPORTED) and the caller degrades gracefully.
 */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Btn, Icon, SheetModal } from '@/components/ui';
import { Colors, FontSize, Fonts, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { GeoError, getCurrentPosition, type GeoPosition } from '@/lib/geolocation';

interface Props {
  visible: boolean;
  onClose: () => void;
  onDetected: (position: GeoPosition) => void;
  onError: (error: GeoError) => void;
}

export function LocationPermissionSheet({ visible, onClose, onDetected, onError }: Props) {
  const [requesting, setRequesting] = useState(false);

  const allow = async () => {
    if (requesting) return;
    setRequesting(true);
    try {
      const position = await getCurrentPosition();
      onDetected(position);
    } catch (e) {
      onError(e instanceof GeoError ? e : new GeoError('POSITION_UNAVAILABLE', String(e)));
    } finally {
      setRequesting(false);
    }
  };

  return (
    <SheetModal visible={visible} onClose={onClose} title={t('location.permissionTitle')}>
      <View style={styles.body}>
        <View style={styles.iconWrap}>
          <Icon name="locate-outline" size={26} color={Colors.primaryDeep} />
        </View>
        <Text style={styles.copy} accessibilityRole="alert">
          {t('location.permissionCopy')}
        </Text>
      </View>
      <Btn label={t('location.allow')} onPress={allow} size="lg" loading={requesting} />
      <Btn label={t('location.notNow')} onPress={onClose} variant="subtle" size="lg" />
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
