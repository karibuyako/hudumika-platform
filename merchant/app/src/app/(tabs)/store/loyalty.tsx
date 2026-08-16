import { Stack, router } from 'expo-router';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Empty, Icon, Pill, Row, Screen } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import type { LoyaltyTransactionType } from '@/api/types';
import { tzs } from '@/lib/format';
import { useLoyaltyStore } from '@/store/loyalty';

const TX_LABEL: Record<LoyaltyTransactionType, I18nKey> = {
  earn: 'loy.txEarn',
  redeem: 'loy.txRedeem',
  check_in: 'loy.txCheckIn',
  bonus: 'loy.txBonus',
  expire: 'loy.txExpire',
  adjust: 'loy.txAdjust',
};

export default function LoyaltyScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const members = useLoyaltyStore((s) => s.members);
  const error = useLoyaltyStore((s) => s.error);
  const hydrateMembers = useLoyaltyStore((s) => s.hydrateMembers);
  const loyaltyTransactions = useLoyaltyStore((s) => s.loyaltyTransactions);
  const myMembership = useLoyaltyStore((s) => s.myMembership);
  const hydrateLoyaltyTransactions = useLoyaltyStore((s) => s.hydrateLoyaltyTransactions);
  const hydrateMyMembership = useLoyaltyStore((s) => s.hydrateMyMembership);
  const [query, setQuery] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback(
    (q: string) => {
      setQuery(q);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => hydrateMembers(q.trim() || undefined), 300);
    },
    [hydrateMembers],
  );

  useEffect(() => {
    hydrateMembers();
    hydrateLoyaltyTransactions();
    hydrateMyMembership();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [hydrateMembers, hydrateLoyaltyTransactions, hydrateMyMembership]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('loy.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <View style={{ gap: Spacing.md }}>
          <View style={styles.searchBox}>
            <Icon name="search-outline" size={16} color={Colors.textTertiary} />
            <TextInput
              value={query}
              onChangeText={search}
              placeholder={t('loy.searchPh')}
              placeholderTextColor={Colors.textTertiary}
              style={styles.searchInput}
              accessibilityLabel={t('loy.search')}
            />
          </View>

          <Row style={{ justifyContent: 'space-between' }}>
            <Btn label={t('loy.add')} icon="person-add-outline" size="sm" onPress={() => router.push('/store/member/new')} />
            <Btn label={t('loy.tiersManage')} icon="medal-outline" variant="ghost" size="sm" onPress={() => router.push('/store/tiers')} />
          </Row>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          {members.length === 0 && !error ? <Empty icon="people-outline" title={t('loy.empty')} sub={t('loy.emptySub')} /> : null}

          <View style={{ gap: Spacing.md }}>
            {members.map((m) => (
              <Card key={m.id} style={{ gap: Spacing.sm }} onPress={() => router.push(`/store/member/${m.id}`)} accessibilityLabel={m.name}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.name} numberOfLines={1}>{m.name}</Text>
                    <Text style={styles.meta}>{m.maskedPhone} · {t('loy.registered', { date: new Date(m.joinedAt).toLocaleDateString() })}</Text>
                  </View>
                  {m.tierName ? <Pill label={m.tierName} tone="info" /> : null}
                </Row>
                <Row style={{ justifyContent: 'space-between' }}>
                  <View>
                    <Text style={styles.label}>{t('loy.balance')}</Text>
                    <Text style={styles.balance}>{tzs(m.balanceTZS)}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={styles.label}>{t('loy.spend')}</Text>
                    <Text style={styles.spend}>{tzs(m.totalSpendTZS)}</Text>
                  </View>
                </Row>
              </Card>
            ))}
          </View>

          {/* Customer membership (mock-only view of GET /memberships/me) */}
          {myMembership ? (
            <>
              <Text style={styles.sectionLabel}>{t('loy.myMembership')}</Text>
              <Card style={{ gap: Spacing.sm, backgroundColor: Colors.primarySoft }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={styles.name}>{t('loy.memberLevel', { level: myMembership.level })}</Text>
                  <Pill label={t('loy.memberPoints', { n: String(myMembership.points) })} tone="success" />
                </Row>
                <Text style={styles.meta}>
                  {myMembership.memberSince ? t('loy.memberSince', { date: myMembership.memberSince }) : ''}
                </Text>
                {myMembership.benefits.length ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {myMembership.benefits.map((b) => (
                      <Pill key={b} label={b} tone="neutral" />
                    ))}
                  </View>
                ) : null}
              </Card>
            </>
          ) : null}

          {/* Loyalty points ledger (contract GET /loyalty-transactions) */}
          <Text style={styles.sectionLabel}>{t('loy.transactions')}</Text>
          {loyaltyTransactions.length === 0 ? <Empty icon="swap-vertical-outline" title={t('loy.txEmpty')} /> : null}
          <View style={{ gap: Spacing.sm }}>
            {loyaltyTransactions.map((tx) => (
              <Card key={tx.id} style={{ gap: 2 }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Row gap={8} style={{ flex: 1 }}>
                    <Pill label={t(TX_LABEL[tx.type])} tone={tx.points >= 0 ? 'success' : 'danger'} />
                    <Text style={styles.meta} numberOfLines={1}>{tx.reference ?? ''}</Text>
                  </Row>
                  <Text style={[styles.points, { color: tx.points >= 0 ? Colors.success : Colors.danger }]}>
                    {tx.points >= 0 ? '+' : ''}{tx.points} · {t('loy.memberPoints', { n: String(tx.balance) })}
                  </Text>
                </Row>
                <Text style={styles.meta}>{new Date(tx.at).toLocaleDateString()} {new Date(tx.at).toLocaleTimeString()}</Text>
              </Card>
            ))}
          </View>
        </View>
      </Screen>
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
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.md,
    backgroundColor: Colors.card,
  },
  searchInput: { flex: 1, fontSize: FontSize.sm, color: Colors.text, paddingVertical: 10 },
  error: { color: Colors.danger, fontSize: FontSize.xs },
  name: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary },
  label: { fontSize: FontSize.xs, color: Colors.textTertiary },
  balance: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.success },
  spend: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.textSecondary },
  sectionLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '700', letterSpacing: 0.5, marginTop: Spacing.md },
  points: { fontSize: FontSize.sm, fontWeight: '800' },
});