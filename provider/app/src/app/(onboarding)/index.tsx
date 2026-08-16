import { router } from 'expo-router';
import { useEffect, useState, type PropsWithChildren } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { Btn, Card, Chip, ErrorCard, Field, Icon, Screen, Segmented, type IconName } from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { hapticSuccess } from '@/lib/motion';
import { getCatalogRepository, getProviderRepository } from '@/repos';
import { useSessionStore } from '@/store/session';
import type { City, ProviderApplicationTrade, ProviderPrivate } from '@hudumika/contract';

const TRADES: { key: ProviderApplicationTrade; label: string }[] = [
  { key: 'plumbing', label: 'Plumbing' },
  { key: 'electrical', label: 'Electrical' },
  { key: 'cleaning', label: 'Cleaning' },
  { key: 'repairs', label: 'Repairs' },
  { key: 'carpentry', label: 'Carpentry' },
];

function phoneOf(provider: ProviderPrivate | null): string {
  if (!provider || !('phone' in provider)) return '';
  return String(provider.phone ?? '');
}

type StatusTone = 'success' | 'warning' | 'danger';

function StatusCard({ tone, icon, title, sub, children }: PropsWithChildren<{ tone: StatusTone; icon: IconName; title: string; sub: string }>) {
  const accent = tone === 'success' ? Colors.success : tone === 'danger' ? Colors.danger : Colors.warning;
  const soft = tone === 'success' ? Colors.successSoft : tone === 'danger' ? Colors.dangerSoft : Colors.warningSoft;
  return (
    <Card style={{ gap: Spacing.md, alignItems: 'center', marginTop: Spacing.xl }}>
      <View style={[styles.statusIcon, { backgroundColor: soft }]}>
        <Icon name={icon} size={26} color={accent} />
      </View>
      <Text style={[styles.statusTitle, { color: accent }]}>{title}</Text>
      <Text style={styles.statusSub}>{sub}</Text>
      {children}
    </Card>
  );
}

