/* Promo center — MASTER-BLUEPRINT §16 screen 2: active platform + merchant
 * offers with countdowns (Promotion.endsAt — a real contract field; absent
 * endsAt renders the honest "Valid now" pill), coupons available for claim,
 * and live group-buy deals. Every section renders from contract data only.
 */
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Btn, Card, EmptyState, ErrorState, Icon, MoneyText, Pill, Row, Screen, SectionTitle, SkeletonCard } from '@/components/ui';
import { useDealClock } from '@/components/DealCountdown';
import { FlashDealCard } from '@/components/FlashDealCard';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { formatTZS } from '@/lib/format';
import { selectFlashDeals } from '@/lib/flash';
import { countdownISO, dateISO } from '@/lib/dates';
import { idempotencyKey } from '@/lib/idempotency';
import { track } from '@/lib/analytics';
import { toast } from '@/store/ui';
import { useSessionStore } from '@/store/session';
import { ApiError } from '@/api/client';
import { getCouponsRepository, getGroupBuyRepository, getHomeRepository, getMarketingRepository, getMerchantsRepository } from '@/repos';
import type { Coupon, GetConsumerHome200, GroupBuyDeal, LiveDealSession, MerchantPublic, Promotion } from '@hudumika/contract';
import { CouponStatus, LiveDealSessionStatus, PromotionType } from '@hudumika/contract';

interface MerchantOffer {
  merchant: MerchantPublic;
  promotions: Promotion[];
}

const isLive = (p: Promotion) =>
  p.status === 'live' && (!p.endsAt || Date.parse(p.endsAt) > Date.now());

/** "Ends in {t}" from the real Promotion.endsAt, or the honest "Valid now"
 * pill when the contract carries no end date. */
function expiryPill(p: Promotion) {
  if (p.endsAt) {
    return <Pill label={t('promo.endsIn', { t: countdownISO(p.endsAt) })} tone="warning" />;
  }
  return <Pill label={t('promo.validNow')} tone="success" />;
}

