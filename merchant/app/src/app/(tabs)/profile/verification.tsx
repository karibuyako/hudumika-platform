import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Empty, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { api, ApiError } from '@/api/client';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import type { MerchantCommercialTerms, MerchantDocumentStatus, MerchantDocumentType, OnboardingStatusResponse } from '@/api/types';
import { useMerchantsStore } from '@/store/merchants';

const DOC_LABEL: Record<MerchantDocumentType, I18nKey> = {
  business_registration: 'reg.docRegistration',
  trading_license: 'reg.docLicense',
  tin_certificate: 'reg.docTin',
  owner_id: 'reg.docOwnerId',
  payout_account: 'reg.docPayout',
};

const DOC_STATUS: Record<MerchantDocumentStatus['status'], { label: I18nKey; tone: 'neutral' | 'success' | 'danger' | 'warning' }> = {
  missing: { label: 'ver.docMissing', tone: 'neutral' },
  pending: { label: 'ver.docPending', tone: 'warning' },
  approved: { label: 'ver.docApproved', tone: 'success' },
  rejected: { label: 'ver.docRejected', tone: 'danger' },
};

export default function VerificationScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const hydratePrivate = useMerchantsStore((s) => s.hydratePrivate);
  const commercial = useMerchantsStore((s) => s.commercial);
  const [status, setStatus] = useState<OnboardingStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retakeDoc, setRetakeDoc] = useState<MerchantDocumentStatus | null>(null);
  const [resubmitting, setResubmitting] = useState(false);
  const [resubmitError, setResubmitError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await api.get<OnboardingStatusResponse>('/onboarding/status', { retries: 1 });
      setStatus(res);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('ver.error'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    hydratePrivate();
  }, [load, hydratePrivate]);

  useEffect(() => {
    // Poll while verification is pending — transitions arrive as lead.reviewed.
    if (status?.verification.status !== 'pending' && status?.verification.status !== 'documents_review') return;
    const timer = setInterval(() => {
      load();
      hydratePrivate();
    }, 10000);
    return () => clearInterval(timer);
  }, [status?.verification.status, load, hydratePrivate]);

  const retake = async () => {
    if (!retakeDoc) return;
    setResubmitting(true);
    setResubmitError('');
    try {
      const res = await api.post<{ docs: MerchantDocumentStatus[] }>('/onboarding/docs', {
        docs: [
          { type: retakeDoc.type, fileName: retakeDoc.fileName ?? `${retakeDoc.type}-retake.jpg`, mime: 'image/jpeg', sizeBytes: 2.4 * 1024 * 1024 },
        ],
      });
      const next = res.docs;
      setStatus((s) => (s ? { ...s, verification: { ...s.verification, documents: next } } : s));
      setRetakeDoc(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setResubmitError(e instanceof ApiError ? e.message : t('ver.errResubmit'));
    } finally {
      setResubmitting(false);
    }
  };

  const resubmit = async () => {
    setResubmitting(true);
    setResubmitError('');
    try {
      await api.post('/onboarding/submit');
      await load();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setResubmitError(e instanceof ApiError ? e.message : t('ver.errResubmit'));
    } finally {
      setResubmitting(false);
    }
  };

  const openSupport = () => router.push('/dashboard/support');

  const v = status?.verification;
  const terms: MerchantCommercialTerms | null = commercial ?? null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('ver.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {loading && !status ? (
          <Card style={styles.centerCard}>
            <Text style={{ color: Colors.textSecondary, fontSize: FontSize.sm }}>{t('ver.loading')}</Text>
          </Card>
        ) : v ? (
          <>
            {v.status === 'pending' || v.status === 'documents_review' ? (
              <Card style={styles.heroCard}>
                <View style={styles.spinnerRing}>
                  <Icon name="hourglass-outline" size={26} color={Colors.warning} />
                </View>
                <Text style={styles.heroTitle}>
                  {t(v.status === 'documents_review' ? 'ver.documentsReviewTitle' : 'ver.pendingTitle')}
                </Text>
                <Text style={styles.heroBody}>
                  {t(v.status === 'documents_review' ? 'ver.documentsReviewBody' : 'ver.pendingBody')}
                </Text>
                {v.status === 'pending' ? <Text style={styles.heroMeta}>{t('ver.reviewEta')}</Text> : null}
                {v.submittedAt ? <Text style={styles.heroMeta}>{t('ver.submittedAt', { time: new Date(v.submittedAt).toLocaleTimeString() })}</Text> : null}
              </Card>
            ) : null}

            {v.status === 'approved' ? (
              <Card style={[styles.heroCard, { borderColor: Colors.success, borderWidth: 1.5 }]}>
                <Icon name="checkmark-circle" size={40} color={Colors.success} />
                <Text style={styles.heroTitle}>{t('ver.approvedTitle')}</Text>
                <Text style={styles.heroBody}>{t('ver.approvedBody')}</Text>
                <Btn label={t('ver.goDashboard')} size="md" onPress={() => router.replace('/dashboard')} style={{ marginTop: Spacing.sm }} />
              </Card>
            ) : null}

            {v.status === 'rejected' ? (
              <Card style={[styles.heroCard, { borderColor: Colors.danger, borderWidth: 1.5 }]}>
                <Icon name="close-circle" size={40} color={Colors.danger} />
                <Text style={styles.heroTitle}>{t('ver.rejectedTitle')}</Text>
                <Text style={styles.heroBody}>{t('ver.rejectedBody', { reason: v.reason ?? '—' })}</Text>
                <Btn label={t('ver.contactSupport')} variant="outline" size="md" onPress={openSupport} style={{ marginTop: Spacing.sm }} />
              </Card>
            ) : null}

            {v.status === 'suspended' ? (
              <Card style={[styles.heroCard, { borderColor: Colors.danger, borderWidth: 1.5 }]}>
                <Icon name="pause-circle-outline" size={40} color={Colors.danger} />
                <Text style={styles.heroTitle}>{t('ver.suspendedTitle')}</Text>
                <Text style={styles.heroBody}>{t('ver.suspendedBody', { reason: v.reason ?? '—' })}</Text>
                <Btn label={t('ver.contactSupport')} variant="outline" size="md" onPress={openSupport} style={{ marginTop: Spacing.sm }} />
              </Card>
            ) : null}

            {v.status === 'changes_requested' ? (
              <Card style={[styles.heroCard, { borderColor: Colors.warning, borderWidth: 1.5 }]}>
                <Icon name="alert-circle" size={40} color={Colors.warning} />
                <Text style={styles.heroTitle}>{t('ver.changesTitle')}</Text>
                <Text style={styles.heroBody}>{t('ver.changesBody', { reason: v.reason ?? '—' })}</Text>
                <Btn label={t('ver.changesAction')} size="md" loading={resubmitting} onPress={resubmit} style={{ marginTop: Spacing.sm }} />
              </Card>
            ) : null}

            {resubmitError ? <Text style={styles.error}>{resubmitError}</Text> : null}

            {v.status === 'approved' && terms ? (
              <>
                <Text style={styles.sectionLabel}>{t('ver.commercialTitle')}</Text>
                <Card style={{ gap: Spacing.sm }}>
                  {terms.commissionRateBps !== undefined ? (
                    <Row style={{ justifyContent: 'space-between' }}>
                      <Text style={styles.termLabel}>{t('ver.commissionRate', { pct: (terms.commissionRateBps / 100).toFixed(2) })}</Text>
                    </Row>
                  ) : null}
                  {terms.payoutCycleDays !== undefined ? (
                    <Text style={styles.termBody}>{t('ver.payoutCycle', { days: terms.payoutCycleDays })}</Text>
                  ) : null}
                  {terms.payoutAccount ? (
                    <Text style={styles.termBody}>{t('ver.payoutAccount', { account: terms.payoutAccount })}</Text>
                  ) : null}
                </Card>
              </>
            ) : null}

            {v.documents.length > 0 ? (
              <>
                <Text style={styles.sectionLabel}>{t('ver.documents')}</Text>
                <Card style={{ paddingVertical: 0, overflow: 'hidden' }}>
                  {v.documents.map((d, i) => {
                    const meta = DOC_STATUS[d.status];
                    const canRetake = d.status === 'rejected' || d.status === 'missing' || v.status === 'documents_review';
                    return (
                      <View key={d.type}>
                        {i > 0 ? <View style={styles.divider} /> : null}
                        <Row style={{ justifyContent: 'space-between', alignItems: 'center', paddingVertical: Spacing.sm }}>
                          <View style={{ flex: 1, gap: 2 }}>
                            <Text style={{ fontSize: FontSize.md, fontWeight: '600', color: Colors.text }}>{t(DOC_LABEL[d.type])}</Text>
                            {d.fileName ? <Text style={styles.termBody} numberOfLines={1}>{d.fileName}</Text> : null}
                          </View>
                          <Pill label={t(meta.label)} tone={meta.tone} />
                          {canRetake ? (
                            <Btn label={t('ver.retake')} variant="subtle" size="sm" onPress={() => setRetakeDoc(d)} />
                          ) : null}
                        </Row>
                      </View>
                    );
                  })}
                </Card>
              </>
            ) : null}

            {v.status === 'pending' || v.status === 'rejected' || v.status === 'suspended' ? (
              <Btn label={t('ver.contactSupport')} variant="outline" size="md" onPress={openSupport} style={{ marginTop: Spacing.md }} />
            ) : null}
          </>
        ) : (
          <Empty icon="shield-checkmark-outline" title={t('ver.error')} sub={t('ver.error')} />
        )}
      </Screen>

      <SheetModal visible={!!retakeDoc} onClose={() => setRetakeDoc(null)} title={retakeDoc ? t(DOC_LABEL[retakeDoc.type]) : ''}>
        <View style={{ gap: Spacing.md }}>
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 }}>
            {t('ver.documentsReviewBody')}
          </Text>
          {resubmitError ? <Text style={styles.error}>{resubmitError}</Text> : null}
          <Btn label={t('ver.retake')} size="lg" loading={resubmitting} onPress={retake} />
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
  error: { color: Colors.danger, fontSize: FontSize.xs, marginTop: Spacing.sm },
  centerCard: { alignItems: 'center', paddingVertical: Spacing.xl, marginTop: Spacing.lg },
  heroCard: { alignItems: 'center', gap: 8, paddingVertical: Spacing.xl, marginTop: Spacing.lg },
  spinnerRing: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: Colors.warningSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, textAlign: 'center' },
  heroBody: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20, textAlign: 'center' },
  heroMeta: { fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'center' },
  sectionLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '700', letterSpacing: 0.5, marginTop: Spacing.lg, marginBottom: Spacing.sm },
  termLabel: { fontSize: FontSize.md, color: Colors.text, fontWeight: '700' },
  termBody: { fontSize: FontSize.xs, color: Colors.textSecondary, lineHeight: 17 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border },
});
