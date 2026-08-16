import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Empty, Icon, Pill, Row } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';
import { fullTime } from '@/lib/format';
import { ApiError } from '@/api/client';
import type { ReceiptRowDto } from '@/api/types';
import { useOrderStore } from '@/store/orders';

/* Contract receipt reprint list (GET /orders/receipts → [{orderId, printedAt,
 * jobId}]). Reprinting routes through POST /print-jobs (jobType: receipt) —
 * the sweeper advances the job and records the fresh row. */
export default function ReceiptsScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const orders = useOrderStore((s) => s.orders);
  const fetchReceiptRows = useOrderStore((s) => s.fetchReceiptRows);
  const reprintReceipt = useOrderStore((s) => s.reprintReceipt);
  const [rows, setRows] = useState<ReceiptRowDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [queuedId, setQueuedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetchReceiptRows();
      setRows(r);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoaded(true);
    }
  }, [fetchReceiptRows]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const reprint = async (row: ReceiptRowDto) => {
    setBusyId(row.orderId);
    setJobError(null);
    setQueuedId(null);
    try {
      await reprintReceipt(row.orderId);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setQueuedId(row.orderId);
      setTimeout(load, 600);
    } catch (e) {
      setJobError(e instanceof ApiError ? e.message : t('orders.reprintFailed'));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setBusyId(null);
    }
  };

  const noOf = (orderId: string) => orders.find((o) => o.id === orderId)?.no ?? rows.find((r) => r.orderId === orderId)?.no ?? orderId;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ title: t('orders.receipts') }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('common.back')}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('orders.receipts')}</Text>
        <View style={{ width: 26 }} />
      </View>

      {jobError ? (
        <View style={styles.errorBanner}>
          <Icon name="alert-circle-outline" size={16} color={Colors.danger} />
          <Text style={styles.errorText}>{jobError}</Text>
        </View>
      ) : null}

      <FlatList
        data={rows}
        keyExtractor={(r) => `${r.orderId}:${r.jobId}`}
        contentContainerStyle={{ padding: Spacing.lg, gap: Spacing.md, paddingBottom: 60 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load().finally(() => setRefreshing(false)); }} tintColor={Colors.primary} />}
        ListEmptyComponent={
          !loaded ? (
            <View style={styles.center}>
              <ActivityIndicator color={Colors.primary} />
            </View>
          ) : error ? (
            <View style={styles.center}>
              <Icon name="cloud-offline-outline" size={26} color={Colors.textTertiary} />
              <Text style={{ color: Colors.textSecondary, fontSize: FontSize.sm, fontWeight: '600', marginTop: Spacing.sm }}>
                {t('orders.receiptsLoadFailed')}
              </Text>
              <Btn label={t('common.retry')} size="sm" variant="outline" style={{ marginTop: Spacing.md }} onPress={() => { setLoaded(false); load(); }} />
            </View>
          ) : (
            <Empty icon="receipt-outline" title={t('orders.receiptsEmpty')} />
          )
        }
        renderItem={({ item }) => (
          <Card>
            <Row style={{ justifyContent: 'space-between' }}>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.text }}>{noOf(item.orderId)}</Text>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('orders.receiptRow', { no: noOf(item.orderId), job: item.jobId })}</Text>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary }}>{fullTime(item.printedAt)}</Text>
              </View>
              {queuedId === item.orderId ? (
                <Pill label={t('orders.reprintQueued')} tone="success" />
              ) : (
                <Btn label={t('orders.reprint')} icon="print-outline" variant="outline" size="sm" loading={busyId === item.orderId} onPress={() => reprint(item)} />
              )}
            </Row>
          </Card>
        )}
      />
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
  center: { alignItems: 'center', paddingVertical: Spacing.xxl * 1.5, gap: 2 },
  errorBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, marginHorizontal: Spacing.lg, marginTop: Spacing.sm, borderRadius: Radius.md, backgroundColor: `${Colors.danger}14`, borderWidth: 1, borderColor: `${Colors.danger}40` },
  errorText: { flex: 1, fontSize: FontSize.xs, color: Colors.danger, fontWeight: '600' },
});
