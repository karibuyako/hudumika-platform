import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Btn, Field, Icon, IconName, Pill, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { api, ApiError } from '@/api/client';
import type { MerchantDocumentType, OtpRequestResponse } from '@/api/types';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { useSessionStore } from '@/store/session';

const STEPS = ['reg.step1', 'reg.step2', 'reg.step3'] as const;

const BUSINESS_TYPES: { value: string; label: I18nKey }[] = [
  { value: 'restaurant', label: 'reg.btRestaurant' },
  { value: 'shop', label: 'reg.btShop' },
  { value: 'grocery', label: 'reg.btGrocery' },
  { value: 'pharmacy', label: 'reg.btPharmacy' },
  { value: 'retail', label: 'reg.btRetail' },
  { value: 'tickets', label: 'reg.btTickets' },
  { value: 'other', label: 'reg.btOther' },
];

const DOC_TYPES: { type: MerchantDocumentType; label: I18nKey }[] = [
  { type: 'business_registration', label: 'reg.docRegistration' },
  { type: 'trading_license', label: 'reg.docLicense' },
  { type: 'tin_certificate', label: 'reg.docTin' },
  { type: 'owner_id', label: 'reg.docOwnerId' },
  { type: 'payout_account', label: 'reg.docPayout' },
];

const MIME_EXT: Record<string, string[]> = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
};
const ACCEPTED_MIMES = Object.keys(MIME_EXT);
const MAX_SIZE_BYTES = 10 * 1024 * 1024;

interface PickedDoc {
  type: MerchantDocumentType;
  fileName: string;
  mime: string;
  sizeBytes: number;
}

const PERKS: { icon: IconName; label: I18nKey }[] = [
  { icon: 'receipt-outline', label: 'reg.perkOrders' },
  { icon: 'restaurant-outline', label: 'reg.perkMenu' },
  { icon: 'trending-up-outline', label: 'reg.perkSales' },
];

function docStatusLabel(doc: PickedDoc | undefined): { label: I18nKey; tone: 'success' | 'warning' | 'danger' | 'neutral' } {
  if (!doc) return { label: 'reg.docPending', tone: 'neutral' };
  return { label: 'reg.docReady', tone: 'success' };
}

