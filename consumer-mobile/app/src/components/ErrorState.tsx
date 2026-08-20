/* Error + retry card with requestId for support (never raw INTERNAL_ERROR). */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { Icon } from './ui';

const styles = StyleSheet.create({
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    backgroundColor: Colors.dangerSoft,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    marginVertical: Spacing.md,
  },
});

export function ErrorState({ message, onRetry, requestId }: {
  message?: string;
  onRetry?: () => void;
  requestId?: string;
}) {
  return (
    <View style={styles.errorBox} accessibilityRole="alert">
      <Icon name="alert-circle-outline" size={22} color={Colors.danger} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: Colors.text, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold }}>
          {message ?? t('common.error')}
        </Text>
        {requestId ? <Text style={{ color: Colors.textFaint, fontSize: FontSize.xs, fontFamily: Fonts.sans }}>{t('error.requestId', { id: requestId })}</Text> : null}
      </View>
      {onRetry ? (
        <Pressable onPress={onRetry} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('common.retry')} style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 8 }}>
          <Text style={{ color: Colors.primaryDeep, fontSize: FontSize.sm, fontFamily: Fonts.sansBold }}>{t('common.retry')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