export default function PromoCenterScreen() {
  const router = useRouter();
  const now = useDealClock();
  const user = useSessionStore((s) => s.user);
  const [feed, setFeed] = useState<GetConsumerHome200 | null>(null);
  const [offers, setOffers] = useState<MerchantOffer[] | null>(null);
  const [coupons, setCoupons] = useState<Coupon[] | null>(null);
  const [deals, setDeals] = useState<GroupBuyDeal[] | null>(null);
  const [liveSessions, setLiveSessions] = useState<LiveDealSession[]>([]);
  const [error, setError] = useState('');
  const [claiming, setClaiming] = useState<Set<string>>(new Set());
  const [claimedPromos, setClaimedPromos] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setError('');
    try {
      const [home, couponList, groupBuys, live] = await Promise.all([
        getHomeRepository().getHomeFeed(),
        getCouponsRepository().list('available'),
        getGroupBuyRepository().list(),
        getMarketingRepository().listLiveDeals(),
      ]);
      setFeed(home);
      setCoupons(couponList);
      setDeals(groupBuys);
      setLiveSessions(live.sessions.filter((s) => s.status === LiveDealSessionStatus.live));
      // Merchant offers: one fetch per seeded merchant; merchants without
      // promotions stay out of the section entirely.
      const perMerchant = await Promise.all(
        (home.merchants ?? []).map(async (m) => {
          try {
            const promos = (await getMerchantsRepository().getPromotions(m.id)).filter(isLive);
            return { merchant: m, promotions: promos };
          } catch {
            return { merchant: m, promotions: [] };
          }
        }),
      );
      setOffers(perMerchant.filter((o) => o.promotions.length > 0));
    } catch {
      setError(t('common.error'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const claim = async (promotion: Promotion) => {
    const promoId = promotion.id ?? '';
    if (!promoId || claiming.has(promoId)) return;
    setClaiming((prev) => new Set(prev).add(promoId));
    try {
      await getCouponsRepository().claim(promoId, idempotencyKey(user?.id ?? 'customer', 'promo-claim'));
      setClaimedPromos((prev) => new Set(prev).add(promoId));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      track({ name: 'coupon_claimed', couponId: promoId });
      toast(t('merchant.claimed'));
      load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'COUPON_ALREADY_CLAIMED') {
        setClaimedPromos((prev) => new Set(prev).add(promoId));
        toast(t('coupons.alreadyClaimed'), 'info');
      } else if (e instanceof ApiError && e.code === 'COUPON_EXPIRED') {
        toast(t('coupons.expired'), 'error');
      } else {
        toast(t('common.error'), 'error');
      }
    } finally {
      setClaiming((prev) => {
        const next = new Set(prev);
        next.delete(promoId);
        return next;
      });
    }
  };

  const claimCoupon = async (coupon: Coupon) => {
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

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  const loading = !feed || !offers || !coupons || !deals;

  if (loading) {
    return (
      <Screen>
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={2} />
          <SkeletonCard rows={2} />
          <SkeletonCard rows={2} />
        </View>
      </Screen>
    );
  }

  const platformPromos = (feed.promotions ?? []).filter(isLive);
  const empty =
    platformPromos.length === 0 && offers.length === 0 && coupons.length === 0 && deals.length === 0;

  const promoCard = (p: Promotion, onOpen?: () => void) => {
    const promoId = p.id ?? '';
    const claimed = claimedPromos.has(promoId);
    const body = (
      <Card style={styles.card}>
        <Row gap={Spacing.md}>
          <View style={{ flex: 1 }}>
            <Row gap={Spacing.sm} style={{ justifyContent: 'space-between' }}>
              <Text style={styles.promoTitle} numberOfLines={1}>{p.title}</Text>
              {expiryPill(p)}
            </Row>
            {p.description ? <Text style={styles.meta}>{p.description}</Text> : null}
            {p.thresholdTZS ? <Text style={styles.meta}>{t('promo.threshold', { amount: formatTZS(p.thresholdTZS) })}</Text> : null}
          </View>
          {p.type === PromotionType.coupon ? (
            claimed ? (
              <Pill label={t('merchant.claimed')} tone="success" />
            ) : (
              <Btn label={t('merchant.claim')} onPress={() => claim(p)} size="sm" loading={claiming.has(promoId)} />
            )
          ) : null}
        </Row>
      </Card>
    );
    return onOpen ? (
      <Pressable key={promoId || p.title} onPress={onOpen} accessibilityRole="button" style={({ pressed }) => [{ opacity: pressed ? 0.88 : 1 }]}>
        {body}
      </Pressable>
    ) : (
      <View key={promoId || p.title}>{body}</View>
    );
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }} showsVerticalScrollIndicator={false}>
        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <Text style={styles.title}>{t('promo.title')}</Text>
          <View style={{ width: 40 }} />
        </Row>

        {empty ? (
          <EmptyState icon="pricetags-outline" title={t('promo.empty')} />
        ) : (
          <>
            {/* Flash deals (神抢手-lite) — live group-buy sales ending soon
                (src/lib/flash.ts), highlighted at the top. Hidden when none
                qualify; the full group-buy list stays below. */}
            {selectFlashDeals(deals, now).length > 0 ? (
              <>
                <SectionTitle title={t('promo.flashDeals')} icon="timer" />
                <FlatList
                  horizontal
                  data={selectFlashDeals(deals, now)}
                  keyExtractor={(d) => d.id ?? d.title}
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: Spacing.md }}
                  renderItem={({ item }) => (
                    <FlashDealCard deal={item} now={now} onPress={() => router.push(`/group-buys/${item.id}`)} />
                  )}
                />
              </>
            ) : null}

            {/* Live deals zone (神抢手-lite sessions) — scheduled flash-sale
                sessions with countdowns (GET /marketing/live-deals). A teaser
                card into the full zone while a session is running; hidden
                when none are live (per-section honesty). */}
            {liveSessions.length > 0 ? (
              <>
                <SectionTitle title={t('liveDeals.title')} icon="radio" />
                <Card style={styles.card} onPress={() => router.push('/live-deals')}>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Row gap={Spacing.sm}>
                      <Icon name="radio" size={16} color={Colors.danger} />
                      <Text style={styles.liveTitle} numberOfLines={1}>{liveSessions[0].title}</Text>
                    </Row>
                    <Row gap={4}>
                      <Text style={styles.liveCta}>{t('liveDeals.liveNow')}</Text>
                      <Icon name="chevron-forward" size={15} color={Colors.danger} />
                    </Row>
                  </Row>
                </Card>
              </>
            ) : null}

            {platformPromos.length > 0 ? (
              <>
                <SectionTitle title={t('promo.platform')} icon="sparkles" />
                {platformPromos.map((p) => promoCard(p))}
              </>
            ) : null}

            {coupons.length > 0 ? (
              <>
                <SectionTitle title={t('promo.coupons')} icon="pricetag" />
                {coupons.map((c) => (
                  <Card key={c.id} style={styles.card}>
                    <Row style={{ justifyContent: 'space-between' }}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.code}>{c.code}</Text>
                        <Text style={styles.meta}>{c.title ?? ''}</Text>
                        <Text style={styles.meta}>
                          {t('coupons.minSpend', { amount: formatTZS(c.minimumSpendTZS ?? 0) })}
                          {c.expiresAt ? ` · ${t('coupons.validUntil', { t: dateISO(c.expiresAt) })}` : ''}
                        </Text>
                      </View>
                      <MoneyText amountTZS={c.discountTZS ?? 0} size={FontSize.lg} bold />
                    </Row>
                    <Row style={{ justifyContent: 'flex-end', marginTop: Spacing.md }}>
                      {c.status === CouponStatus.available ? (
                        <Btn label={t('coupons.claim')} onPress={() => claimCoupon(c)} size="sm" />
                      ) : (
                        <Pill label={t('coupons.claimed')} tone="success" />
                      )}
                    </Row>
                  </Card>
                ))}
              </>
            ) : null}

            {offers.length > 0 ? (
              <>
                <SectionTitle title={t('promo.merchantOffers')} icon="storefront" />
                {offers.map(({ merchant, promotions }) => (
                  <View key={merchant.id}>
                    <Text style={styles.merchantName}>{merchant.businessName}</Text>
                    {promotions.map((p) => promoCard(p, () => router.push(`/merchant/${merchant.id}`)))}
                  </View>
                ))}
              </>
            ) : null}

            {deals.length > 0 ? (
              <>
                <SectionTitle title={t('promo.liveDeals')} icon="megaphone" />
                {deals.map((d) => {
                  const pct = d.originalPriceTZS > 0 ? Math.round((1 - d.priceTZS / d.originalPriceTZS) * 100) : 0;
                  return (
                    <Card key={d.id} style={styles.card} onPress={() => router.push(`/group-buys/${d.id}`)}>
                      <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.sm }}>
                        <Text style={styles.promoTitle} numberOfLines={2}>{d.title}</Text>
                        {pct > 0 ? (
                          <View style={styles.discountBadge}>
                            <Text style={styles.discountText}>−{pct}%</Text>
                          </View>
                        ) : null}
                      </Row>
                      {d.description ? <Text style={styles.meta}>{d.description}</Text> : null}
                      <Row style={{ justifyContent: 'space-between', marginTop: Spacing.md }}>
                        <View>
                          <Text style={styles.oldPrice}>{formatTZS(d.originalPriceTZS)}</Text>
                          <MoneyText amountTZS={d.priceTZS} size={FontSize.lg} bold />
                        </View>
                        <Btn label={t('groupBuy.buy')} size="sm" onPress={() => router.push(`/group-buys/${d.id}`)} />
                      </Row>
                    </Card>
                  );
                })}
              </>
            ) : null}

            <Btn
              label={t('promo.viewAllCoupons')}
              onPress={() => router.push('/coupons')}
              variant="ghost"
              icon="pricetags-outline"
              style={{ marginTop: Spacing.lg, alignSelf: 'center' }}
            />
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text, flex: 1, textAlign: 'center' },
  card: { marginBottom: Spacing.md },
  promoTitle: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text, flex: 1, paddingRight: Spacing.sm },
  merchantName: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sansBold, marginBottom: Spacing.sm, marginTop: Spacing.xs },
  code: { fontSize: FontSize.lg, fontFamily: Fonts.displayBold, color: Colors.text, letterSpacing: 1 },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  oldPrice: { fontSize: FontSize.xs, color: Colors.textFaint, fontFamily: Fonts.sansMedium, textDecorationLine: 'line-through' },
  discountBadge: { backgroundColor: Colors.danger, borderRadius: Radius.sm, paddingHorizontal: 8, paddingVertical: 4 },
  discountText: { color: Colors.white, fontSize: FontSize.xs, fontFamily: Fonts.sansExtraBold },
  liveTitle: { flex: 1, fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text },
  liveCta: { color: Colors.danger, fontSize: FontSize.xs, fontFamily: Fonts.sansBold, letterSpacing: 0.3 },
});
