import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { api } from '@/api/client';
import type { GroupBuyDeal, GroupBuyVoucher, VoucherStatus } from '@/api/types';
import { Btn, Card, Empty, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { dayLabel, fullTime, tzs } from '@/lib/format';
import { useGroupBuyStore } from '@/store/group-buy';

const EXTEND_CHOICES = [7, 14, 21, 30];
const TZ_DAY = 86400000;

const VOUCHER_META: Record<VoucherStatus, { label: I18nKey; tone: 'neutral' | 'info' | 'success' | 'danger' | 'warning' }> = {
  unused: { label: 'vch.statusUnused', tone: 'info' },
  redeemed: { label: 'vch.statusRedeemed', tone: 'success' },
  expired: { label: 'vch.statusExpired', tone: 'neutral' },
  refunded: { label: 'vch.statusRefunded', tone: 'neutral' },
  void: { label: 'vch.statusVoid', tone: 'neutral' },
};

export default function DealDetailScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const { id } = useLocalSearchParams<{ id: string }>();
  const getDeal = useGroupBuyStore((s) => s.getDeal);
  const extendDeal = useGroupBuyStore((s) => s.extendDeal);
  const delistDeal = useGroupBuyStore((s) => s.delistDeal);
  const relistDeal = useGroupBuyStore((s) => s.relistDeal);

  const [deal, setDeal] = useState<GroupBuyDeal | null>(null);
  const [failed, setFailed] = useState(false);
  const [vouchers, setVouchers] = useState<GroupBuyVoucher[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [extendOpen, setExtendOpen] = useState(false);
  const [extendDays, setExtendDays] = useState(EXTEND_CHOICES[0]);
  const [confirm, setConfirm] = useState<'delist' | 'relist' | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    const d = await getDeal(id);
    if (d) {
      setDeal(d);
      setFailed(false);
    } else {
      setFailed(true);
    }
    try {
      const res = await api.get<{ vouchers: GroupBuyVoucher[] }>(`/group-buys/${id}/vouchers`, { retries: 1 });
      setVouchers(res.vouchers);
    } catch {
      setVouchers(null);
    }
  }, [id, getDeal]);

  useEffect(() => {
    load();
  }, [load]);
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const runAction = async (fn: () => Promise<{ ok: boolean; deal?: GroupBuyDeal; code?: string; message?: string }>) => {
    if (!deal || busy) return;
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (res.ok && res.deal) {
      setDeal(res.deal);
      setError(null);
      setExtendOpen(false);
      setConfirm(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      setError(res.code === 'GROUP_BUY_STATUS_CONFLICT' ? t('gb.conflict') : res.message ?? t('gb.errCreate'));
      setExtendOpen(false);
      setConfirm(null);
      if (res.code === 'GROUP_BUY_STATUS_CONFLICT') load();
    }
  };

  if (!deal) {
    return (
      <Screen scroll>
        <Card style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.xl }}>
          {failed ? (
            <>
              <Icon name="cloud-offline-outline" size={22} color={Colors.textTertiary} />
              <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('gb.errLoad')}</Text>
              <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => { setFailed(false); load(); }} />
            </>
          ) : (
            <>
              <Icon name="time-outline" size={22} color={Colors.textTertiary} />
              <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary, marginTop: Spacing.sm }}>{t('mkt.loading')}</Text>
            </>
          )}
        </Card>
      </Screen>
    );
  }

  const editable = deal.status === 'draft' || deal.status === 'pending_review' || deal.status === 'rejected';
  const live = deal.status === 'live' || deal.status === 'extended';
  const newEndsAt = Math.max(deal.salesEndAt, Date.now()) + extendDays * TZ_DAY;

  return (
    <Screen scroll>
      <Card style={{ gap: Spacing.md }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.title} numberOfLines={2}>{deal.title}</Text>
          <Pill label={t(STATUS_LABEL(deal.status))} tone={STATUS_TONE(deal.status)} />
        </Row>
        {deal.status === 'rejected' && deal.rejectReason ? (
          <Text style={{ fontSize: FontSize.sm, color: Colors.danger, lineHeight: 18 }}>{t('gb.rejected', { reason: deal.rejectReason })}</Text>
        ) : null}
        <Row gap={8} style={{ alignItems: 'baseline' }}>
          <Text style={styles.price}>{tzs(deal.priceTZS)}</Text>
          <Text style={styles.priceOld}>{tzs(deal.originalPriceTZS)}</Text>
          <Pill label={t('gb.saveAmt', { amount: tzs(deal.originalPriceTZS - deal.priceTZS) })} tone="success" />
        </Row>
        <View style={styles.divider} />
        <InfoRow label={t('gb.soldOf', { sold: deal.soldCount, quantity: deal.quantity })} value={`${dayLabel(deal.salesStartAt)} ~ ${dayLabel(deal.salesEndAt)}`} />
        <View style={styles.divider} />
        <InfoRow label={t('gb.validity', { n: deal.validityDays })} value={deal.description ? deal.description.slice(0, 90) : ''} valueItalic />
      </Card>

      {error ? (
        <Card style={{ backgroundColor: Colors.dangerSoft, marginTop: Spacing.md }}>
          <Row gap={Spacing.sm}>
            <Icon name="alert-circle-outline" size={18} color={Colors.danger} />
            <Text style={{ fontSize: FontSize.sm, color: Colors.danger, fontWeight: '600', flex: 1 }}>{error}</Text>
          </Row>
        </Card>
      ) : null}

      <View style={styles.section}>
        <Row gap={Spacing.sm} style={{ marginBottom: Spacing.md }}>
          <Icon name="flash-outline" size={15} color={Colors.textTertiary} />
          <Text style={styles.sectionTitle}>{t('gb.actions')}</Text>
        </Row>
        <Card style={{ gap: Spacing.md }}>
          {editable ? (
            <Btn label={t('gb.editDeal')} icon="create-outline" onPress={() => router.push(`/marketing/deal/new?id=${deal.id}`)} />
          ) : null}
          {live ? (
            <>
              <Btn label={t('gb.extend')} icon="calendar-outline" variant="ghost" onPress={() => setExtendOpen(true)} />
              <Btn label={t('gb.delist')} icon="remove-circle-outline" variant="danger" onPress={() => setConfirm('delist')} />
            </>
          ) : null}
          {deal.status === 'delisted' ? (
            <Btn label={t('gb.relist')} icon="refresh" variant="ghost" onPress={() => setConfirm('relist')} />
          ) : null}
          {!editable && !live && deal.status !== 'delisted' ? (
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'center' }}>{t('gb.statusEnded')}</Text>
          ) : null}
        </Card>
      </View>

      <View style={styles.section}>
        <Row gap={Spacing.sm} style={{ marginBottom: Spacing.md }}>
          <Icon name="ticket-outline" size={15} color={Colors.textTertiary} />
          <Text style={styles.sectionTitle}>
            {vouchers ? t('gb.vouchersCount', { n: vouchers.length }) : t('vch.history')}
          </Text>
        </Row>
        {vouchers === null ? (
          <Card style={{ alignItems: 'center', paddingVertical: Spacing.lg }}>
            <Icon name="time-outline" size={20} color={Colors.textTertiary} />
          </Card>
        ) : vouchers.length === 0 ? (
          <Empty icon="ticket-outline" title={t('gb.noVouchers')} />
        ) : (
          <View style={{ gap: Spacing.sm }}>
            {vouchers.map((v) => (
              <Card key={v.code} style={{ paddingVertical: Spacing.md }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <View style={{ flex: 1, paddingRight: Spacing.md }}>
                    <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.text, letterSpacing: 1 }}>{v.code}</Text>
                    <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 }}>
                      {tzs(v.priceTZS)} · {t('vch.expiresAt', { end: fullTime(v.expiresAt) })}
                    </Text>
                  </View>
                  <Pill label={t(VOUCHER_META[v.status].label)} tone={VOUCHER_META[v.status].tone} />
                </Row>
              </Card>
            ))}
          </View>
        )}
      </View>

      <SheetModal visible={extendOpen} onClose={() => setExtendOpen(false)} title={t('gb.extendTitle')}>
        <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' }}>
          {t('gb.extendHint', { end: fullTime(deal.salesEndAt) })}
        </Text>
        <Row gap={8} style={{ flexWrap: 'wrap', justifyContent: 'center' }}>
          {EXTEND_CHOICES.map((d) => (
            <Pressable
              key={d}
              onPress={() => setExtendDays(d)}
              accessibilityRole="button"
              accessibilityLabel={t('gb.extendDays', { n: d })}
              style={[styles.chip, extendDays === d && styles.chipActive]}>
              <Text style={[styles.chipText, extendDays === d && { color: Colors.text, fontWeight: '700' }]}>
                {t('gb.extendDays', { n: d })}
              </Text>
            </Pressable>
          ))}
        </Row>
        <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'center' }}>
          {t('gb.newEnd', { end: fullTime(newEndsAt) })}
        </Text>
        <Btn label={t('gb.extend')} loading={busy} onPress={() => runAction(() => extendDeal(deal.id, newEndsAt))} />
      </SheetModal>

      <SheetModal visible={confirm !== null} onClose={() => setConfirm(null)} title={t(confirm === 'delist' ? 'gb.confirmDelist' : 'gb.confirmRelist')}>
        <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 18 }}>
          {t(confirm === 'delist' ? 'gb.confirmDelistSub' : 'gb.confirmRelistSub')}
        </Text>
        <Row gap={Spacing.md}>
          <Btn label={t('common.cancel')} variant="outline" style={{ flex: 1 }} onPress={() => setConfirm(null)} />
          <Btn
            label={t(confirm === 'delist' ? 'gb.delist' : 'gb.relist')}
            variant={confirm === 'delist' ? 'danger' : 'primary'}
            loading={busy}
            style={{ flex: 1 }}
            onPress={() => runAction(() => (confirm === 'delist' ? delistDeal(deal.id) : relistDeal(deal.id)))}
          />
        </Row>
      </SheetModal>
    </Screen>
  );
}

