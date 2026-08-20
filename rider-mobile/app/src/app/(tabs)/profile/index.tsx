import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { ApiError } from '@/api/client';
import { Avatar, Btn, Card, Icon, ListRow, Pill, Row, Screen, SectionTitle, Segmented, SheetModal, Spinner, Stars, ToggleRow } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { getLocale, setLocale, t } from '@/i18n';
import { getRiderRepository } from '@/repos';
import { useSessionStore } from '@/store/session';
import type { RiderPreferences } from '@hudumika/contract';

const VEHICLE_LABEL: Record<string, string> = {
  motorcycle: t('vehicles.motorcycle'),
  bicycle: t('vehicles.bicycle'),
  car: t('vehicles.car'),
};

const SERVICE_MODEL_TONE: Record<string, 'info' | 'success' | 'warning' | 'neutral'> = {
  specialized: 'info',
  crowdsourced: 'success',
  errand: 'warning',
  fleet: 'neutral',
};

const SERVICE_MODEL_KEY: Record<string, string> = {
  specialized: 'profile.serviceModel.specialized',
  crowdsourced: 'profile.serviceModel.crowdsourced',
  errand: 'profile.serviceModel.errand',
  fleet: 'profile.serviceModel.fleet',
};

const PREFS_TOGGLES: { key: 'autoAccept' | 'longDistance' | 'soundNotifications' | 'wifiOnlyMaps'; labelKey: 'profile.autoAccept' | 'profile.longDistance' | 'profile.sounds' | 'profile.wifiOnlyMaps'; subKey: 'profile.autoAcceptSub' | 'profile.longDistanceSub' | 'profile.soundsSub' | 'profile.wifiOnlyMapsSub' }[] = [
  { key: 'autoAccept', labelKey: 'profile.autoAccept', subKey: 'profile.autoAcceptSub' },
  { key: 'longDistance', labelKey: 'profile.longDistance', subKey: 'profile.longDistanceSub' },
  { key: 'soundNotifications', labelKey: 'profile.sounds', subKey: 'profile.soundsSub' },
  { key: 'wifiOnlyMaps', labelKey: 'profile.wifiOnlyMaps', subKey: 'profile.wifiOnlyMapsSub' },
];

const DESTINATION_MAX = 5;

