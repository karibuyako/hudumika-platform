import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';

import { Btn, Card, ListRow, Row, Screen, Segmented, ToggleRow } from '@/components/ui';
import { NotificationPermissionSheet } from '@/components/NotificationPermissionSheet';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { getLocale, setLocale, t, type Locale } from '@/i18n';
import { envConfig } from '@/lib/env';
import { getAuthRepository } from '@/repos';
import { useSessionStore } from '@/store/session';
import { useUiStore } from '@/store/ui';
import { ApiError } from '@/api/client';

export default function SettingsScreen() {
  const router = useRouter();
  const [locale, setLocaleState] = useState<Locale>(getLocale());
  const [pushSheetVisible, setPushSheetVisible] = useState(false);
  const soundEnabled = useUiStore((s) => s.soundEnabled);
  const setSoundEnabled = useUiStore((s) => s.setSoundEnabled);
  const marketingEnabled = useUiStore((s) => s.marketingEnabled);
  const setMarketingEnabled = useUiStore((s) => s.setMarketingEnabled);
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);

  const changeLocale = async (next: Locale) => {
    setLocaleState(next);
    setLocale(next);
    try {
      const user = await getAuthRepository().updateProfile({ locale: next });
      useSessionStore.getState().applyUser(user);
    } catch {
      /* locale still applies locally */
    }
  };

  // About & links (ARCHITECTURE.md): store/support links come from
  // EXPO_PUBLIC_APP_LINKS, never code literals. These are external https /
  // mailto links, so plain Linking.openURL is fine (no deep-link allow-list
  // needed — that only guards in-app navigation payloads). Rows render only
  // when their URL is configured; a missing link just hides the row.
  const links = envConfig.appLinks;
  const storeUrl = Platform.OS === 'ios' ? links.ios : links.android;
  const openLink = (url: string) => {
    void Linking.openURL(url).catch(() => {
      /* external links can fail on simulators — no crash */
    });
  };

  const deleteAccount = async () => {
    setDeleteError('');
    setDeleting(true);
    try {
      await getAuthRepository().deleteAccount();
      await useSessionStore.getState().logout();
      router.replace('/login');
    } catch (e) {
      setDeleteError(e instanceof ApiError && e.code === 'INTERNAL_ERROR' ? t('error.generic') : e instanceof ApiError ? e.message : t('common.error'));
      setDeleting(false);
    }
  };

  return (
    <Screen scroll>
      <Text style={styles.title}>{t('profile.settings')}</Text>

      <Card>
        <Text style={styles.section}>{t('profile.language')}</Text>
        <Segmented
          options={[
            { key: 'en', label: 'English' },
            { key: 'sw', label: 'Kiswahili' },
            { key: 'ar', label: 'العربية' },
          ]}
          value={locale}
          onChange={changeLocale}
        />
        <ListRow
          title={t('payments.title')}
          icon="card-outline"
          onPress={() => router.push('/payments')}
        />
      </Card>

      <Card style={{ marginTop: Spacing.lg }}>
        <Text style={styles.section}>{t('notifications.preferences')}</Text>
        <ListRow
          title={t('notifications.preferences')}
          icon="notifications-outline"
          onPress={() => router.push('/notification-preferences')}
        />
        <ListRow
          title={t('notifications.push.settings')}
          sub={Platform.OS === 'web' ? t('notifications.push.webNote') : undefined}
          icon="notifications-circle-outline"
          onPress={Platform.OS === 'web' ? undefined : () => setPushSheetVisible(true)}
        />
        <ToggleRow label={t('notifications.title')} value={soundEnabled} onChange={setSoundEnabled} />
        <ToggleRow label={t('profile.orders')} value={marketingEnabled} onChange={setMarketingEnabled} />
      </Card>

      <Card style={{ marginTop: Spacing.lg }}>
        <Text style={styles.section}>{t('profile.security')}</Text>
        <Row style={{ justifyContent: 'space-between', paddingVertical: Spacing.md }}>
          <Text style={{ fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansMedium }}>{t('profile.phone')}</Text>
          <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sans }}>
            {useSessionStore.getState().user?.phone ?? ''}
          </Text>
        </Row>
        <ListRow
          title={t('security.sessions')}
          icon="phone-portrait-outline"
          onPress={() => router.push('/security')}
        />
        <ListRow
          title={t('security.changePassword')}
          icon="key-outline"
          onPress={() => router.push('/change-password')}
        />
        <ListRow
          title={t('privacy.title')}
          icon="shield-outline"
          onPress={() => router.push('/privacy')}
        />
      </Card>

      <Card style={{ marginTop: Spacing.lg }}>
        <Text style={styles.section}>{t('profile.help')}</Text>
        <ListRow
          title={t('help.title')}
          icon="book-outline"
          onPress={() => router.push('/help')}
        />
      </Card>

      <Card style={{ marginTop: Spacing.lg }}>
        <Text style={styles.section}>{t('settings.about')}</Text>
        {links.privacyUrl ? (
          <ListRow
            title={t('settings.privacyPolicy')}
            icon="shield-checkmark-outline"
            onPress={() => openLink(links.privacyUrl)}
          />
        ) : null}
        {links.termsUrl ? (
          <ListRow
            title={t('settings.terms')}
            icon="document-text-outline"
            onPress={() => openLink(links.termsUrl)}
          />
        ) : null}
        {links.supportEmail ? (
          <ListRow
            title={t('settings.supportEmail')}
            icon="mail-outline"
            onPress={() => openLink(`mailto:${links.supportEmail}`)}
          />
        ) : null}
        {storeUrl ? (
          <ListRow
            title={t('settings.rateApp')}
            icon="star-outline"
            onPress={() => openLink(storeUrl)}
          />
        ) : null}
      </Card>

      <Card style={{ marginTop: Spacing.lg }}>
        <Text style={styles.section}>{t('profile.about')}</Text>
        <ListRow
          title={t('profile.changelog')}
          icon="megaphone-outline"
          onPress={() => router.push('/changelog')}
        />
      </Card>

      <View style={{ height: Spacing.lg }} />
      {deleteError ? <Text style={styles.deleteError}>{deleteError}</Text> : null}
      <Btn label={t('profile.delete')} onPress={deleteAccount} variant="danger" loading={deleting} />
      <Text style={styles.note}>{t('common.version', { version: Constants.expoConfig?.version || '0.3.0' })}</Text>

      <NotificationPermissionSheet visible={pushSheetVisible} onClose={() => setPushSheetVisible(false)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text, marginBottom: Spacing.md },
  section: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sansSemibold, marginBottom: Spacing.sm },
  note: { textAlign: 'center', color: Colors.textFaint, fontSize: FontSize.xs, fontFamily: Fonts.sans, marginTop: Spacing.lg },
  deleteError: { color: Colors.danger, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, textAlign: 'center', marginBottom: Spacing.md },
});
