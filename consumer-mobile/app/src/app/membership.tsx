import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Btn, Card, EmptyState, ErrorState, Icon, Row, Screen, SheetModal, SkeletonCard } from '@/components/ui';
import { Colors, Fonts, FontSize, NumberStyle, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { getMembershipsRepository, getWalletRepository, REDEMPTION_CATALOG } from '@/repos';
import type { RedemptionReward } from '@/repos';
import { dateISO } from '@/lib/dates';
import { formatTZS } from '@/lib/format';
import { idempotencyKey } from '@/lib/idempotency';
import { nextBonusDay, streakDots, WEEKLY_STREAK_BONUS_POINTS } from '@/lib/streak';
import { useSessionStore } from '@/store/session';
import { toast } from '@/store/ui';
import type { CustomerMembership, DailyCheckIn200, ListLoyaltyTransactions200Item, Wallet } from '@hudumika/contract';
import { ListLoyaltyTransactions200ItemType } from '@hudumika/contract';
import { ApiError } from '@/api/client';
import * as Haptics from 'expo-haptics';

const DAY_MS = 86_400_000;
// C3 Membership fix verification: prettyLevel handles undefined, (membership?.points ?? 0).toLocaleString('en-US') and (membership?.points ??0) fallback, shortfall uses ??0 and ?? 0

/** Display name for a catalog reward (server keys are stable — the i18n
 * mapping is app-side, mirroring how statuses map to labels). */
function rewardName(reward: RedemptionReward): string {
  switch (reward.reward) {
    case 'wallet_credit':
      return t('membership.reward.walletCredit');
    case 'delivery_discount':
      return t('membership.reward.deliveryDiscount');
    case 'free_delivery':
      return t('membership.reward.freeDelivery');
    default:
      return reward.reward;
  }
}

function dayNumber(iso: string): number {
  const d = new Date(iso);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / DAY_MS);
}

/** Streak + today's check-in state, derived from the server-provided ledger
 * (the contract exposes no check-in status endpoint — the ledger is the
 * source of truth). A run counts backward over consecutive check_in days. */
function streakFromLedger(rows: ListLoyaltyTransactions200Item[]): { streakDays: number; checkedInToday: boolean } {
  const checkIns = rows.filter((r) => r.type === ListLoyaltyTransactions200ItemType.check_in);
  if (checkIns.length === 0) return { streakDays: 0, checkedInToday: false };
  const today = dayNumber(new Date().toISOString());
  const newest = dayNumber(checkIns[0].at);
  if (newest !== today && newest !== today - 1) return { streakDays: 0, checkedInToday: false };
  let streak = 1;
  let prev = newest;
  for (let i = 1; i < checkIns.length; i++) {
    const cur = dayNumber(checkIns[i].at);
    if (cur === prev - 1) {
      streak += 1;
      prev = cur;
    } else {
      break;
    }
  }
  return { streakDays: streak, checkedInToday: newest === today };
}

function typeLabel(type: string): string {
  switch (type) {
    case ListLoyaltyTransactions200ItemType.earn:
      return t('membership.ledger.earn');
    case ListLoyaltyTransactions200ItemType.redeem:
      return t('membership.ledger.redeem');
    case ListLoyaltyTransactions200ItemType.check_in:
      return t('membership.ledger.check_in');
    case ListLoyaltyTransactions200ItemType.bonus:
      return t('membership.ledger.bonus');
    case ListLoyaltyTransactions200ItemType.expire:
      return t('membership.ledger.expire');
    case ListLoyaltyTransactions200ItemType.adjust:
      return t('membership.ledger.adjust');
    default:
      return type;
  }
}

function prettyLevel(level: string | undefined): string {
  if (!level || typeof level !== 'string') return '';
  return level.charAt(0).toUpperCase() + level.slice(1);
}

function signedPoints(points: number): string {
  const sign = points >= 0 ? '+' : '−';
  return `${sign}${Math.abs(points).toLocaleString('en-US')}`;
}