export default function RegisterScreen() {
  const verifyOtp = useSessionStore((s) => s.verifyOtp);
  useSyncExternalStore(onLocaleChange, () => 0);
  const [step, setStep] = useState(0);
  const [businessType, setBusinessType] = useState('restaurant');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [city, setCity] = useState('Dar es Salaam');
  const [address, setAddress] = useState('');
  const [docs, setDocs] = useState<PickedDoc[]>([]);
  const [docTarget, setDocTarget] = useState<MerchantDocumentType | null>(null);
  const [docFileName, setDocFileName] = useState('');
  const [docMime, setDocMime] = useState('image/jpeg');
  const [docSizeMb, setDocSizeMb] = useState('2.4');
  const [docError, setDocError] = useState('');
  const [consent, setConsent] = useState(false);
  const [otpStep, setOtpStep] = useState(false);
  const [code, setCode] = useState('');
  const [requestId, setRequestId] = useState('');
  const [debugCode, setDebugCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const readyDocs = docs.length;

  const canNext =
    step === 0
      ? name.trim().length > 1 && phone.trim().length > 5 && city.trim().length > 1 && address.trim().length > 3
      : step === 1
        ? readyDocs >= 2
        : consent;

  const requestCode = async () => {
    setError('');
    setSubmitting(true);
    try {
      const res = await api.post<OtpRequestResponse>('/auth/request-otp', {
        channel: 'phone',
        destination: phone,
        purpose: 'register',
      });
      setRequestId(res.requestId);
      setDebugCode(res.debugCode);
      setOtpStep(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('reg.errCode'));
    } finally {
      setSubmitting(false);
    }
  };

  /** Client-side size/type validation — JPG/PNG only, max 10 MB. */
  const pickDoc = () => {
    if (!docTarget) return;
    setDocError('');
    const fileName = docFileName.trim();
    const lower = fileName.toLowerCase();
    const mimeOk = ACCEPTED_MIMES.includes(docMime);
    const extOk = MIME_EXT[docMime]?.some((ext) => lower.endsWith(ext)) ?? false;
    const sizeBytes = Math.round((Number(docSizeMb) || 0) * 1024 * 1024);
    if (!fileName || !extOk) {
      setDocError(t('reg.errFileName'));
      return;
    }
    if (!mimeOk) {
      setDocError(t('reg.errFileType'));
      return;
    }
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_SIZE_BYTES) {
      setDocError(t('reg.errFileSize'));
      return;
    }
    const picked: PickedDoc = { type: docTarget, fileName, mime: docMime, sizeBytes };
    setDocs((d) => [...d.filter((x) => x.type !== docTarget), picked]);
    setDocFileName('');
    setDocSizeMb('2.4');
    setDocTarget(null);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const verifyAndCreate = async () => {
    if (!/^\d{6}$/.test(code)) {
      setError(t('reg.errOtp'));
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      await verifyOtp(requestId, code, 'register');
      // Contract flow: profile → documents → submit (ONBOARDING.md:64-69).
      await api.post('/onboarding/profile', {
        businessType,
        ownerName: name,
        storeName: name,
        category: businessType,
        city,
        address,
        contactPhone: phone,
        description: `${businessType} · ${name}`,
        consent: true,
      });
      await api.post('/onboarding/docs', {
        docs: docs.map((d) => ({ type: d.type, fileName: d.fileName, mime: d.mime, sizeBytes: d.sizeBytes })),
      });
      await api.post('/onboarding/submit');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace('/profile/verification');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('reg.errSubmit'));
    } finally {
      setSubmitting(false);
    }
  };

  const openDocSheet = (type: MerchantDocumentType) => {
    setDocTarget(type);
    setDocError('');
    const existing = docs.find((d) => d.type === type);
    setDocFileName(existing?.fileName ?? '');
    setDocSizeMb(existing ? String(existing.sizeBytes / 1024 / 1024) : '2.4');
  };

  if (otpStep) {
    return (
      <Screen style={{ backgroundColor: Colors.primarySoft }}>
        <View style={styles.header}>
          <Pressable onPress={() => setOtpStep(false)} hitSlop={12}>
            <Icon name="chevron-back" size={26} color={Colors.text} />
          </Pressable>
          <Text style={styles.headerTitle}>{t('reg.verifyTitle')}</Text>
          <View style={{ width: 26 }} />
        </View>
        <View style={{ padding: Spacing.xl, gap: Spacing.lg }}>
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 }}>
            {t('reg.verifyBody', { phone })}
          </Text>
          {debugCode ? (
            <View style={styles.demoBox}>
              <Text style={styles.demoLabel}>{t('reg.demoMode')}</Text>
              <Text style={styles.demoCode}>{debugCode}</Text>
            </View>
          ) : null}
          <TextInput
            value={code}
            onChangeText={setCode}
            placeholder={t('reg.otpPh')}
            placeholderTextColor={Colors.textTertiary}
            keyboardType="number-pad"
            maxLength={6}
            style={styles.input}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Btn label={submitting ? t('reg.creating') : t('reg.create')} onPress={verifyAndCreate} size="lg" loading={submitting} />
          <Text style={styles.note}>
            {t('reg.consentNote')}
          </Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen style={{ backgroundColor: Colors.primarySoft }}>
      <View style={styles.header}>
        <Pressable onPress={() => (step === 0 ? router.back() : setStep(step - 1))} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.headerTitle}>{t('reg.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <View style={styles.steps}>
        {STEPS.map((s, i) => (
          <View key={s} style={{ flex: 1, alignItems: 'center', gap: 6 }}>
            <View style={[styles.dot, i <= step ? styles.dotActive : null]}>
              {i < step ? (
                <Icon name="checkmark" size={14} color={Colors.text} />
              ) : (
                <Text style={[styles.dotNum, i <= step && { color: Colors.text }]}>{i + 1}</Text>
              )}
            </View>
            <Text style={[styles.stepLabel, i <= step && { color: Colors.text, fontWeight: '700' }]}>{t(s)}</Text>
          </View>
        ))}
      </View>

      <ScrollView style={styles.body} contentContainerStyle={{ padding: Spacing.xl, gap: Spacing.lg }} showsVerticalScrollIndicator={false}>
        {step === 0 ? (
          <View style={{ gap: Spacing.md }}>
            <View style={{ gap: Spacing.xs }}>
              <Text style={styles.fieldLabel}>{t('reg.businessType')}</Text>
              <View style={styles.chips}>
                {BUSINESS_TYPES.map((b) => (
                  <Pressable
                    key={b.value}
                    onPress={() => setBusinessType(b.value)}
                    style={[styles.chip, businessType === b.value && styles.chipActive]}
                    accessibilityRole="button"
                    accessibilityLabel={t(b.label)}
                    accessibilityState={{ selected: businessType === b.value }}>
                    <Text style={[styles.chipText, businessType === b.value && { color: Colors.text, fontWeight: '700' }]}>{t(b.label)}</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.note}>{t('reg.businessTypePh')}</Text>
            </View>
            <Field label={t('reg.storeName')} value={name} onChangeText={setName} placeholder={t('reg.storeNamePh')} maxLength={30} />
            <Field label={t('reg.phone')} value={phone} onChangeText={setPhone} placeholder="+255700000000" keyboardType="phone-pad" maxLength={13} />
            <Field label={t('reg.city')} value={city} onChangeText={setCity} placeholder="Dar es Salaam" maxLength={40} />
            <Field label={t('reg.address')} value={address} onChangeText={setAddress} placeholder={t('reg.addressPh')} maxLength={60} />
          </View>
        ) : step === 1 ? (
          <View style={{ gap: Spacing.md }}>
            <Text style={styles.note}>{t('reg.docs')} · {t('reg.docSub')}</Text>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
              {t('reg.docsDone', { n: readyDocs, m: DOC_TYPES.length })}
            </Text>
            {DOC_TYPES.map((d) => {
              const picked = docs.find((x) => x.type === d.type);
              const status = docStatusLabel(picked);
              return (
                <Pressable key={d.type} onPress={() => openDocSheet(d.type)} style={[styles.upload, picked && styles.uploadDone]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, width: '100%' }}>
                    <Icon
                      name={picked ? 'checkmark-circle' : 'document-text-outline'}
                      size={26}
                      color={picked ? Colors.success : Colors.textTertiary}
                    />
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={styles.uploadText}>{t(d.label)}</Text>
                      <Text style={styles.uploadSub} numberOfLines={1}>
                        {picked ? picked.fileName : t('reg.chooseFile')}
                      </Text>
                    </View>
                    <Pill label={t(status.label)} tone={status.tone} />
                  </View>
                </Pressable>
              );
            })}
            <Text style={styles.note}>{t('reg.docsNote')}</Text>
          </View>
        ) : (
          <View style={{ gap: Spacing.md }}>
            <View style={styles.preview}>
              <Row label={t('reg.storeName')} value={name} />
              <Row label={t('reg.businessType')} value={t(BUSINESS_TYPES.find((b) => b.value === businessType)?.label ?? 'reg.btOther')} />
              <Row label={t('reg.phone')} value={phone} />
              <Row label={t('reg.docs')} value={t('reg.docsDone', { n: readyDocs, m: DOC_TYPES.length })} />
            </View>
            <View style={styles.preview}>
              <Text style={{ color: Colors.textSecondary, fontSize: FontSize.sm }}>{t('reg.afterLaunch')}</Text>
              <View style={{ flexDirection: 'row', gap: Spacing.xl, marginTop: Spacing.md }}>
                {PERKS.map((p) => (
                  <View key={p.label} style={{ alignItems: 'center', gap: 6 }}>
                    <View style={styles.perkIcon}>
                      <Icon name={p.icon} size={20} color={Colors.textSecondary} />
                    </View>
                    <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'center' }}>{t(p.label)}</Text>
                  </View>
                ))}
              </View>
            </View>
            <Pressable onPress={() => setConsent(!consent)} style={[styles.upload, consent && styles.uploadDone]}>
              <Icon name={consent ? 'checkmark-circle' : 'shield-checkmark-outline'} size={30} color={consent ? Colors.success : Colors.textTertiary} />
              <Text style={styles.uploadText}>{t('reg.consent')}</Text>
              <Text style={styles.uploadSub}>{t('reg.consentSub')}</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>

      <View style={styles.footer}>
        <Btn label={step === 2 ? t('reg.submit') : t('reg.next')} onPress={() => (step < 2 ? setStep(step + 1) : requestCode())} size="lg" disabled={!canNext || submitting} loading={submitting} />
      </View>

      <SheetModal visible={!!docTarget} onClose={() => setDocTarget(null)} title={docTarget ? t(DOC_TYPES.find((d) => d.type === docTarget)?.label ?? 'reg.docs') : ''}>
        <View style={{ gap: Spacing.md }}>
          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.fieldLabel}>{t('reg.fileName')}</Text>
            <TextInput
              value={docFileName}
              onChangeText={setDocFileName}
              placeholder={t('reg.fileNamePh')}
              placeholderTextColor={Colors.textTertiary}
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={80}
              accessibilityLabel={t('reg.fileName')}
            />
          </View>
          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.fieldLabel}>{t('reg.fileType')}</Text>
            <View style={styles.chips}>
              {ACCEPTED_MIMES.map((m) => (
                <Pressable key={m} onPress={() => setDocMime(m)} style={[styles.chip, docMime === m && styles.chipActive]}>
                  <Text style={[styles.chipText, docMime === m && { color: Colors.text, fontWeight: '700' }]}>{m === 'image/jpeg' ? 'JPG' : 'PNG'}</Text>
                </Pressable>
              ))}
            </View>
          </View>
          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.fieldLabel}>{t('reg.fileSize')}</Text>
            <TextInput
              value={docSizeMb}
              onChangeText={setDocSizeMb}
              keyboardType="decimal-pad"
              style={styles.input}
              maxLength={6}
              accessibilityLabel={t('reg.fileSize')}
            />
            <Text style={styles.note}>{t('reg.fileHint')}</Text>
          </View>
          {docError ? <Text style={styles.error}>{docError}</Text> : null}
          <Btn label={t('reg.addDoc')} onPress={pickDoc} size="lg" />
        </View>
      </SheetModal>
    </Screen>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
      <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary }}>{label}</Text>
      <Text style={{ fontSize: FontSize.sm, color: Colors.text, fontWeight: '700' }} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
  },
  headerTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  steps: { flexDirection: 'row', paddingHorizontal: Spacing.xxl, marginTop: Spacing.xl, marginBottom: Spacing.sm },
  dot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotActive: { backgroundColor: Colors.primary },
  dotNum: { fontSize: 13, color: Colors.textTertiary, fontWeight: '700' },
  stepLabel: { fontSize: FontSize.xs, color: Colors.textTertiary },
  body: { flex: 1 },
  fieldLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  chip: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: 8,
    borderRadius: Radius.pill,
    backgroundColor: Colors.card,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primaryDark },
  chipText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  upload: {
    backgroundColor: Colors.card,
    borderRadius: Radius.lg,
    borderWidth: 1.5,
    borderColor: Colors.borderStrong,
    borderStyle: 'dashed',
    alignItems: 'center',
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
    gap: 6,
  },
  uploadDone: { borderColor: Colors.success, borderStyle: 'solid' },
  uploadText: { fontSize: FontSize.md, color: Colors.text, fontWeight: '600' },
  uploadSub: { fontSize: FontSize.xs, color: Colors.textTertiary },
  note: { fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 18 },
  preview: { backgroundColor: Colors.card, borderRadius: Radius.lg, padding: Spacing.lg },
  perkIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footer: {
    padding: Spacing.lg,
    paddingBottom: Spacing.xl,
    backgroundColor: Colors.card,
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
  },
  demoBox: {
    backgroundColor: Colors.card,
    borderRadius: Radius.md,
    padding: Spacing.md,
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: Colors.primary,
  },
  demoLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '600' },
  demoCode: { fontSize: 26, fontWeight: '900', color: Colors.text, letterSpacing: 6 },
  input: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    fontSize: FontSize.md,
    color: Colors.text,
    backgroundColor: Colors.card,
  },
  error: { color: Colors.danger, fontSize: FontSize.sm },
});