export default function OnboardingScreen() {
  const provider = useSessionStore((s) => s.provider);
  const [initial, setInitial] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [cities, setCities] = useState<City[]>([]);
  const [city, setCity] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState(() => phoneOf(useSessionStore.getState().provider));
  const [trade, setTrade] = useState<ProviderApplicationTrade>('plumbing');
  const [serviceArea, setServiceArea] = useState('');
  const [bio, setBio] = useState('');

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [profile, cityList] = await Promise.all([
          getProviderRepository().getProfile(),
          getCatalogRepository().listCities(),
        ]);
        if (!mounted) return;
        useSessionStore.getState().applyProvider(profile);
        setCities(cityList);
        setCity((prev) => prev || (cityList[0]?.id ?? ''));
      } catch (e) {
        if (!mounted) return;
        setError(e instanceof ApiError ? e.message : t('misc.error'));
      } finally {
        if (mounted) setInitial(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [reloadKey]);

  const retry = () => {
    setInitial(true);
    setError('');
    setReloadKey((k) => k + 1);
  };

  const refresh = async () => {
    setBusy(true);
    setActionError('');
    try {
      const profile = await getProviderRepository().getProfile();
      useSessionStore.getState().applyProvider(profile);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : t('misc.error'));
    } finally {
      setBusy(false);
    }
  };

  const resubmit = async () => {
    setBusy(true);
    setActionError('');
    try {
      const updated = await getProviderRepository().updateProfile({ bio: provider?.bio });
      useSessionStore.getState().applyProvider(updated);
      hapticSuccess();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : t('misc.error'));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!name.trim()) {
      setError('Enter your business name');
      return;
    }
    if (!/^\+255[67]\d{8}$/.test(phone)) {
      setError('Enter a valid Tanzanian phone number, e.g. +255700000000');
      return;
    }
    if (!city) {
      setError('Select a city');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      await getProviderRepository().apply({
        name: name.trim(),
        phone,
        trade,
        city,
        serviceArea: serviceArea.trim() || undefined,
        bio: bio.trim() || undefined,
      });
      const profile = await getProviderRepository().getProfile();
      useSessionStore.getState().applyProvider(profile);
      hapticSuccess();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not submit application');
    } finally {
      setSubmitting(false);
    }
  };

  if (initial) {
    return (
      <Screen contentStyle={styles.center}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen scroll contentStyle={{ justifyContent: 'center' }}>
        <Text style={styles.title}>{t('onboard.title')}</Text>
        <Text style={styles.sub}>{t('onboard.sub')}</Text>
        <View style={{ marginTop: Spacing.xl }}>
          <ErrorCard message={error} onRetry={retry} />
        </View>
      </Screen>
    );
  }

  const verification = provider?.verification;

  return (
    <Screen scroll contentStyle={{ justifyContent: 'center' }}>
      <Text style={styles.title}>{t('onboard.title')}</Text>
      <Text style={styles.sub}>{t('onboard.sub')}</Text>

      {verification === 'approved' ? (
        <StatusCard tone="success" icon="checkmark-circle" title={t('onboard.approved')} sub={t('onboard.approved.sub')}>
          <Btn label={t('onboard.continue')} size="lg" onPress={() => router.replace('/home')} style={{ alignSelf: 'stretch' }} />
        </StatusCard>
      ) : verification === 'pending' ? (
        <StatusCard tone="warning" icon="hourglass-outline" title={t('onboard.applied')} sub={t('onboard.pending.sub')}>
          {actionError ? <Text style={styles.error}>{actionError}</Text> : null}
          <Btn label={t('misc.refresh')} variant="ghost" size="sm" onPress={refresh} loading={busy} />
        </StatusCard>
      ) : verification === 'documents_review' ? (
        <StatusCard tone="warning" icon="document-text-outline" title={t('onboard.documentsReview')} sub={t('onboard.documentsReview.sub')}>
          {actionError ? <Text style={styles.error}>{actionError}</Text> : null}
          <Btn label={t('misc.refresh')} variant="ghost" size="sm" onPress={refresh} loading={busy} />
        </StatusCard>
      ) : verification === 'changes_requested' ? (
        <StatusCard tone="warning" icon="refresh-circle-outline" title={t('onboard.changesRequested')} sub={t('onboard.changesRequested.sub')}>
          {actionError ? <Text style={styles.error}>{actionError}</Text> : null}
          <Btn label={t('onboard.resubmit')} size="lg" onPress={resubmit} loading={busy} style={{ alignSelf: 'stretch' }} />
        </StatusCard>
      ) : verification === 'rejected' ? (
        <StatusCard tone="danger" icon="alert-circle" title={t('onboard.rejected')} sub={t('onboard.rejected.sub')}>
          <Btn label={t('onboard.appeal')} size="lg" onPress={() => router.push('/profile/support')} style={{ alignSelf: 'stretch' }} />
        </StatusCard>
      ) : verification === 'suspended' ? (
        <StatusCard tone="danger" icon="shield-outline" title={t('onboard.suspended')} sub={t('onboard.suspended.sub')}>
          <Btn label={t('onboard.contactSupport')} size="lg" onPress={() => router.push('/profile/support')} style={{ alignSelf: 'stretch' }} />
        </StatusCard>
      ) : (
        <View style={styles.form}>
          <Field label={t('onboard.name')} value={name} onChangeText={setName} placeholder="e.g. Jengo Plumbing Services" maxLength={120} />
          <Field label={t('onboard.phone')} value={phone} onChangeText={setPhone} placeholder="+255700000000" keyboardType="phone-pad" maxLength={13} />
          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.fieldLabel}>{t('onboard.trade')}</Text>
            <Segmented options={TRADES} value={trade} onChange={setTrade} />
          </View>
          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.fieldLabel}>{t('onboard.city')}</Text>
            <View style={styles.chipRow}>
              {cities.map((c) => (
                <Chip key={c.id} label={c.name} selected={city === c.id} onPress={() => setCity(c.id)} />
              ))}
            </View>
          </View>
          <Field label={t('onboard.serviceArea')} value={serviceArea} onChangeText={setServiceArea} placeholder="e.g. Kinondoni" maxLength={120} hint={t('misc.optional')} />
          <Field label={t('onboard.bio')} value={bio} onChangeText={setBio} placeholder="Tell customers about your experience…" maxLength={2000} multiline />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Btn label={t('onboard.submit')} onPress={submit} size="lg" loading={submitting} />
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.sansExtraBold, color: Colors.text, marginTop: 24 },
  sub: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sans, marginTop: 4 },
  statusIcon: {
    width: 56,
    height: 56,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusTitle: {
    fontSize: FontSize.lg,
    fontFamily: Fonts.sansExtraBold,
    textAlign: 'center',
  },
  statusSub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 19,
    fontFamily: Fonts.sans,
  },
  center: { justifyContent: 'center', alignItems: 'center' },
  form: { gap: Spacing.lg, marginTop: Spacing.xl },
  fieldLabel: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontFamily: Fonts.sansSemibold,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  error: { color: Colors.danger, fontSize: FontSize.sm, fontFamily: Fonts.sansMedium },
});
