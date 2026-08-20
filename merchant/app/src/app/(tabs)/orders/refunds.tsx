import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';

import { Btn, Card, Chip, Empty, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { clock, tzs } from '@/lib/format';
import { ApiError } from '@/api/client';
import type { RefundRequestDto } from '@/api/types';
import { useRefundStore } from '@/store/refunds';

type RefundFilter = 'all' | RefundRequestDto['status'];

const FILTERS: { key: RefundFilter; label: I18nKey; tone: 'neutral' | 'success' | 'danger' | 'info' }[] = [
  { key: 'all', label: 'rf.all', tone: 'neutral' },
  { key: 'pending', label: 'rf.pending', tone: 'info' },
  { key: 'approved', label: 'rf.approved', tone: 'success' },
  { key: 'rejected', label: 'rf.rejected', tone: 'danger' },
];

const PILL_TONE: Record<RefundRequestDto['status'], 'warning' | 'success' | 'danger'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
};

export default function RefundsScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const refunds = useRefundStore((s) => s.refunds);
  const loaded = useRefundStore((s) => s.loaded);
  const hydrate = useRefundStore((s) => s.hydrate);
  const approveRefund = useRefundStore((s) => s.approveRefund);
  const rejectRefund = useRefundStore((s) => s.rejectRefund);
  const [filter, setFilter] = useState<RefundFilter>('all');
  const [decide, setDecide] = useState<null | { action: 'approve' | 'reject'; refund: RefundRequestDto }>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    hydrate(filter === 'all' ? undefined : filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const onRefresh = () => {
    setRefreshing(true);
    hydrate(filter === 'all' ? undefined : filter);
    setTimeout(() => setRefreshing(false), 600);
  };

  const runDecision = useCallback(async () => {
    if (!decide) return;
    setBusy(true);
    setConflict(null);
    try {
      if (decide.action === 'approve') await approveRefund(decide.refund.id, reason.trim());
      else await rejectRefund(decide.refund.id, reason.trim());
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDecide(null);
      setReason('');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'REFUND_ALREADY_DECIDED') {
        setConflict(t('od.conflictBanner'));
        setDecide(null);
        setReason('');
        hydrate();
      } else if (e instanceof ApiError) {
        setConflict(e.message);
      }
    } finally {
      setBusy(false);
    }
  }, [decide, reason, approveRefund, rejectRefund, hydrate]);

  const list = filter === 'all' ? refunds : refunds.filter((r) => r.status === filter);

  return (
    <Screen>
      <Row gap={Spacing.sm} style={{ paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md }}>
        {FILTERS.map((f) => (
          <Chip key={f.key} label={t(f.label)} selected={filter === f.key} onPress={() => setFilter(f.key)} tone={f.tone} />
        ))}
      </Row>

      {/* Honest UI: partial amounts planned but not in contract — amount field absent, reason only (≤500). */}
      <View style={styles.honestyBanner}>
        <Icon name="information-circle-outline" size={16} color={Colors.warning} />
        <Text style={styles.honestyText}>{t('rf.partialBanner')}</Text>
      </View>
      <Text style={styles.honestySub}>{t('rf.partialDetail')}</Text>

      {conflict ? (
        <View style={styles.banner}>
          <Icon name="alert-circle-outline" size={16} color={Colors.danger} />
          <Text style={styles.bannerText}>{conflict}</Text>
        </View>
      ) : null}

      <FlatList
        data={list}
        keyExtractor={(r) => r.id}
        contentContainerStyle={{ padding: Spacing.lg, paddingTop: 4, paddingBottom: 120, gap: Spacing.md }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        ListEmptyComponent={
          !loaded ? (
            <View style={styles.loadFailed}>
              <Icon name="cloud-offline-outline" size={26} color={Colors.textTertiary} />
              <Text style={{ color: Colors.textSecondary, fontSize: FontSize.sm, fontWeight: '600', marginTop: Spacing.sm }}>{t('orders.loadFailed')}</Text>
              <Btn label={t('common.retry')} size="sm" variant="outline" style={{ marginTop: Spacing.md }} onPress={() => hydrate()} />
            </View>
          ) : (
            <Empty icon="return-down-back-outline" title={t('rf.empty')} />
          )
        }
        renderItem={({ item }) => (
          <Card style={styles.card}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.no}>{tzs(item.amountTZS)}</Text>
              <Pill label={t(`rf.${item.status}` as I18nKey).toUpperCase()} tone={PILL_TONE[item.status]} />
            </Row>
            <Text style={styles.meta}>{t('rf.requestedBy', { amount: tzs(item.amountTZS), customer: item.customerName ?? '—' })}</Text>
            <Text style={styles.reason}>“{item.reason}”</Text>
            {item.decisionReason ? <Text style={styles.decision}>{t('rf.decision', { r: item.decisionReason })}</Text> : null}
            <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 4 }}>
              <Text style={styles.meta}>{t('rf.decided', { t: clock(item.createdAt) })}</Text>
              {item.status === 'pending' ? (
                <Row style={{ gap: 10 }}>
                  <Btn label={t('rf.approve')} variant="success" size="sm" style={{ flex: 1 }} onPress={() => setDecide({ action: 'approve', refund: item })} />
                  <Btn label={t('rf.reject')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => setDecide({ action: 'reject', refund: item })} />
                </Row>
              ) : null}
            </Row>
          </Card>
        )}
      />

      <SheetModal visible={!!decide} onClose={() => !busy && setDecide(null)} title={decide ? t(decide.action === 'approve' ? 'rf.approveTitle' : 'rf.rejectTitle', { amount: tzs(decide.refund.amountTZS) }) : undefined}>
        <View style={{ gap: Spacing.sm }}>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder={t('rf.reasonPh')}
            placeholderTextColor={Colors.textTertiary}
            maxLength={500}
            style={styles.input}
          />
          <Btn label={t('rf.confirm')} variant={decide?.action === 'approve' ? 'success' : 'danger'} onPress={runDecision} loading={busy} size="lg" />
          <Text style={styles.hint}>{decide?.action === 'approve' ? t('rf.approveHint') : t('rf.rejectHint')}</Text>
        </View>
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  loadFailed: { alignItems: 'center', paddingVertical: Spacing.xxl * 1.5, gap: 2 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: Spacing.lg, padding: 10, borderRadius: Radius.md, backgroundColor: `${Colors.danger}14`, borderWidth: 1, borderColor: `${Colors.danger}40` },
  bannerText: { flex: 1, fontSize: FontSize.xs, color: Colors.danger, fontWeight: '600' },
  honestyBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: Spacing.lg,
    marginBottom: 4,
    padding: 10,
    borderRadius: Radius.md,
    backgroundColor: Colors.warningSoft,
    borderWidth: 1,
    borderColor: `${Colors.warning}55`,
  },
  honestyText: { flex: 1, fontSize: FontSize.xs, color: Colors.warning, fontWeight: '700' },
  honestySub: { marginHorizontal: Spacing.lg, marginBottom: Spacing.sm, fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'left' },
  card: { gap: 8, paddingVertical: 14 },
  no: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary },
  reason: { fontSize: FontSize.sm, color: Colors.textSecondary, fontStyle: 'italic' },
  decision: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: Colors.borderStrong, borderRadius: Radius.md, paddingHorizontal: Spacing.md, paddingVertical: 12, fontSize: FontSize.md, color: Colors.text },
  hint: { fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'center' },
});