export default function ProfileScreen() {
  const rider = useSessionStore((s) => s.rider);
  const [prefs, setPrefs] = useState<RiderPreferences | null>(null);
  const [prefsError, setPrefsError] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const [logoutVisible, setLogoutVisible] = useState(false);
  const [filterDraft, setFilterDraft] = useState('');

  const loadPrefs = async () => {
    setPrefsError('');
    try {
      setPrefs(await getRiderRepository().getPreferences());
    } catch (e) {
      setPrefsError(e instanceof ApiError ? e.message : t('profile.loadFailed'));
    }
  };

  useEffect(() => {
    void loadPrefs();
  }, []);

  /** Optimistic PUT with server rollback: PREFERENCES_INVALID keeps previous values. */
  const onPatch = async (patch: Partial<RiderPreferences>) => {
    if (!prefs) return;
    const previous = prefs;
    const next = { ...prefs, ...patch };
    setPrefs(next);
    setPrefsError('');
    try {
      setPrefs(await getRiderRepository().putPreferences(next));
    } catch (e) {
      setPrefs(previous);
      setPrefsError(e instanceof ApiError ? e.message : t('profile.saveFailed'));
    }
  };

  const onToggle = async (key: 'autoAccept' | 'longDistance' | 'soundNotifications' | 'wifiOnlyMaps', value: boolean) => {
    await onPatch({ [key]: value });
  };

  const onLanguage = async (lang: 'en' | 'sw') => {
    if (!prefs) return;
    const previousLocale = getLocale();
    const previous = prefs;
    const next = { ...prefs, language: lang };
    setLocale(lang);
    setPrefs(next);
    setPrefsError('');
    try {
      setPrefs(await getRiderRepository().putPreferences(next));
      await getRiderRepository().updateUserLocale(lang);
    } catch (e) {
      setLocale(previousLocale);
      setPrefs(previous);
      setPrefsError(e instanceof ApiError ? e.message : t('profile.saveFailed'));
    }
  };

  const addFilter = () => {
    const value = filterDraft.trim();
    if (!value) return;
    const current = prefs?.destinationFilters ?? [];
    if (current.length >= DESTINATION_MAX) {
      setPrefsError(t('profile.destinationMax'));
      return;
    }
    onPatch({ destinationFilters: [...current, value] });
    setFilterDraft('');
  };

  const removeFilter = (filter: string) => {
    onPatch({ destinationFilters: (prefs?.destinationFilters ?? []).filter((f) => f !== filter) });
  };

  const onLogout = async () => {
    setLogoutVisible(false);
    setSigningOut(true);
    await useSessionStore.getState().logout();
    router.replace('/login');
  };

  const filters = prefs?.destinationFilters ?? [];
  const language: 'en' | 'sw' = prefs?.language === 'sw' ? 'sw' : 'en';

  return (
    <Screen scroll>
      {rider ? (
        <Card style={{ gap: Spacing.md }}>
          <Row gap={Spacing.lg}>
            <Avatar name={rider.name} size={56} />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={styles.name}>{rider.name}</Text>
              <Stars rating={rider.rating ?? 0} showValue />
              <Text style={styles.sub}>
                {VEHICLE_LABEL[rider.vehicle] ?? rider.vehicle}
                {rider.licensePlate ? ` · ${rider.licensePlate}` : ''}
              </Text>
            </View>
            <Pill label={rider.online ? t('home.online') : t('home.offline')} tone={rider.online ? 'success' : 'neutral'} />
          </Row>
          <View style={styles.serviceRow}>
            <Pill
              label={t((SERVICE_MODEL_KEY[rider.serviceModel ?? 'specialized'] ?? 'profile.serviceModel.specialized') as never)}
              tone={SERVICE_MODEL_TONE[rider.serviceModel ?? 'specialized'] ?? 'neutral'}
            />
            {rider.fleetAccountId ? (
              <Pill label={`${t('profile.fleetAccountId')}: ${rider.fleetAccountId.slice(0, 8)}`} tone="neutral" />
            ) : null}
          </View>
          <Text style={styles.serviceSub}>{t('profile.serviceModelSub')}</Text>
          {rider.fleetAccountId ? <Text style={styles.serviceSub}>{t('profile.fleetAccountIdSub')}</Text> : null}
        </Card>
      ) : null}

      <SectionTitle title={t('profile.preferences')} icon="options-outline" />
      <Card flat style={{ paddingHorizontal: Spacing.lg }}>
        {prefs ? (
          <View>
            {PREFS_TOGGLES.map((p, i) => (
              <View key={p.key} style={i > 0 ? styles.toggleBorder : undefined}>
                <ToggleRow label={t(p.labelKey)} sub={t(p.subKey)} value={prefs[p.key] ?? false} onChange={(v) => onToggle(p.key, v)} />
              </View>
            ))}
            {prefs.wifiOnlyMaps ? (
              <View style={styles.bannerBox}>
                <Icon name="wifi-outline" size={14} color={Colors.info} />
                <Text style={styles.bannerText}>{t('profile.wifiOnlyMapsBanner')}</Text>
              </View>
            ) : null}
            <View style={styles.toggleBorder}>
              <View style={styles.languageRow}>
                <View style={{ flex: 1, paddingRight: Spacing.lg }}>
                  <Text style={styles.fieldLabel}>{t('profile.language')}</Text>
                  <Text style={styles.fieldSub}>{t('profile.languageSub')}</Text>
                </View>
                <Segmented
                  options={[
                    { key: 'en', label: t('profile.language.en') },
                    { key: 'sw', label: t('profile.language.sw') },
                  ]}
                  value={language}
                  onChange={onLanguage}
                />
              </View>
            </View>
            <View style={styles.toggleBorder}>
              <View style={styles.filterRow}>
                <Text style={styles.fieldLabel}>{t('profile.destinations')}</Text>
                <Text style={styles.fieldSub}>{t('profile.destinationsSub')}</Text>
                <View style={styles.filterChips}>
                  {filters.map((f) => (
                    <Pressable
                      key={f}
                      onPress={() => removeFilter(f)}
                      accessibilityRole="button"
                      accessibilityLabel={t('common.remove')}
                      hitSlop={8}
                      style={({ pressed }) => [styles.filterChip, pressed && { opacity: 0.7 }]}>
                      <Text style={styles.filterChipText}>{f}</Text>
                      <Icon name="close-circle" size={13} color={Colors.textTertiary} />
                    </Pressable>
                  ))}
                </View>
                <View style={styles.filterInputRow}>
                  <TextInput
                    value={filterDraft}
                    onChangeText={setFilterDraft}
                    placeholder={t('profile.destinationPlaceholder')}
                    placeholderTextColor={Colors.textTertiary}
                    onSubmitEditing={addFilter}
                    returnKeyType="done"
                    accessibilityLabel={t('profile.destinations')}
                    style={styles.filterInput}
                  />
                  <Btn label={t('profile.destinationAdd')} variant="ghost" size="sm" onPress={addFilter} />
                </View>
              </View>
            </View>
          </View>
        ) : (
          <View style={styles.prefsLoading}>
            <Spinner color={Colors.primary} />
          </View>
        )}
        {prefsError ? (
          <View style={{ gap: Spacing.sm, marginTop: Spacing.sm }}>
            <Text style={styles.error}>{prefsError}</Text>
            {!prefs ? <Btn label={t('common.retry')} variant="ghost" size="sm" onPress={loadPrefs} /> : null}
          </View>
        ) : null}
      </Card>

      <SectionTitle title={t('logistics.facilities')} icon="business-outline" />
      <Card flat style={{ paddingHorizontal: Spacing.lg }}>
        <ListRow title={t('logistics.facilities')} sub={t('logistics.facilitiesSub')} icon="business-outline" onPress={() => router.push('/profile/facilities')} />
        <ListRow title={t('logistics.exceptions')} sub={t('logistics.exceptionsSub')} icon="warning-outline" onPress={() => router.push('/profile/exceptions')} />
      </Card>

      <SectionTitle title={t('profile.audit')} icon="apps-outline" />
      <Card flat style={{ paddingHorizontal: Spacing.lg }}>
        <ListRow title={t('profile.safety')} sub={t('profile.safetySub')} icon="shield-checkmark-outline" onPress={() => router.push('/profile/safety')} />
        <ListRow title={t('profile.vehicle')} sub={t('profile.vehicleSub')} icon="construct-outline" onPress={() => router.push('/profile/vehicle')} />
        <ListRow title={t('profile.penalties')} sub={t('profile.penaltiesSub')} icon="alert-circle-outline" onPress={() => router.push('/profile/penalties')} />
        <ListRow title={t('profile.logout')} icon="log-out-outline" danger onPress={() => setLogoutVisible(true)} />
      </Card>

      {signingOut ? (
        <View style={styles.signingOut}>
          <Spinner color={Colors.primary} />
        </View>
      ) : null}

      <View style={styles.versionBox}>
        <Text style={styles.versionText}>{t('profile.version', { version: '0.1.0' })}</Text>
      </View>

      <SheetModal visible={logoutVisible} onClose={() => setLogoutVisible(false)} title={t('profile.logoutConfirmTitle')}>
        <Text style={styles.confirmBody}>{t('profile.logoutConfirmBody')}</Text>
        <Row gap={Spacing.md}>
          <Btn label={t('common.cancel')} variant="outline" onPress={() => setLogoutVisible(false)} style={{ flex: 1 }} />
          <Btn label={t('profile.logout')} variant="danger" onPress={onLogout} style={{ flex: 1 }} />
        </Row>
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  name: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  sub: { fontSize: FontSize.sm, color: Colors.textSecondary },
  serviceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginTop: Spacing.sm },
  serviceSub: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 },
  toggleBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border },
  prefsLoading: { paddingVertical: Spacing.xl, alignItems: 'center' },
  error: { color: Colors.danger, fontSize: FontSize.sm, paddingBottom: Spacing.md },
  bannerBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.infoSoft,
    borderRadius: Radius.sm,
    padding: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  bannerText: { flex: 1, color: Colors.info, fontSize: FontSize.xs, fontWeight: '700' },
  languageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.md,
  },
  filterRow: { paddingVertical: Spacing.md, gap: Spacing.sm },
  fieldLabel: { fontSize: FontSize.md, color: Colors.text, fontWeight: '500' },
  fieldSub: { fontSize: FontSize.sm, color: Colors.textTertiary, marginTop: 2, lineHeight: 17 },
  filterChips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.surface,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
  },
  filterChipText: { color: Colors.textSecondary, fontSize: FontSize.sm, fontWeight: '600' },
  filterInputRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  filterInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    fontSize: FontSize.sm,
    color: Colors.text,
    backgroundColor: Colors.card,
  },
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
  versionBox: { alignItems: 'center', marginTop: Spacing.xl },
  versionText: { color: Colors.textFaint, fontSize: FontSize.xs },
  confirmBody: { color: Colors.textSecondary, fontSize: FontSize.sm, lineHeight: 20 },
});
