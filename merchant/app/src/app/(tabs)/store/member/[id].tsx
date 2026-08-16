import { Stack, router, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Chip, Empty, Field, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import type { TopUpPaymentMethod } from '@/api/types';
import { tzs } from '@/lib/format';
import { useLoyaltyStore } from '@/store/loyalty';

const PAYMENT_LABEL: Record<TopUpPaymentMethod, I18nKey> = {
  mpesa: 'acc.mpesa',
  tigo_pesa: 'acc.tigoPesa',
  airtel_money: 'acc.airtelMoney',
  card: 'acc.bankCard',
  cash: 'loy.cash',
};
const PAYMENT_METHODS: TopUpPaymentMethod[] = ['mpesa', 'tigo_pesa', 'airtel_money', 'card', 'cash'];

function pct(bps: number): string {
  return (bps / 100).toFixed(bps % 100 ? 1 : 0);
}

export default function MemberDetailScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const { id } = useLocalSearchParams<{ id: string }>();
  const member = useLoyaltyStore((s) => s.member);
  const tiers = useLoyaltyStore((s) => s.tiers);
  const error = useLoyaltyStore((s) => s.error);
  const hydrateMember = useLoyaltyStore((s) => s.hydrateMember);
  const hydrateTiers = useLoyaltyStore((s) => s.hydrateTiers);
  const topUp = useLoyaltyStore((s) => s.topUp);
  const redeem = useLoyaltyStore((s) => s.redeem);
  const updateMember = useLoyaltyStore((s) => s.updateMember);

  const [sheet, setSheet] = useState<null | 'topup' | 'edit' | 'redeem'>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<TopUpPaymentMethod>('mpesa');
  const [lastCredit, setLastCredit] = useState<string | null>(null);
  const [lastRedeem, setLastRedeem] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editBirthday, setEditBirthday] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (id) {
      hydrateMember(id);
      hydrateTiers();
    }
  }, [id, hydrateMember, hydrateTiers]);

  const m = member && member.id === id ? member : null;
  const tier = m?.tier ?? null;
  const sorted = [...tiers].sort((a, b) => a.thresholdTZS - b.thresholdTZS);
  const next = sorted.find((t2) => m && t2.thresholdTZS > m.totalSpendTZS && t2.id !== m.tierId);

  const credit = async () => {
    const value = Number(amount);
    if (!Number.isInteger(value) || value <= 0 || !m) return;
    setBusy(true);
    const result = await topUp(m.id, value, method);
    setBusy(false);
    if (result) {
      setLastCredit(t('loy.creditResult', { amount: tzs(result.amountTZS), bonus: tzs(result.bonusTZS), total: tzs(result.totalTZS) }));
      setSheet(null);
      setAmount('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  const save = async () => {
    if (!m) return;
    setBusy(true);
    const updated = await updateMember(m.id, {
      name: editName.trim() || undefined,
      phone: editPhone.trim() || undefined,
      birthday: editBirthday.trim() || undefined,
    });
    setBusy(false);
    if (updated) {
      setSheet(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  const doRedeem = async () => {
    const value = Number(amount);
    if (!Number.isInteger(value) || value <= 0 || !m) return;
    setBusy(true);
    const res = await redeem(m.id, value);
    setBusy(false);
    if (res.member) {
      setLastRedeem(t('loy.redeemResult', { amount: tzs(value), balance: tzs(res.member.balanceTZS) }));
      setSheet(null);
      setAmount('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else if (res.code === 'MEMBER_INSUFFICIENT_BALANCE') {
      /* cashier banner: the sheet stays open with the insufficient-balance notice */
      setLastRedeem(null);
    }
  };

  if (!m) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.topBar}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Icon name="chevron-back" size={26} color={Colors.text} />
          </Pressable>
          <Text style={styles.topTitle}>{t('loy.member')}</Text>
          <View style={{ width: 26 }} />
        </View>
        <Screen scroll>
          <Empty icon="person-outline" title={t('loy.empty')} sub={error ?? undefined} />
        </Screen>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle} numberOfLines={1}>{m.name}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <View style={{ gap: Spacing.md }}>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {lastCredit ? <Text style={styles.credit}>{lastCredit}</Text> : null}
          {lastRedeem ? <Text style={styles.credit}>{lastRedeem}</Text> : null}

          <Card style={{ gap: Spacing.md, backgroundColor: Colors.black }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.bigLabel}>{t('loy.balance')}</Text>
              {tier ? <Pill label={tier.name} tone="info" /> : null}
            </Row>
            <Text style={styles.bigValue}>{tzs(m.balanceTZS)}</Text>
            <Text style={styles.bigSub}>{t('loy.spend')}: {tzs(m.totalSpendTZS)}</Text>
            {next ? (
              <Text style={styles.bigSub}>{t('loy.toNextTier', { n: (next.thresholdTZS - m.totalSpendTZS).toLocaleString('en-US'), tier: next.name })}</Text>
            ) : (
              <Text style={styles.bigSub}>{t('loy.topTier')}</Text>
            )}
          </Card>

          {tier ? (
            <Card style={{ gap: Spacing.sm }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={styles.fieldLabel}>{t('loy.bonus')}</Text>
                <Text style={styles.bonusRate}>{pct(tier.bonusRateBps)}%</Text>
              </Row>
              <Text style={styles.meta}>{t('loy.topUpSub', { threshold: tier.thresholdTZS.toLocaleString('en-US'), rate: pct(tier.bonusRateBps) })}</Text>
              {tier.discountBps !== undefined ? (
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={styles.fieldLabel}>{t('loy.discount')}</Text>
                  <Text style={{ fontSize: FontSize.lg, fontWeight: '800', color: Colors.success }}>{pct(tier.discountBps)}%</Text>
                </Row>
              ) : null}
              {tier.benefits.length ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {tier.benefits.map((b) => (
                    <Pill key={b} label={b} tone="neutral" />
                  ))}
                </View>
              ) : null}
            </Card>
          ) : null}

          <Card style={{ gap: Spacing.xs }}>
            <Text style={styles.meta}>{m.maskedPhone}</Text>
            {m.birthday ? <Text style={styles.meta}>{t('loy.birthday')}: {m.birthday}</Text> : null}
            <Text style={styles.meta}>{t('loy.registered', { date: new Date(m.joinedAt).toLocaleDateString() })}</Text>
          </Card>

          <Row gap={Spacing.sm}>
            <Btn label={t('loy.topUp')} icon="add-circle-outline" size="sm" style={{ flex: 1 }} onPress={() => { setAmount(''); setMethod('mpesa'); setLastCredit(null); setSheet('topup'); }} />
            <Btn label={t('loy.redeem')} icon="card-outline" variant="outline" size="sm" style={{ flex: 1 }} onPress={() => { setAmount(''); setLastRedeem(null); setSheet('redeem'); }} />
            <Btn
              label={t('loy.edit')}
              icon="create-outline"
              variant="outline"
              size="sm"
              style={{ flex: 1 }}
              onPress={() => {
                setEditName(m.name);
                setEditPhone(m.phone ?? '');
                setEditBirthday(m.birthday ?? '');
                setSheet('edit');
              }}
            />
          </Row>
        </View>
      </Screen>

      <SheetModal visible={sheet === 'topup'} onClose={() => setSheet(null)} title={t('loy.topUpTitle')}>
        <View style={{ gap: Spacing.md }}>
          <Field label={t('loy.amount')} value={amount} onChangeText={setAmount} placeholder={t('loy.amountPh')} keyboardType="number-pad" maxLength={9} />
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('loy.method')}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {PAYMENT_METHODS.map((p) => (
                <Chip key={p} label={t(PAYMENT_LABEL[p])} selected={method === p} onPress={() => setMethod(p)} />
              ))}
            </View>
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Btn label={t('loy.credit')} size="lg" loading={busy} disabled={!amount.trim()} onPress={credit} />
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'redeem'} onClose={() => setSheet(null)} title={t('loy.redeemTitle')}>
        <View style={{ gap: Spacing.md }}>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 17 }}>
            {t('loy.redeemHint', { amount: tzs(m.balanceTZS) })}
          </Text>
          <Field label={t('loy.redeemAmount')} value={amount} onChangeText={setAmount} placeholder={t('loy.amountPh')} keyboardType="number-pad" maxLength={9} />
          {error ? (
            <Card style={{ backgroundColor: Colors.dangerSoft }}>
              <Row gap={Spacing.sm}>
                <Icon name="alert-circle-outline" size={18} color={Colors.danger} />
                <Text style={{ fontSize: FontSize.sm, color: Colors.danger, fontWeight: '600', flex: 1 }}>
                  {t('loy.insufficient', { balance: tzs(m.balanceTZS), amount: amount || '0' })}
                </Text>
              </Row>
            </Card>
          ) : null}
          <Btn label={t('loy.redeem')} size="lg" loading={busy} disabled={!amount.trim()} onPress={doRedeem} />
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'edit'} onClose={() => setSheet(null)} title={t('loy.editTitle')}>
        <View style={{ gap: Spacing.md }}>
          <Field label={t('loy.name')} value={editName} onChangeText={setEditName} maxLength={120} />
          <Field label={t('loy.phone')} value={editPhone} onChangeText={setEditPhone} keyboardType="phone-pad" maxLength={16} />
          <Field label={t('loy.birthday')} value={editBirthday} onChangeText={setEditBirthday} placeholder="YYYY-MM-DD" maxLength={10} />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Btn label={t('loy.save')} size="lg" loading={busy} disabled={!editName.trim()} onPress={save} />
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
  topTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, flex: 1, marginHorizontal: Spacing.sm },
  error: { color: Colors.danger, fontSize: FontSize.xs },
  credit: { color: Colors.success, fontSize: FontSize.xs, fontWeight: '700' },
  bigLabel: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.white },
  bigValue: { fontSize: FontSize.xxl, fontWeight: '800', color: Colors.primary },
  bigSub: { fontSize: FontSize.xs, color: 'rgba(255,255,255,0.6)' },
  fieldLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  bonusRate: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.success },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 17 },
});