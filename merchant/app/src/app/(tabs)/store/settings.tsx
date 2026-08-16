import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Chip, Empty, Field, Icon, Pill, Row, Screen, SheetModal, ToggleRow } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import type { KitchenCamera, QualificationStatus, StoreListItem } from '@/api/types';
import { api } from '@/api/client';
import { useStoreStore } from '@/store/store';
import { useMerchantsStore } from '@/store/merchants';
import { timeAgo } from '@/lib/format';

const QUALITIES: KitchenCamera['videoQuality'][] = ['sd', 'hd', 'fhd'];
const READY_MINUTES = ['5', '10', '15', '20', '30'];
const QUAL_STATUS: Record<QualificationStatus, 'neutral' | 'success' | 'danger' | 'warning'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  expired: 'neutral',
};
const QUAL_LABEL: Record<QualificationStatus, I18nKey> = {
  pending: 'stng.qualPending',
  approved: 'stng.qualApproved',
  rejected: 'stng.qualRejected',
  expired: 'stng.qualExpired',
};
const PAPER_SIZES = ['58mm', '80mm'] as const;

export default function StoreSettingsScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const kitchenCamera = useStoreStore((s) => s.kitchenCamera);
  const selfPickup = useStoreStore((s) => s.selfPickup);
  const qualifications = useStoreStore((s) => s.qualifications);
  const hydrateStoreSettings = useStoreStore((s) => s.hydrateStoreSettings);
  const updateKitchenCamera = useStoreStore((s) => s.updateKitchenCamera);
  const updateSelfPickup = useStoreStore((s) => s.updateSelfPickup);
  const addQualification = useStoreStore((s) => s.addQualification);
  const settings = useMerchantsStore((s) => s.settings);
  const payoutAccount = useMerchantsStore((s) => s.payoutAccount);
  const hydrateSettings = useMerchantsStore((s) => s.hydrateSettings);
  const saveSettings = useMerchantsStore((s) => s.saveSettings);
  const hydratePayout = useMerchantsStore((s) => s.hydratePayout);
  const savePayout = useMerchantsStore((s) => s.savePayout);

  const [stores, setStores] = useState<StoreListItem[]>([]);
  const [storeId, setStoreId] = useState('s_demo');
  const [streamUrl, setStreamUrl] = useState('');
  const [pickupOpen, setPickupOpen] = useState('08:00');
  const [pickupClose, setPickupClose] = useState('21:00');
  const [readyMinutes, setReadyMinutes] = useState('15');
  const [qualType, setQualType] = useState('');
  const [qualUrl, setQualUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState(false);

  /* ---- Contract settings drafts (GET/PUT /merchants/me/settings) ---- */
  const [phoneEnabled, setPhoneEnabled] = useState(true);
  const [phoneOpen, setPhoneOpen] = useState('08:00');
  const [phoneClose, setPhoneClose] = useState('20:00');
  const [cutoff, setCutoff] = useState('20:00');
  const [radiusKm, setRadiusKm] = useState('4');
  const [feeTZS, setFeeTZS] = useState('3000');
  const [minTZS, setMinTZS] = useState('30000');
  const [specialRules, setSpecialRules] = useState('');
  const [copies, setCopies] = useState(1);
  const [autoPrint, setAutoPrint] = useState(true);
  const [labelPrinter, setLabelPrinter] = useState(false);
  const [paper, setPaper] = useState<'58mm' | '80mm'>('80mm');
  const [logoUrl, setLogoUrl] = useState('');

  /* ---- Payout account form (GET/PUT /merchants/me/payout-account) ---- */
  const [payoutType, setPayoutType] = useState<'mobile_money' | 'bank'>('mobile_money');
  const [payoutProvider, setPayoutProvider] = useState('mpesa');
  const [payoutNumber, setPayoutNumber] = useState('');
  const [payoutHolder, setPayoutHolder] = useState('');
  const [payoutSheet, setPayoutSheet] = useState(false);
  const [payoutError, setPayoutError] = useState('');
  const [payoutBusy, setPayoutBusy] = useState(false);

  useEffect(() => {
    api
      .get<{ stores: StoreListItem[] }>('/stores', { retries: 1 })
      .then((r) => setStores(r.stores))
      .catch(() => undefined);
    hydrateSettings();
    hydratePayout();
  }, [hydrateSettings, hydratePayout]);

  useEffect(() => {
    hydrateStoreSettings(storeId);
  }, [storeId, hydrateStoreSettings]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (kitchenCamera?.streamUrl) setStreamUrl(kitchenCamera.streamUrl);
    if (selfPickup?.pickupHours?.open) setPickupOpen(selfPickup.pickupHours.open);
    if (selfPickup?.pickupHours?.close) setPickupClose(selfPickup.pickupHours.close);
    if (selfPickup?.pickupReadyMinutes) setReadyMinutes(String(selfPickup.pickupReadyMinutes));
  }, [kitchenCamera, selfPickup]);

  useEffect(() => {
    if (!settings || loaded) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhoneEnabled(settings.phoneOrderingHours?.enabled ?? true);
    setPhoneOpen(settings.phoneOrderingHours?.open ?? '08:00');
    setPhoneClose(settings.phoneOrderingHours?.close ?? '20:00');
    setCutoff(settings.deliverySettings?.sameDayCutoff ?? '20:00');
    setRadiusKm(String(settings.deliverySettings?.radiusKm ?? 4));
    setFeeTZS(String(settings.deliverySettings?.deliveryFeeTZS ?? 3000));
    setMinTZS(String(settings.deliverySettings?.minimumOrderTZS ?? 30000));
    setSpecialRules(settings.specialRules ?? '');
    setCopies(settings.printSettings?.copies ?? 1);
    setAutoPrint(settings.printSettings?.autoPrint ?? true);
    setLabelPrinter(settings.printSettings?.labelPrinter ?? false);
    setPaper((settings.printSettings as { paperSize?: '58mm' | '80mm' } | undefined)?.paperSize ?? '80mm');
    setLogoUrl((settings as { logoUrl?: string | null }).logoUrl ?? '');
    setLoaded(true);
  }, [settings, loaded]);

  const saveCamera = async () => {
    setBusy(true);
    setError('');
    const ok = await updateKitchenCamera({ streamUrl: streamUrl.trim() || null });
    setBusy(false);
    if (ok) {
      setSaved(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setTimeout(() => setSaved(false), 1500);
    } else {
      setError(t('stng.errSave'));
    }
  };

  const savePickup = async () => {
    setBusy(true);
    setError('');
    const ok = await updateSelfPickup({
      enabled: selfPickup?.enabled ?? false,
      pickupReadyMinutes: Number(readyMinutes),
      pickupHours: { open: pickupOpen, close: pickupClose },
    });
    setBusy(false);
    if (ok) {
      setSaved(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setTimeout(() => setSaved(false), 1500);
    } else {
      setError(t('stng.errSave'));
    }
  };

  const saveContractSettings = async () => {
    setBusy(true);
    setError('');
    const updated = await saveSettings({
      phoneOrderingHours: { enabled: phoneEnabled, open: phoneOpen.trim(), close: phoneClose.trim() },
      deliverySettings: {
        radiusKm: Number(radiusKm) || 0,
        deliveryFeeTZS: Math.round(Number(feeTZS) || 0),
        minimumOrderTZS: Math.round(Number(minTZS) || 0),
        sameDayCutoff: cutoff.trim() || '20:00',
      },
      specialRules: specialRules.trim(),
      printSettings: {
        autoPrint,
        copies,
        labelPrinter,
        paperSize: paper,
      },
      logoUrl: logoUrl.trim() || null,
    } as never);
    setBusy(false);
    if (updated) {
      setSaved(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setTimeout(() => setSaved(false), 1500);
    } else {
      setError(t('mst.errSave'));
    }
  };

  const savePayoutAccount = async () => {
    if (!payoutProvider.trim() || !payoutNumber.trim() || !payoutHolder.trim()) {
      setPayoutError(t('mst.errPayout'));
      return;
    }
    setPayoutBusy(true);
    setPayoutError('');
    const ok = await savePayout({
      type: payoutType,
      provider: payoutProvider.trim(),
      accountNumber: payoutNumber.trim(),
      accountHolderName: payoutHolder.trim(),
    });
    setPayoutBusy(false);
    if (ok) {
      setPayoutSheet(false);
      setPayoutNumber('');
      setPayoutHolder('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      setPayoutError(t('mst.errPayout'));
    }
  };

  const openPayoutSheet = () => {
    setPayoutType(payoutAccount?.type ?? 'mobile_money');
    setPayoutProvider(payoutAccount?.provider ?? 'mpesa');
    setPayoutNumber('');
    setPayoutHolder(payoutAccount?.accountHolderName ?? '');
    setPayoutError('');
    setPayoutSheet(true);
  };

  const addDoc = async () => {
    if (!qualType.trim() || !qualUrl.trim()) return;
    setBusy(true);
    setError('');
    const ok = await addQualification({ type: qualType.trim(), url: qualUrl.trim() }, storeId);
    setBusy(false);
    if (ok) {
      setQualType('');
      setQualUrl('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      setError(t('stng.errAdd'));
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('stng.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {stores.map((s) => (
            <Chip key={s.id} label={s.name} selected={storeId === s.id} onPress={() => setStoreId(s.id)} />
          ))}
        </View>

        <Text style={styles.sub}>{t('stng.sub')}</Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        {!loaded ? (
          <Card style={styles.centerCard}>
            <Text style={{ color: Colors.textSecondary, fontSize: FontSize.sm }}>{t('stng.loading')}</Text>
          </Card>
        ) : (
          <>
            {/* Ordering preferences */}
            <Text style={styles.sectionLabel}>{t('mst.ordering')}</Text>
            <Card style={{ paddingVertical: 0, overflow: 'hidden', paddingHorizontal: Spacing.lg }}>
              <ToggleRow
                label={t('mst.phoneOrdering')}
                sub={t('mst.phoneOrdering')}
                value={phoneEnabled}
                onChange={setPhoneEnabled}
              />
              <View style={styles.divider} />
              <View style={{ paddingVertical: Spacing.md, gap: Spacing.sm }}>
                <Row gap={8} style={{ alignItems: 'flex-start' }}>
                  <View style={{ flex: 1 }}>
                    <Field label={t('mst.phoneOpen')} value={phoneOpen} onChangeText={setPhoneOpen} maxLength={5} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Field label={t('mst.phoneClose')} value={phoneClose} onChangeText={setPhoneClose} maxLength={5} />
                  </View>
                </Row>
                <Field label={t('mst.sameDayCutoff')} value={cutoff} onChangeText={setCutoff} placeholder={t('mst.sameDayCutoffPh')} maxLength={5} />
              </View>
              <View style={styles.divider} />
              <View style={{ paddingVertical: Spacing.md, gap: Spacing.sm }}>
                <Text style={styles.fieldLabel}>{t('mst.specialRules')}</Text>
                <TextInput
                  value={specialRules}
                  onChangeText={setSpecialRules}
                  placeholder={t('mst.specialRulesPh')}
                  placeholderTextColor={Colors.textTertiary}
                  style={styles.multiline}
                  multiline
                  maxLength={1000}
                  accessibilityLabel={t('mst.specialRules')}
                />
                <Text style={[styles.hint, { textAlign: 'right' }]}>{t('mst.ruleCount', { n: specialRules.length })}</Text>
              </View>
            </Card>

            {/* Delivery settings */}
            <Text style={styles.sectionLabel}>{t('mst.delivery')}</Text>
            <Card style={{ paddingVertical: 0, overflow: 'hidden', paddingHorizontal: Spacing.lg }}>
              <View style={{ paddingVertical: Spacing.md, gap: Spacing.sm }}>
                <Field label={t('mst.radiusKm')} value={radiusKm} onChangeText={setRadiusKm} keyboardType="decimal-pad" maxLength={4} />
                <Field label={t('mst.deliveryFeeTZS')} value={feeTZS} onChangeText={setFeeTZS} keyboardType="number-pad" maxLength={8} />
                <Field label={t('mst.minOrderTZS')} value={minTZS} onChangeText={setMinTZS} keyboardType="number-pad" maxLength={8} />
              </View>
            </Card>

            {/* Print settings */}
            <Text style={styles.sectionLabel}>{t('mst.print')}</Text>
            <Card style={{ paddingVertical: 0, overflow: 'hidden', paddingHorizontal: Spacing.lg }}>
              <ToggleRow label={t('mst.autoPrint')} value={autoPrint} onChange={setAutoPrint} />
              <View style={styles.divider} />
              <ToggleRow label={t('mst.labelPrinter')} value={labelPrinter} onChange={setLabelPrinter} />
              <View style={styles.divider} />
              <View style={{ paddingVertical: Spacing.md, gap: Spacing.sm }}>
                <Text style={styles.fieldLabel}>{t('mst.copies')}</Text>
                <Row gap={8}>
                  <Pressable onPress={() => setCopies(Math.max(1, copies - 1))} style={styles.stepBtn}>
                    <Text style={styles.stepText}>−</Text>
                  </Pressable>
                  <Text style={styles.stepValue}>{copies}</Text>
                  <Pressable onPress={() => setCopies(Math.min(5, copies + 1))} style={styles.stepBtn}>
                    <Text style={styles.stepText}>+</Text>
                  </Pressable>
                </Row>
                <Text style={styles.fieldLabel}>{t('mst.paper')}</Text>
                <Row gap={8}>
                  {PAPER_SIZES.map((p) => (
                    <Chip key={p} label={p === '58mm' ? t('mst.paper58') : t('mst.paper80')} selected={paper === p} onPress={() => setPaper(p)} />
                  ))}
                </Row>
              </View>
            </Card>

            {/* Store logo */}
            <Text style={styles.sectionLabel}>{t('mst.logo')}</Text>
            <Card style={{ paddingVertical: 0, overflow: 'hidden', paddingHorizontal: Spacing.lg }}>
              <View style={{ paddingVertical: Spacing.md, gap: Spacing.sm }}>
                <Field label={t('mst.logoSub')} value={logoUrl} onChangeText={setLogoUrl} placeholder={t('mst.logoPh')} keyboardType="url" maxLength={300} />
              </View>
            </Card>

            <Row style={{ justifyContent: 'flex-end', marginTop: Spacing.md }}>
              <Btn label={saved ? t('stng.settingsSaved') : t('mst.save')} size="md" loading={busy} onPress={saveContractSettings} />
            </Row>

            {/* Payout account */}
            <Text style={styles.sectionLabel}>{t('mst.payout')}</Text>
            <Card style={{ paddingVertical: 0, overflow: 'hidden', paddingHorizontal: Spacing.lg }}>
              <View style={{ paddingVertical: Spacing.md, gap: Spacing.sm }}>
                {payoutAccount ? (
                  <>
                    <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text style={{ fontSize: FontSize.md, fontWeight: '800', color: Colors.text }}>{payoutAccount.accountMasked}</Text>
                        <Text style={styles.hint}>
                          {payoutAccount.provider} · {payoutAccount.type === 'mobile_money' ? t('mst.typeMobileMoney') : t('mst.typeBank')}
                          {payoutAccount.updatedAt ? ` · ${t('mst.payoutUpdated', { time: timeAgo(new Date(payoutAccount.updatedAt).getTime()) })}` : ''}
                        </Text>
                      </View>
                      <Pill label={payoutAccount.verified ? t('mst.verified') : t('mst.unverified')} tone={payoutAccount.verified ? 'success' : 'warning'} />
                    </Row>
                    {!payoutAccount.verified ? (
                      <Text style={[styles.hint, { color: Colors.warning }]}>{t('mst.unverified')}</Text>
                    ) : null}
                    <Btn label={t('common.edit')} variant="outline" size="sm" onPress={openPayoutSheet} />
                  </>
                ) : (
                  <>
                    <Text style={styles.hint}>{t('mst.payoutNone')}</Text>
                    <Btn label={t('mst.savePayout')} size="sm" onPress={openPayoutSheet} />
                  </>
                )}
              </View>
            </Card>
          </>
        )}

        {/* Kitchen camera */}
        <Text style={styles.sectionLabel}>{t('stng.kitchen')}</Text>
        <Card style={{ paddingVertical: 0, overflow: 'hidden', paddingHorizontal: Spacing.lg }}>
          <ToggleRow
            label={t('stng.cameraEnabled')}
            sub={t('stng.kitchenSub')}
            value={kitchenCamera?.enabled ?? false}
            onChange={async (v) => {
              const ok = await updateKitchenCamera({ enabled: v }, storeId);
              if (!ok) setError(t('stng.errSave'));
            }}
          />
          <View style={styles.divider} />
          <View style={{ paddingVertical: Spacing.md, gap: Spacing.sm }}>
            <Field label={t('stng.cameraId')} value={streamUrl} onChangeText={setStreamUrl} placeholder={t('stng.cameraIdPh')} keyboardType="url" />
          </View>
          <View style={styles.divider} />
          <View style={{ paddingVertical: Spacing.md, gap: Spacing.sm }}>
            <ToggleRow label={t('stng.publicAccess')} value={kitchenCamera?.publicAccess ?? false} onChange={async (v) => { const ok = await updateKitchenCamera({ publicAccess: v }, storeId); if (!ok) setError(t('stng.errSave')); }} />
            <Text style={styles.fieldLabel}>{t('stng.quality')}</Text>
            <Row gap={8}>
              {QUALITIES.map((q) => (
                <Chip key={q} label={q === 'sd' ? t('stng.qualitySd') : q === 'hd' ? t('stng.qualityHd') : t('stng.qualityFhd')} selected={(kitchenCamera?.videoQuality ?? 'hd') === q} onPress={async () => { const ok = await updateKitchenCamera({ videoQuality: q }, storeId); if (!ok) setError(t('stng.errSave')); }} />
              ))}
            </Row>
            <Text style={styles.hint}>
              {t('stng.storage', { used: String(kitchenCamera?.storageUsedGb ?? 0), cap: String(kitchenCamera?.storageCapacityGb ?? 10) })}
            </Text>
            <Row style={{ justifyContent: 'flex-end' }}>
              <Btn label={saved ? t('common.done') : t('stng.saveCamera')} size="sm" loading={busy} onPress={saveCamera} />
            </Row>
          </View>
        </Card>

        {/* Self-pickup */}
        <Text style={styles.sectionLabel}>{t('stng.pickup')}</Text>
        <Card style={{ paddingVertical: 0, overflow: 'hidden', paddingHorizontal: Spacing.lg }}>
          <ToggleRow
            label={t('stng.pickupEnabled')}
            sub={t('stng.pickupSub')}
            value={selfPickup?.enabled ?? false}
            onChange={async (v) => {
              const ok = await updateSelfPickup(
                { enabled: v, pickupReadyMinutes: Number(readyMinutes), pickupHours: { open: pickupOpen, close: pickupClose } },
                storeId,
              );
              if (!ok) setError(t('stng.errSave'));
            }}
          />
          <View style={styles.divider} />
          <View style={{ paddingVertical: Spacing.md, gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('stng.ready')}</Text>
            <Row gap={8} style={{ flexWrap: 'wrap' }}>
              {READY_MINUTES.map((m) => (
                <Chip key={m} label={`${m} min`} selected={readyMinutes === m} onPress={() => setReadyMinutes(m)} />
              ))}
            </Row>
            <Text style={styles.fieldLabel}>{t('stng.hours')}</Text>
            <Row gap={8} style={{ alignItems: 'flex-start' }}>
              <View style={{ flex: 1 }}>
                <Field label={t('stng.open')} value={pickupOpen} onChangeText={setPickupOpen} maxLength={5} />
              </View>
              <View style={{ flex: 1 }}>
                <Field label={t('stng.close')} value={pickupClose} onChangeText={setPickupClose} maxLength={5} />
              </View>
            </Row>
            <Row style={{ justifyContent: 'flex-end' }}>
              <Btn label={t('stng.savePickup')} size="sm" loading={busy} onPress={savePickup} />
            </Row>
          </View>
        </Card>

        {/* Qualifications */}
        <Text style={styles.sectionLabel}>{t('stng.quals')}</Text>
        <Card style={{ paddingVertical: 0, overflow: 'hidden', paddingHorizontal: Spacing.lg }}>
          <View style={{ paddingVertical: Spacing.md, gap: Spacing.sm }}>
            <Field label={t('stng.qualType')} value={qualType} onChangeText={setQualType} placeholder={t('stng.qualTypePh')} maxLength={60} />
            <Field label={t('stng.qualUrl')} value={qualUrl} onChangeText={setQualUrl} placeholder={t('stng.qualUrlPh')} keyboardType="url" maxLength={200} />
            <Btn label={t('stng.addQual')} icon="add" size="sm" loading={busy} disabled={!qualType.trim() || !qualUrl.trim()} onPress={addDoc} />
          </View>
          <View style={styles.divider} />
          <View style={{ paddingVertical: Spacing.md, gap: Spacing.sm }}>
            {qualifications.length === 0 ? <Empty icon="document-text-outline" title={t('stng.emptyQuals')} /> : null}
            {qualifications.map((q) => (
              <Row key={q.id} style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.qualName} numberOfLines={1}>{q.type}</Text>
                  {q.url ? <Text style={styles.hint} numberOfLines={1}>{q.url}</Text> : null}
                </View>
                <Pill label={t(QUAL_LABEL[q.status])} tone={QUAL_STATUS[q.status]} />
              </Row>
            ))}
          </View>
        </Card>
      </Screen>

      <SheetModal visible={payoutSheet} onClose={() => setPayoutSheet(false)} title={t('mst.payout')}>
        <View style={{ gap: Spacing.md }}>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('mst.payoutType')}</Text>
            <Row gap={8}>
              <Chip label={t('mst.typeMobileMoney')} selected={payoutType === 'mobile_money'} onPress={() => setPayoutType('mobile_money')} />
              <Chip label={t('mst.typeBank')} selected={payoutType === 'bank'} onPress={() => setPayoutType('bank')} />
            </Row>
          </View>
          <Field label={t('mst.provider')} value={payoutProvider} onChangeText={setPayoutProvider} placeholder={t('mst.providerPh')} maxLength={40} />
          <Field label={t('mst.accountNumber')} value={payoutNumber} onChangeText={setPayoutNumber} keyboardType="number-pad" maxLength={30} />
          <Field label={t('mst.accountHolderName')} value={payoutHolder} onChangeText={setPayoutHolder} maxLength={120} />
          {payoutError ? <Text style={styles.error}>{payoutError}</Text> : null}
          <Btn label={t('mst.savePayout')} size="lg" loading={payoutBusy} onPress={savePayoutAccount} />
        </View>
      </SheetModal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    backgroundColor: Colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  topTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  sub: { fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 16, marginTop: Spacing.md },
  error: { color: Colors.danger, fontSize: FontSize.xs, marginTop: Spacing.sm },
  sectionLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '700', letterSpacing: 0.5, marginTop: Spacing.lg, marginBottom: Spacing.sm },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border },
  fieldLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  hint: { fontSize: FontSize.xs, color: Colors.textTertiary },
  qualName: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  centerCard: { alignItems: 'center', paddingVertical: Spacing.xl, marginTop: Spacing.lg },
  multiline: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 11,
    fontSize: FontSize.md,
    color: Colors.text,
    backgroundColor: Colors.card,
    minHeight: 88,
    textAlignVertical: 'top',
  },
  stepBtn: {
    width: 36,
    height: 36,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.card,
  },
  stepText: { fontSize: 20, color: Colors.text },
  stepValue: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.text, minWidth: 40, textAlign: 'center' },
});
