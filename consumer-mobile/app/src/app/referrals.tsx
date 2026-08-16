/* Referrals (M16f, contract GET /referrals/me + POST /referrals/claim) — my
 * referral summary (code, invited count, status pill, total earned) with a
 * "Have a code? Claim it" sheet. Deep links hudumika://referral/{code} arrive
 * as ?code= (deep-link allow-list) and prefill + auto-open the claim sheet. */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Clipboard, Platform, Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';

import { Btn, Card, ErrorState, Icon, Pill, Row, Screen, SheetModal, SkeletonCard } from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { ApiError } from '@/api/client';
import { getRewardsRepository } from '@/repos';
import { toast } from '@/store/ui';
import { formatTZS } from '@/lib/format';
import { idempotencyKey } from '@/lib/idempotency';
import type { ReferralSummary } from '@hudumika/contract';

export default function ReferralsScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ code?: string }>();

  const [summary, setSummary] = useState<ReferralSummary | null>(null);
  const [error, setError] = useState(false);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [code, setCode] = useState('');
  const [claiming, setClaiming] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    setError(false);
    try {
      setSummary(await getRewardsRepository().getMyReferral());
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Deep link hudumika://referral/{code} → /referrals?code={code}: prefill the
  // claim sheet and open it (the summary loads in the background regardless).
  useEffect(() => {
    const deepCode = typeof params.code === 'string' && params.code ? params.code : undefined;
    if (deepCode) {
      setCode(deepCode.toUpperCase());
      setFormError('');
      setSheetOpen(true);
    }
  }, [params.code]);

  const openSheet = () => {
    setFormError('');
    setSheetOpen(true);
  };

  const claim = async () => {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) {
      setFormError(t('referral.error.unknown'));
      return;
    }
    setFormError('');
    setClaiming(true);
    try {
      const key = idempotencyKey('customer', 'referral-claim');
      const reward = await getRewardsRepository().claimReferral(trimmed, key);
      setSheetOpen(false);
      setCode('');
      toast(t('referral.claimSuccess', { amount: formatTZS(reward.amountTZS) }));
    } catch (e) {
      // 422 (bad format) / 404 (unknown code) / 409 (already claimed) all say
      // "could not be used"; only claiming your own code has specific copy.
      if (e instanceof ApiError && e.details?.reason === 'self') {
        setFormError(t('referral.error.self'));
      } else {
        setFormError(t('referral.error.unknown'));
      }
    } finally {
      setClaiming(false);
    }
  };

  const copyCode = async () => {
    if (!summary) return;
    try {
      if (Platform.OS === 'web' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(summary.code);
      } else {
        Clipboard.setString(summary.code);
      }
      toast(t('referral.copied'));
    } catch {
      /* clipboard unavailable — the code text stays selectable */
    }
  };

  const shareCode = async () => {
    if (!summary || Platform.OS === 'web') return;
    const payload = `hudumika://referral/${summary.code}`;
    try {
      await Share.share({ message: payload, url: payload });
    } catch {
      /* share dismissed or unsupported */
    }
  };

  return (
    <Screen>
      <View style={styles.header}>
        <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
        <Text style={styles.title}>{t('referral.title')}</Text>
        <View style={{ width: 64 }} />
      </View>

      {error ? (
        <View style={{ padding: Spacing.lg }}>
          <ErrorState message={t('common.error')} onRetry={load} />
        </View>
      ) : !summary ? (
        <View style={{ padding: Spacing.lg, gap: Spacing.md }}>
          <SkeletonCard rows={3} />
        </View>
      ) : (
        <View style={{ padding: Spacing.lg, gap: Spacing.md }}>
          <Card style={styles.codeCard}>
            <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <View style={{ gap: 2 }}>
                <Text style={styles.codeLabel}>{t('referral.code')}</Text>
                <Text style={styles.code}>{summary.code}</Text>
                <Text style={styles.meta}>{t('referral.invited', { n: summary.invitedCount })}</Text>
              </View>
              <Pill
                label={summary.rewardStatus === 'paid' ? t('referral.paid') : t('referral.pending')}
                tone={summary.rewardStatus === 'paid' ? 'success' : 'info'}
              />
            </Row>
            <Row style={{ justifyContent: 'space-between', marginTop: Spacing.md }}>
              <Text style={styles.meta}>{t('referral.earned')}</Text>
              <Text style={styles.earned}>{formatTZS(summary.totalRewardTZS ?? 0)}</Text>
            </Row>
            <Row style={{ gap: Spacing.sm, marginTop: Spacing.lg }}>
              <Btn label={t('referral.copy')} onPress={copyCode} variant="outline" style={{ flex: 1 }} />
              <Btn label={t('referral.share')} onPress={shareCode} style={{ flex: 1 }} />
            </Row>
          </Card>

          <Pressable
            onPress={openSheet}
            accessibilityRole="button"
            accessibilityLabel={t('referral.claimTitle')}
            style={({ pressed }) => [styles.claimRow, pressed && { opacity: 0.8 }]}>
            <View style={styles.claimIcon}>
              <Icon name="gift" size={18} color={Colors.primaryDeep} />
            </View>
            <Text style={styles.claimLabel}>{t('referral.claimTitle')}</Text>
            <Icon name="chevron-forward" size={15} color={Colors.textFaint} />
          </Pressable>
        </View>
      )}

      <SheetModal visible={sheetOpen} onClose={() => setSheetOpen(false)} title={t('referral.claimTitle')}>
        <View style={{ gap: Spacing.md }}>
          <TextInput
            value={code}
            onChangeText={(v) => setCode(v.toUpperCase())}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={20}
            placeholder={t('referral.claimPlaceholder')}
            placeholderTextColor={Colors.textFaint}
            accessibilityLabel={t('referral.claimTitle')}
            style={styles.codeInput}
          />
          {formError ? <Text style={styles.formError}>{formError}</Text> : null}
          <Btn label={t('referral.claim')} onPress={claim} loading={claiming} size="lg" />
        </View>
      </SheetModal>
    </Screen>
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
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text, flex: 1, textAlign: 'center' },
  codeCard: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: Colors.primary,
  },
  codeLabel: {
    fontSize: FontSize.xs,
    color: Colors.textTertiary,
    fontFamily: Fonts.sansSemibold,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  code: { fontSize: 26, fontFamily: Fonts.sansExtraBold, color: Colors.primaryDeep, letterSpacing: 1.5, marginTop: 2 },
  meta: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sans },
  earned: { fontSize: FontSize.md, fontFamily: Fonts.sansBold, color: Colors.text, fontVariant: ['tabular-nums'] },
  claimRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    backgroundColor: Colors.card,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  claimIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: Colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  claimLabel: { flex: 1, fontSize: FontSize.md, color: Colors.text, fontFamily: Fonts.sansMedium },
  codeInput: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    fontSize: FontSize.lg,
    color: Colors.text,
    fontFamily: Fonts.sans,
    backgroundColor: Colors.card,
    letterSpacing: 3,
    textAlign: 'center',
  },
  formError: { color: Colors.danger, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold },
});