export default function MembershipScreen() {
  const user = useSessionStore((s) => s.user);
  const [membership, setMembership] = useState<CustomerMembership | null>(null);
  const [transactions, setTransactions] = useState<ListLoyaltyTransactions200Item[] | null>(null);
  const [error, setError] = useState('');
  const [ledgerError, setLedgerError] = useState('');
  const [checkingIn, setCheckingIn] = useState(false);
  const [awarded, setAwarded] = useState<DailyCheckIn200 | null>(null);
  const [checkInMessage, setCheckInMessage] = useState('');
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [walletError, setWalletError] = useState('');
  const [confirmReward, setConfirmReward] = useState<RedemptionReward | null>(null);
  const [redeeming, setRedeeming] = useState(false);
  const [redeemError, setRedeemError] = useState('');

  const loadMembership = useCallback(async () => {
    setError('');
    try {
      setMembership(await getMembershipsRepository().get());
    } catch {
      setError(t('common.error'));
    }
  }, []);

  const loadLedger = useCallback(async () => {
    setLedgerError('');
    try {
      setTransactions(await getMembershipsRepository().listLoyaltyTransactions());
    } catch {
      setLedgerError(t('common.error'));
    }
  }, []);

  const loadWallet = useCallback(async () => {
    setWalletError('');
    try {
      setWallet(await getWalletRepository().getWallet());
    } catch {
      setWalletError(t('common.error'));
    }
  }, []);

  const load = useCallback(() => {
    loadMembership();
    loadLedger();
    loadWallet();
  }, [loadMembership, loadLedger, loadWallet]);

  useEffect(() => {
    load();
  }, [load]);

  const doCheckIn = async () => {
    setCheckingIn(true);
    setCheckInMessage('');
    try {
      const result = await getMembershipsRepository().checkIn(idempotencyKey(user?.id ?? 'customer', 'checkin'));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setAwarded(result);
      toast(t('membership.checkIn.awarded', { n: result.pointsEarned }));
      loadMembership();
      loadLedger();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setCheckInMessage(t('membership.checkIn.already'));
        // Server state wins — refresh so the checked-in row shows.
        loadMembership();
        loadLedger();
      } else {
        setCheckInMessage(t('common.error'));
      }
    } finally {
      setCheckingIn(false);
    }
  };

  const openRedeemSheet = (reward: RedemptionReward) => {
    setRedeemError('');
    setConfirmReward(reward);
  };

  const doRedeem = async () => {
    if (!confirmReward || redeeming) return;
    setRedeeming(true);
    setRedeemError('');
    try {
      const key = idempotencyKey(user?.id ?? 'customer', 'points-redeem');
      await getMembershipsRepository().redeemPoints(
        { points: confirmReward.points, reward: confirmReward.reward },
        key,
      );
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setConfirmReward(null);
      if (confirmReward.valueTZS !== null) {
        toast(t('membership.redeemed', { amount: formatTZS(confirmReward.valueTZS) }));
      } else {
        toast(t('membership.redeemedDone'));
      }
      loadMembership();
      loadLedger();
      loadWallet();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'MEMBER_INSUFFICIENT_BALANCE') {
        setRedeemError(t('membership.needMore', { n: confirmReward.points - (membership?.points ??0) }));
      } else {
        setRedeemError(e instanceof ApiError ? e.message : t('common.error'));
      }
    } finally {
      setRedeeming(false);
    }
  };

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (!membership) {
    return (
      <Screen>
        <SkeletonCard rows={3} />
      </Screen>
    );
  }

  const { streakDays, checkedInToday } = streakFromLedger(transactions ?? []);
  const checkingInNow = checkedInToday || checkingIn;

  return (
    <Screen scroll>
      <Text style={styles.title}>{t('membership.title')}</Text>
      <Card style={[styles.card, { backgroundColor: Colors.primaryDeep }]}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={{ color: Colors.gold, fontSize: FontSize.xs, fontFamily: Fonts.sansSemibold }}>{t('membership.level', { level: prettyLevel(membership?.level ?? '') })}</Text>
          <Text style={{ color: Colors.white, fontSize: FontSize.xs, fontFamily: Fonts.sans }}>
            {membership?.memberSince ? t('membership.since', { t: dateISO(membership.memberSince) }) : ''}
          </Text>
        </Row>
        <Text style={{ color: Colors.white, fontSize: 30, fontFamily: Fonts.displayBold, marginTop: Spacing.md, fontVariant: NumberStyle.fontVariant }}>
          {t('membership.points', { n: (membership?.points ??0).toLocaleString('en-US') })}
        </Text>
      </Card>

      <Card style={styles.card}>
        <Row gap={Spacing.md} style={{ alignItems: 'flex-start' }}>
          <Icon name="ribbon-outline" size={20} color={Colors.primaryDeep} />
          <View style={{ flex: 1 }}>
            <Text style={styles.checkInTitle}>{t('membership.howToEarn.title')}</Text>
            <Text style={styles.checkInSub}>{t('membership.howToEarn.body')}</Text>
            <Text style={styles.earnRuleLabel}>{t('membership.earnedOrders')}</Text>
            <Text style={styles.earnRule}>{t('membership.howToEarn.orders')}</Text>
            <Text style={styles.earnRuleLabel}>{t('membership.earnedReviews')}</Text>
            <Text style={styles.earnRule}>{t('membership.howToEarn.reviews')}</Text>
          </View>
        </Row>
      </Card>

      <Card style={styles.card}>
        <Row gap={Spacing.md}>
          <Icon name="calendar-outline" size={20} color={Colors.primaryDeep} />
          <View style={{ flex: 1 }}>
            <Text style={styles.checkInTitle}>{t('membership.checkIn.title')}</Text>
            <Text style={styles.checkInSub}>{t('membership.checkIn.sub')}</Text>
          </View>
          <Pill streak={streakDays} />
        </Row>
        <View style={styles.streakStrip}>
          <Row gap={6}>
            {streakDots(streakDays).map((filled, i) => (
              <View key={i} style={[styles.streakDot, filled && styles.streakDotFilled]} />
            ))}
          </Row>
          <Text style={styles.streakDayLabel}>{t('membership.streakDay', { n: streakDays })}</Text>
        </View>
        {streakDays > 0 ? (
          <Text style={styles.streakBonusHint}>
            {t('membership.streakBonus', { day: nextBonusDay(streakDays), n: WEEKLY_STREAK_BONUS_POINTS })}
          </Text>
        ) : null}
        {awarded ? (
          <View style={styles.awardBox}>
            <Text style={styles.awardText}>{t('membership.checkIn.awarded', { n: awarded.pointsEarned })}</Text>
            {awarded.bonusPoints ? <Text style={styles.awardText}>{t('membership.checkIn.bonus', { n: awarded.bonusPoints })}</Text> : null}
          </View>
        ) : null}
        {checkInMessage ? <Text style={styles.message}>{checkInMessage}</Text> : null}
        <Btn
          label={checkedInToday ? t('membership.checkIn.done') : t('membership.checkIn.button')}
          onPress={doCheckIn}
          disabled={checkingInNow}
          loading={checkingIn}
          size="lg"
          style={{ marginTop: Spacing.md }}
        />
      </Card>

      <Text style={styles.section}>{t('membership.redeem')}</Text>
      <Card style={styles.card}>
        {walletError ? (
          <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.sm }}>
            <Text style={styles.redeemWalletLine}>{walletError}</Text>
            <Btn label={t('common.retry')} variant="outline" size="sm" onPress={loadWallet} />
          </Row>
        ) : wallet ? (
          <Text style={styles.redeemWalletLine}>{t('membership.redeemWalletBalance', { amount: formatTZS(wallet.totalTZS) })}</Text>
        ) : (
          <Text style={styles.redeemWalletLine}>{t('common.loading')}</Text>
        )}
        {REDEMPTION_CATALOG.map((reward) => {
          const affordable = (membership?.points ??0) >= reward.points;
          const shortfall = reward.points - (membership?.points ??0);
          return (
            <Row key={reward.reward} style={[styles.rewardRow, !affordable && styles.rewardRowDisabled]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rewardName}>{rewardName(reward)}</Text>
                <Text style={styles.rewardMeta}>
                  {t('membership.pts', { n: reward.points })}
                  {reward.valueTZS !== null ? ` · ${formatTZS(reward.valueTZS)}` : ''}
                </Text>
              </View>
              <Btn
                label={affordable ? t('membership.redeemBtn') : t('membership.needMore', { n: shortfall })}
                variant={affordable ? 'primary' : 'subtle'}
                size="sm"
                disabled={!affordable}
                onPress={() => openRedeemSheet(reward)}
              />
            </Row>
          );
        })}
      </Card>

      <Text style={styles.section}>{t('membership.ledger')}</Text>
      {ledgerError ? (
        <ErrorState message={ledgerError} onRetry={loadLedger} />
      ) : !transactions ? (
        <SkeletonCard rows={3} />
      ) : transactions.length === 0 ? (
        <EmptyState icon="ribbon-outline" title={t('membership.ledger.empty')} />
      ) : (
        transactions.map((row) => (
          <Card key={row.id} style={styles.ledgerRow} flat>
            <Row style={{ justifyContent: 'space-between' }}>
              <View>
                <Text style={styles.ledgerType}>{typeLabel(row.type)}</Text>
                <Text style={styles.ledgerMeta}>
                  {dateISO(row.at)}
                  {row.reference ? ` · ${row.reference}` : ''}
                </Text>
              </View>
              <Text style={[styles.ledgerPoints, { color: row.points >= 0 ? Colors.success : Colors.text }]}>
                {t('membership.pts', { n: signedPoints(row.points) })}
              </Text>
            </Row>
          </Card>
        ))
      )}

      <Text style={styles.section}>{t('membership.benefits')}</Text>
      {(membership.benefits ?? []).length === 0 ? (
        <EmptyState icon="ribbon-outline" title={t('membership.benefits')} />
      ) : (
        membership.benefits!.map((benefit) => (
          <Card key={benefit} style={styles.benefit}>
            <Row gap={Spacing.md}>
              <View style={styles.icon}>
                <Icon name="checkmark" size={16} color={Colors.success} />
              </View>
              <Text style={{ fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansMedium, flex: 1 }}>{benefit}</Text>
            </Row>
          </Card>
        ))
      )}

      <SheetModal
        visible={confirmReward !== null}
        onClose={() => {
          if (!redeeming) setConfirmReward(null);
        }}
        title={confirmReward ? t('membership.redeemTitle', { reward: rewardName(confirmReward) }) : ''}>
        {confirmReward ? (
          <>
            <Text style={styles.redeemSheetLine}>{t('membership.redeemCost', { n: confirmReward.points })}</Text>
            <Text style={styles.redeemSheetLine}>{t('membership.redeemBalance', { n: (membership?.points ??0).toLocaleString('en-US') })}</Text>
            {confirmReward.valueTZS !== null ? (
              <Text style={styles.redeemSheetLine}>{t('membership.redeemWallet', { amount: formatTZS(confirmReward.valueTZS) })}</Text>
            ) : null}
            {redeemError ? <Text style={styles.message}>{redeemError}</Text> : null}
            <Row gap={Spacing.sm}>
              <Btn label={t('common.cancel')} variant="outline" style={{ flex: 1 }} onPress={() => setConfirmReward(null)} disabled={redeeming} />
              <Btn label={t('membership.redeemConfirm')} loading={redeeming} style={{ flex: 2 }} onPress={doRedeem} />
            </Row>
          </>
        ) : null}
      </SheetModal>
    </Screen>
  );
}