function STATUS_LABEL(status: GroupBuyDeal['status']): I18nKey {
  switch (status) {
    case 'draft':
      return 'gb.statusDraft';
    case 'pending_review':
      return 'gb.statusPendingReview';
    case 'live':
      return 'gb.statusLive';
    case 'extended':
      return 'gb.statusExtended';
    case 'delisted':
      return 'gb.statusDelisted';
    case 'rejected':
      return 'gb.statusRejected';
    default:
      return 'gb.statusEnded';
  }
}

function STATUS_TONE(status: GroupBuyDeal['status']): 'neutral' | 'info' | 'success' | 'danger' | 'warning' {
  switch (status) {
    case 'draft':
    case 'ended':
      return 'neutral';
    case 'pending_review':
      return 'info';
    case 'live':
    case 'extended':
      return 'success';
    case 'delisted':
      return 'warning';
    default:
      return 'danger';
  }
}

function InfoRow({ label, value, valueItalic }: { label: string; value: string; valueItalic?: boolean }) {
  return (
    <Row style={{ justifyContent: 'space-between' }}>
      <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary }}>{label}</Text>
      <Text
        numberOfLines={2}
        style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600', flex: 1, textAlign: 'right', paddingLeft: Spacing.md, fontStyle: valueItalic ? 'italic' : 'normal' }}>
        {value}
      </Text>
    </Row>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, flex: 1, paddingRight: Spacing.md },
  price: { fontSize: 26, fontWeight: '800', color: Colors.text, letterSpacing: 0.3 },
  priceOld: { fontSize: FontSize.sm, color: Colors.textTertiary, textDecorationLine: 'line-through' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border },
  section: { marginTop: Spacing.lg },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  chip: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primaryDark },
  chipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
});