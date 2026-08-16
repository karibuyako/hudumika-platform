import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { Avatar, Card, ConfirmDialog, ErrorCard, ListRow, Pill, Row, Screen, Stars } from '@/components/ui';
import type { IconName } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import type { I18nKey } from '@/i18n';
import { getProviderRepository } from '@/repos';
import { useSessionStore } from '@/store/session';
import type { ProviderPrivate } from '@hudumika/contract';

const MENU: { route: string; labelKey: I18nKey; icon: IconName; capability?: string }[] = [
  { route: '/profile/notifications', labelKey: 'profile.menu.notifications', icon: 'notifications-outline' },
  { route: '/profile/preferences', labelKey: 'profile.menu.preferences', icon: 'options-outline' },
  { route: '/profile/catalog', labelKey: 'profile.menu.catalog', icon: 'albums-outline', capability: 'manage_services' },
  { route: '/profile/technicians', labelKey: 'profile.menu.technicians', icon: 'hardware-chip-outline', capability: 'assign_technician' },
  { route: '/profile/dispatcher', labelKey: 'profile.menu.dispatcher', icon: 'git-network-outline', capability: 'assign_technician' },
  { route: '/profile/inventory', labelKey: 'profile.menu.inventory', icon: 'cube-outline', capability: 'manage_inventory' },
  { route: '/profile/contracts', labelKey: 'profile.menu.contracts', icon: 'document-text-outline', capability: 'manage_contracts' },
  { route: '/profile/plans', labelKey: 'profile.menu.plans', icon: 'repeat-outline', capability: 'manage_plans' },
  { route: '/profile/trust', labelKey: 'profile.menu.trust', icon: 'shield-checkmark-outline', capability: 'view_trust' },
  { route: '/profile/reviews', labelKey: 'profile.menu.reviews', icon: 'star-outline', capability: 'complete_job' },
  { route: '/profile/staff', labelKey: 'profile.menu.team', icon: 'people-outline', capability: 'manage_staff' },
  { route: '/profile/certifications', labelKey: 'profile.menu.certifications', icon: 'ribbon-outline', capability: 'manage_certifications' },
  { route: '/profile/settings', labelKey: 'profile.menu.settings', icon: 'settings-outline' },
  { route: '/profile/support', labelKey: 'profile.menu.help', icon: 'help-circle-outline' },
];

export default function ProfileIndexScreen() {
  const sessionProvider = useSessionStore((s) => s.provider);
  const [profile, setProfile] = useState<ProviderPrivate | null>(null);
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, caps] = await Promise.all([getProviderRepository().getProfile(), getProviderRepository().getCapabilities()]);
      setProfile(p);
      setCapabilities(caps.capabilities);
      setError('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('misc.error'));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onLogout = async () => {
    setSigningOut(true);
    await useSessionStore.getState().logout();
    router.replace('/login');
  };

  const provider = profile ?? sessionProvider;
  const approved = provider?.verification === 'approved';

  return (
    <Screen scroll>
      <Text style={styles.heading}>{t('tab.profile')}</Text>

      {loading && !provider ? (
        <View style={styles.center}>
          <ActivityIndicator color={Colors.primary} />
        </View>
      ) : error && !provider ? (
        <ErrorCard message={error} onRetry={load} />
      ) : provider ? (
        <>
          <Card style={{ gap: Spacing.md }}>
            <Row gap={Spacing.lg}>
              <Avatar name={provider.name} size={56} />
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={styles.name}>{provider.name}</Text>
                <Row gap={6}>
                  <Stars rating={provider.rating ?? 0} showValue />
                  <Text style={styles.count} accessibilityLabel={`${provider.reviewCount} reviews`}>
                    ({provider.reviewCount})
                  </Text>
                </Row>
                <Text style={styles.sub}>
                  {t('profile.role')}: {provider.trade}
                </Text>
              </View>
              <Pill
                label={approved ? t('onboard.approved') : t('profile.verification')}
                tone={approved ? 'success' : 'warning'}
              />
            </Row>
            <Row gap={Spacing.sm} style={{ flexWrap: 'wrap' }}>
              {provider.verified ? <Pill label={t('profile.verified')} tone="success" /> : null}
              {capabilities.length > 0 ? <Pill label={`${capabilities.length} ${t('staff.capabilities')}`} tone="neutral" /> : null}
            </Row>
          </Card>

          <Card flat style={{ paddingHorizontal: Spacing.lg, marginTop: Spacing.lg }}>
            {/* Capability-gated navigation — only render actions the server would allow. */}
            {MENU.filter((item) => !item.capability || capabilities.length === 0 || capabilities.includes(item.capability)).map((item, i) => (
              <View key={item.route} style={i > 0 ? styles.menuBorder : undefined}>
                <ListRow title={t(item.labelKey)} icon={item.icon} onPress={() => router.push(item.route as never)} />
              </View>
            ))}
          </Card>

          <View style={{ marginTop: Spacing.lg }}>
            <ListRow
              title={t('profile.logout')}
              icon="log-out-outline"
              danger
              onPress={() => setConfirmingLogout(true)}
            />
          </View>
        </>
      ) : null}

      {error && provider ? (
        <View style={{ marginTop: Spacing.md }}>
          <ErrorCard message={error} onRetry={load} />
        </View>
      ) : null}

      <ConfirmDialog
        visible={confirmingLogout}
        title={t('profile.logout')}
        sub={t('profile.logoutConfirm')}
        confirmLabel={t('profile.logout')}
        cancelLabel={t('misc.cancel')}
        onConfirm={onLogout}
        onCancel={() => setConfirmingLogout(false)}
        loading={signingOut}
        danger
      />

      {signingOut ? (
        <View style={styles.signingOut}>
          <ActivityIndicator color={Colors.primary} />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: FontSize.xxl, fontWeight: '900', color: Colors.text, marginBottom: Spacing.lg },
  name: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  sub: { fontSize: FontSize.sm, color: Colors.textSecondary },
  count: { fontSize: FontSize.xs, color: Colors.textTertiary },
  menuBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border },
  center: { alignItems: 'center', paddingVertical: 80 },
  signingOut: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: Colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