function Pill({ streak }: { streak: number }) {
  if (streak <= 0) return <Text style={styles.streakEmpty}>{t('membership.checkIn.streak', { n: 0 })}</Text>;
  return (
    <View style={styles.streakPill}>
      <Text style={styles.streakText}>{t('membership.checkIn.streak', { n: streak })}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text, marginBottom: Spacing.md },
  card: { marginBottom: Spacing.md, paddingVertical: Spacing.lg },
  section: { fontSize: FontSize.lg, fontFamily: Fonts.sansExtraBold, color: Colors.text, marginTop: Spacing.lg, marginBottom: Spacing.sm },
  benefit: { marginBottom: Spacing.sm, paddingVertical: Spacing.md },
  icon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.successSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkInTitle: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text },
  checkInSub: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  earnRuleLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontFamily: Fonts.sansBold, marginTop: Spacing.md },
  earnRule: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  streakPill: {
    backgroundColor: Colors.primarySoft,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
    borderRadius: Radius.pill,
  },
  streakText: { color: Colors.primaryDeep, fontSize: FontSize.xs, fontFamily: Fonts.sansBold },
  streakEmpty: { color: Colors.textFaint, fontSize: FontSize.xs, fontFamily: Fonts.sans },
  streakStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  streakDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: Colors.borderStrong,
  },
  streakDotFilled: { backgroundColor: Colors.primary },
  streakDayLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontFamily: Fonts.sansSemibold },
  streakBonusHint: { color: Colors.textTertiary, fontSize: FontSize.xs, fontFamily: Fonts.sans, marginTop: Spacing.sm },
  awardBox: { backgroundColor: Colors.successSoft, borderRadius: Radius.sm, padding: Spacing.sm, marginTop: Spacing.md, gap: 2 },
  awardText: { color: Colors.success, fontSize: FontSize.sm, fontFamily: Fonts.sansBold },
  message: { color: Colors.warning, fontSize: FontSize.xs, fontFamily: Fonts.sansSemibold, marginTop: Spacing.md },
  ledgerRow: { marginBottom: Spacing.sm, paddingVertical: Spacing.md },
  ledgerType: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansSemibold },
  ledgerMeta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  ledgerPoints: { fontSize: FontSize.md, fontFamily: Fonts.sansExtraBold, fontVariant: NumberStyle.fontVariant },
  redeemWalletLine: { fontSize: FontSize.xs, color: Colors.textSecondary, fontFamily: Fonts.sansMedium, marginBottom: Spacing.sm },
  rewardRow: {
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  rewardRowDisabled: { opacity: 0.6 },
  rewardName: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansSemibold },
  rewardMeta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  redeemSheetLine: { fontSize: FontSize.md, color: Colors.text, fontFamily: Fonts.sansMedium },
});
