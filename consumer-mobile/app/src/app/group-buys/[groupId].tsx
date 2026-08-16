/* Group-buy detail + purchase — GET /group-buys/{id} (deal detail incl.
 * terminal states) + POST /group-buys/{id}/purchase (idempotent; server
 * issues vouchers). Buy is gated on status === 'live'; ended/delisted/
 * rejected render the "Deal no longer available" banner (GROUP-BUY.md). */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Btn, Card, ErrorState, Icon, MoneyText, Row, Screen, SkeletonCard, StatusPill } from '@/components/ui';
import { DealCountdownPill, useDealClock } from '@/components/DealCountdown';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { toast } from '@/store/ui';
import { getGroupBuyRepository } from '@/repos';
import { idempotencyKey } from '@/lib/idempotency';
import { dateISO, formatDealCountdown } from '@/lib/dates';
import { formatTZS } from '@/lib/format';
import { track } from '@/lib/analytics';
import { ApiError } from '@/api/client';
import type { GroupBuyDeal, Voucher } from '@hudumika/contract';

const TERMINAL_UNPURCHASABLE = ['ended', 'delisted', 'rejected'];

export default function GroupBuyDetailScreen() {
  const router = useRouter();
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const [deal, setDeal] = useState<GroupBuyDeal | null>(null);
  const [error, setError] = useState('');
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [vouchers, setVouchers] = useState<Voucher[] | null>(null);
  const [notice, setNotice] = useState('');
  const now = useDealClock();

  const load = useCallback(async () => {
    setError('');
    try {
      setDeal(await getGroupBuyRepository().get(groupId));
    } catch (e) {
      setError(e instanceof ApiError && (e.status === 404 || e.code === 'GROUP_BUY_NOT_FOUND') ? t('groupBuy.notFound') : t('common.error'));
    }
  }, [groupId]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const purchase = async () => {
    if (!deal) return;
    setBusy(true);
    setNotice('');
    try {
      const issued = await getGroupBuyRepository().purchase(groupId, qty, idempotencyKey('cus_1', 'group-buy'));
      setVouchers(issued);
      track({ name: 'group_buy_purchased', entityId: groupId, quantity: qty });
      toast(t('groupBuy.purchased', { n: issued.length }));
    } catch (e) {
      if (e instanceof ApiError) {
        switch (e.code) {
          case 'GROUP_BUY_ENDED':
            // Deal ended while viewing — refetch and let the banner render.
            setNotice(t('groupBuy.ended'));
            load();
            break;
          case 'GROUP_BUY_STATUS_CONFLICT':
            setNotice(t('groupBuy.statusConflict'));
            load();
            break;
          case 'GROUP_BUY_QUANTITY_EXCEEDED':
            setNotice(t('groupBuy.quantityExceeded'));
            break;
          default:
            toast(e.message, 'error');
        }
      } else {
        toast(t('common.error'), 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (!deal) {
    return (
      <Screen>
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  const pct = deal.originalPriceTZS > 0 ? Math.round((1 - deal.priceTZS / deal.originalPriceTZS) * 100) : 0;
  const remaining = deal.quantity - (deal.soldCount ?? 0);
  // The sale clock can expire while status still reads live — gate the Buy
  // CTA on the countdown too (the server enforces this on purchase).
  const clockEnded = formatDealCountdown(deal.salesEndAt, now) === null;
  const purchasable = deal.status === 'live' && !clockEnded;
  const unavailable = TERMINAL_UNPURCHASABLE.includes(deal.status);

  return (
    <Screen scroll>
      <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
        <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
        <Text style={styles.title}>{t('groupBuy.deal')}</Text>
        <StatusPill status={deal.status} />
      </Row>

      {unavailable ? (
        <Card style={[styles.bannerCard, { backgroundColor: Colors.warningSoft }]}>
          <Row gap={Spacing.md}>
            <Icon name="alert-circle-outline" size={18} color={Colors.warning} />
            <Text style={[styles.meta, { color: Colors.text, flex: 1 }]}>{t('groupBuy.noLongerAvailable')}</Text>
          </Row>
        </Card>
      ) : null}

      <Card style={{ gap: Spacing.md }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.name}>{deal.title}</Text>
          {pct > 0 ? (
            <View style={styles.discountBadge}>
              <Text style={styles.discountText}>−{pct}%</Text>
            </View>
          ) : null}
        </Row>
        {deal.description ? <Text style={styles.meta}>{deal.description}</Text> : null}
        <View>
          <Text style={styles.oldPrice}>{formatTZS(deal.originalPriceTZS)}</Text>
          <MoneyText amountTZS={deal.priceTZS} size={FontSize.xxl} bold />
        </View>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.meta}>{t('groupBuy.sold', { n: deal.soldCount ?? 0 })}</Text>
          <Text style={styles.meta}>{t('groupBuy.remaining', { n: Math.max(0, remaining) })}</Text>
        </Row>
        <Text style={styles.meta}>{t('groupBuy.validity', { n: deal.validityDays ?? 90 })}</Text>
        <Text style={styles.meta}>{t('groupBuy.saleStarts', { t: dateISO(deal.salesStartAt) })}</Text>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.meta}>{t('groupBuy.saleEnds', { t: dateISO(deal.salesEndAt) })}</Text>
          <DealCountdownPill endsAt={deal.salesEndAt} now={now} />
        </Row>
      </Card>

      {vouchers ? (
        <Card style={{ marginTop: Spacing.lg, gap: Spacing.md }}>
          <Text style={styles.sectionLabel}>{t('groupBuy.yourVouchers')}</Text>
          {vouchers.map((v) => (
            <View key={v.code} style={styles.voucherLine}>
              <Icon name="qr-code-outline" size={16} color={Colors.primaryDeep} />
              <View style={{ flex: 1 }}>
                <Text style={styles.code}>{v.code}</Text>
                <Text style={styles.meta}>{t('groupBuy.expires', { t: dateISO(v.expiresAt ?? deal.salesEndAt) })}</Text>
              </View>
              <Btn label={t('groupBuy.useNow')} size="sm" variant="ghost" onPress={() => router.push('/vouchers')} />
            </View>
          ))}
        </Card>
      ) : purchasable ? (
        <>
          <Card style={{ marginTop: Spacing.lg }}>
            <Text style={styles.sectionLabel}>{t('groupBuy.quantity')}</Text>
            <Row gap={Spacing.md} style={{ justifyContent: 'space-between' }}>
              <Pressable
                onPress={() => setQty((q) => Math.max(1, q - 1))}
                accessibilityRole="button"
                accessibilityLabel={t('common.back')}
                style={styles.qtyBtn}>
                <Icon name="remove" size={18} color={Colors.text} />
              </Pressable>
              <Text style={[styles.qty, { fontVariant: ['tabular-nums'] }]}>{qty}</Text>
              <Pressable onPress={() => setQty((q) => Math.min(20, q + 1))} accessibilityRole="button" style={styles.qtyBtn}>
                <Icon name="add" size={18} color={Colors.text} />
              </Pressable>
            </Row>
          </Card>
          {notice ? <Text style={styles.errorText}>{notice}</Text> : null}
          <Btn label={t('groupBuy.buyNow', { amount: formatTZS(deal.priceTZS * qty) })} size="lg" onPress={purchase} loading={busy} style={{ marginTop: Spacing.lg }} />
        </>
      ) : (
        <Text style={[styles.errorText, { marginTop: Spacing.lg, textAlign: 'center' }]}>{t('groupBuy.noLongerAvailable')}</Text>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text, flex: 1, textAlign: 'center' },
  name: { fontSize: FontSize.xl, fontFamily: Fonts.sansExtraBold, color: Colors.text, flex: 1, paddingRight: Spacing.md },
  discountBadge: { backgroundColor: Colors.danger, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  discountText: { color: Colors.white, fontSize: FontSize.sm, fontFamily: Fonts.sansExtraBold },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  oldPrice: { fontSize: FontSize.sm, color: Colors.textFaint, fontFamily: Fonts.sansMedium, textDecorationLine: 'line-through' },
  sectionLabel: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sansSemibold },
  voucherLine: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  code: { fontSize: FontSize.md, fontFamily: Fonts.sansBold, color: Colors.text, letterSpacing: 1, fontVariant: ['tabular-nums'] },
  qtyBtn: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: Colors.borderStrong, alignItems: 'center', justifyContent: 'center' },
  qty: { fontSize: FontSize.xl, fontFamily: Fonts.sansBold, color: Colors.text },
  bannerCard: { marginBottom: Spacing.md },
  errorText: { color: Colors.danger, fontSize: FontSize.xs, fontFamily: Fonts.sansSemibold, marginTop: Spacing.sm },
});
