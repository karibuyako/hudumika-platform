import { useCallback, useEffect, useState } from 'react';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  Btn,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  MoneyText,
  Pill,
  Row,
  Screen,
  SkeletonCard,
} from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { toast } from '@/store/ui';
import { getCouponsRepository } from '@/repos';
import type { Coupon } from '@hudumika/contract';
import { CouponStatus } from '@hudumika/contract';
import { ApiError } from '@/api/client';
import { useSessionStore } from '@/store/session';
import { dateISO } from '@/lib/dates';
import { formatTZS } from '@/lib/format';
import { idempotencyKey } from '@/lib/idempotency';
import { track } from '@/lib/analytics';

export default function CouponsScreen() {
  const router = useRouter();
  const user = useSessionStore((s) => s.user);
  const [coupons, setCoupons] = useState<Coupon[] | null>(null);
  const [error, setError] = useState('');
  const [revealCodeFor, setRevealCodeFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const list = await getCouponsRepository().list('claimed');
      const available = await getCouponsRepository().list('available');
      setCoupons([...list, ...available]);
    } catch {
      setError(t('common.error'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const claim = async (coupon: Coupon) => {
    try {
      const claimed = await getCouponsRepository().claim(coupon.id, idempotencyKey(user?.id ?? 'customer', 'coupon'));
      if (claimed.status === 'claimed') {
        track({ name: 'coupon_claimed', couponId: coupon.id });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        toast(t('coupons.claimSuccess'));
      }
      load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'COUPON_ALREADY_CLAIMED') load();
    }
  };

  const pillFor = (c: Coupon) => {
    if (c.status === 'used') return <Pill label={t('coupons.used')} tone="neutral" />;
    if (c.status === 'expired') return <Pill label={t('coupons.expired')} tone="neutral" />;
    if (c.status === 'void') return <Pill label={t('coupons.void')} tone="neutral" />;
    return null;
  };

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg }}>
        <Text style={styles.title}>{t('coupons.title')}</Text>
        <Pressable
          onPress={() => router.push('/promo-center')}
          accessibilityRole="button"
          accessibilityLabel={t('promo.title')}
          style={({ pressed }) => [styles.promoLink, pressed && { opacity: 0.8 }]}>
          <Row gap={Spacing.sm} style={{ justifyContent: 'space-between' }}>
            <Text style={styles.promoLinkText}>{t('promo.viewAllOffers')}</Text>
            <Icon name="arrow-forward" size={15} color={Colors.primaryDeep} />
          </Row>
        </Pressable>
      </View>
      {!coupons ? (
        <SkeletonCard rows={3} />
      ) : coupons.length === 0 ? (
        <EmptyState icon="pricetag-outline" title={t('coupons.empty')} />
      ) : (
        <FlatList
          data={coupons}
          keyExtractor={(c) => c.id}
          onRefresh={load}
          refreshing={false}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }}
            renderItem={({ item: c }) => {
              const isClaimed = c.status === CouponStatus.claimed;
              const revealed = revealCodeFor === c.id;
              return (
                <Card style={[styles.coupon, c.status === 'expired' && { opacity: 0.5 }]}>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.code}>{c.code}</Text>
                      <Text style={styles.desc}>{c.title ?? ''}</Text>
                      <Text style={styles.meta}>
                        {t('coupons.minSpend', { amount: formatTZS(c.minimumSpendTZS ?? 0) })}
                        {c.expiresAt ? ` · ${t('coupons.validUntil', { t: dateISO(c.expiresAt) })}` : ''}
                      </Text>
                    </View>
                    <MoneyText amountTZS={c.discountTZS ?? 0} size={FontSize.lg} bold />
                  </Row>
                  <Row style={{ justifyContent: 'space-between', marginTop: Spacing.md }}>
                    {pillFor(c)}
                    {c.status === 'available' ? (
                      <Btn label={t('coupons.claim')} onPress={() => claim(c)} size="sm" />
                    ) : isClaimed ? (
                      <Row gap={Spacing.sm}>
                        <Pill label={t('coupons.claimed')} tone="success" />
                        <Btn
                          label={revealed ? 'Hide' : t('vouchers.showCode')}
                          size="sm"
                          variant="ghost"
                          icon={revealed ? 'eye-off-outline' : 'qr-code-outline'}
                          onPress={() => setRevealCodeFor(revealed ? null : c.id)}
                        />
                      </Row>
                    ) : null}
                  </Row>
                  {isClaimed && revealed ? (
                    <View style={styles.verifyPanel}>
                      <Icon name="qr-code" size={36} color={Colors.primaryDeep} />
                      <Text style={styles.verifyCode}>{c.code}</Text>
                      <Text style={styles.verifyHint}>{t('vouchers.redeemHint')}</Text>
                    </View>
                  ) : null}
                </Card>
              );
            }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text, marginBottom: Spacing.md },
  coupon: { marginBottom: Spacing.md },
  code: { fontSize: FontSize.lg, fontFamily: Fonts.displayBold, color: Colors.text, letterSpacing: 1, fontVariant: ['tabular-nums'] },
  desc: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sansMedium, marginTop: 2 },
  meta: { fontSize: FontSize.xs, color: Colors.textFaint, fontFamily: Fonts.sans, marginTop: 4 },
  promoLink: {
    backgroundColor: Colors.primarySoft,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.primary,
  },
  promoLinkText: { fontSize: FontSize.sm, color: Colors.primaryDeep, fontFamily: Fonts.sansBold },
  verifyPanel: { alignItems: 'center', gap: Spacing.sm, borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: Spacing.md, marginTop: Spacing.md },
  verifyCode: { fontSize: FontSize.xl, fontFamily: Fonts.sansExtraBold, color: Colors.text, letterSpacing: 1.2, fontVariant: ['tabular-nums'] },
  verifyHint: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, textAlign: 'center' },
});
