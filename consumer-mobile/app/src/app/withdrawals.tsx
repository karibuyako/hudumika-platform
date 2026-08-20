/* Withdrawal history — GET /wallet/withdrawals (contract listWithdrawals).
 * Rows render the amount (formatTZS), fee, status pill (WithdrawalStatus
 * tones), date via dateISO, the payout method and the masked destination
 * (mock-only extension field — the mock masks server-side, same rule as
 * WalletPayoutDestination.maskedAccount, so the row renders it verbatim).
 * Loading/empty/error/retry mirror the other list screens (red-packets.tsx). */
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { Btn, Card, EmptyState, ErrorState, Row, Screen, SkeletonCard, StatusPill } from '@/components/ui';
import { Colors, Fonts, FontSize, NumberStyle, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { getWalletRepository } from '@/repos';
import type { WithdrawalRecord } from '@/repos';
import { dateISO } from '@/lib/dates';
import { formatTZS } from '@/lib/format';

/** Data-driven label: 'tigo_pesa' → 'Tigo Pesa' (contract enum values only). */
function prettyLabel(value: string): string {
  return value
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export default function WithdrawalsScreen() {
  const router = useRouter();
  const [withdrawals, setWithdrawals] = useState<WithdrawalRecord[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setWithdrawals(await getWalletRepository().listWithdrawals());
    } catch {
      setError(t('common.error'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Screen>
      <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg }}>
        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <Text style={styles.title}>{t('wallet.withdrawals')}</Text>
          <View style={{ width: 64 }} />
        </Row>
      </View>
      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !withdrawals ? (
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={2} />
          <SkeletonCard rows={2} />
        </View>
      ) : withdrawals.length === 0 ? (
        <EmptyState icon="cash-outline" title={t('wallet.withdrawEmpty')} />
      ) : (
        <FlatList
          data={withdrawals}
          keyExtractor={(w) => w.id}
          onRefresh={load}
          refreshing={false}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }}
          renderItem={({ item }) => (
            <Card style={styles.row} flat>
              <Row style={{ justifyContent: 'space-between' }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.amount}>{formatTZS(item.amountTZS)}</Text>
                  <Text style={styles.meta}>
                    {dateISO(item.createdAt)}
                    {item.method ? ` · ${prettyLabel(item.method)}` : ''}
                    {item.destination ? ` · ${item.destination}` : ''}
                    {item.feeTZS !== undefined && item.feeTZS > 0 ? ` · ${t('wallet.withdrawFee')} ${formatTZS(item.feeTZS)}` : ''}
                  </Text>
                </View>
                <StatusPill status={item.status} />
              </Row>
            </Card>
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text, flex: 1, textAlign: 'center' },
  row: { marginBottom: Spacing.md },
  amount: { fontSize: FontSize.lg, fontFamily: Fonts.displayBold, color: Colors.text, fontVariant: NumberStyle.fontVariant },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
});
