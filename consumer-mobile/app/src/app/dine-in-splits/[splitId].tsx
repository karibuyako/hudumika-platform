/* Dine-in split summary (mock-first, docs/CONTRACT-ADDITIONS.md #25 —
 * DINE-IN.md marks split-bill PLANNED until the contract ships it).
 *
 * ONE bill, multiple diners: the initiator defines the shares in the split
 * sheet on the bill detail, confirms, and lands here. Each share row shows
 * label / amount / paid status; MY share carries "Mark my share paid" while
 * pending, and once every share is covered the split completes and the bill
 * settles (mock "webhook" — the full total is covered by the shares). Honest
 * scope note: the co-diner flow needs the app too — the mock simulates their
 * shares as PRE-PAID.
 *
 * Route param: the split is addressed by its ORDER id (one split per bill,
 * the api reads GET /dine-in/orders/{id}/splits), so [splitId] carries the
 * dine-in order id. Entry: bill detail → Split the bill → this screen; the
 * screen refetches on mount (404 renders "not found").
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { Btn, Card, Divider, ErrorState, Icon, MoneyText, Pill, Row, Screen, SkeletonCard } from '@/components/ui';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { idempotencyKey } from '@/lib/idempotency';
import { getDineInRepository } from '@/repos';
import { useSessionStore } from '@/store/session';
import { toast } from '@/store/ui';
import type { DineInSplit, DineInSplitStatus } from '@/repos';

const STATUS_TONE: Record<DineInSplitStatus, 'info' | 'success'> = {
  open: 'info',
  paid: 'success',
  completed: 'success',
};

export default function DineInSplitScreen() {
  const router = useRouter();
  const { splitId } = useLocalSearchParams<{ splitId: string }>();
  const user = useSessionStore((s) => s.user);

  const [split, setSplit] = useState<DineInSplit | null>(null);
  const [billRef, setBillRef] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [paying, setPaying] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const current = await getDineInRepository().getSplit(splitId);
      setSplit(current);
      // Bill ref is display-only — the split still renders without it.
      try {
        const order = await getDineInRepository().getOrder(current.dineInOrderId);
        setBillRef(t('dineIn.table', { table: order.tableId }));
      } catch {
        setBillRef(current.dineInOrderId);
      }
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? t('split.notFound') : t('common.error'));
    }
  }, [splitId]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const payMyShare = async () => {
    if (!split) return;
    setPaying(true);
    try {
      const updated = await getDineInRepository().payMyShare(
        split.dineInOrderId,
        idempotencyKey(user?.id ?? 'cus_1', 'dine-in.split-pay'),
      );
      setSplit(updated);
      toast(t('dineIn.splitPaid'));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFLICT') load();
      else toast(e instanceof ApiError ? e.message : t('common.error'), 'error');
    } finally {
      setPaying(false);
    }
  };

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (!split) {
    return (
      <Screen>
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  const mine = split.shares.find((s) => s.id === split.myShareId);

  return (
    <Screen scroll>
      <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
        <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
        <Text style={styles.title} numberOfLines={1}>{t('dineIn.splitTitle')}</Text>
        <Pill
          label={split.status === 'completed' ? t('dineIn.splitCompleted') : split.status === 'paid' ? t('dineIn.splitPaid') : t('split.open')}
          tone={STATUS_TONE[split.status]}
        />
      </Row>

      <Card style={{ gap: Spacing.md }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.meta}>{t('dineIn.billTitle')}</Text>
          <Text style={styles.value} numberOfLines={1}>{billRef ?? split.dineInOrderId}</Text>
        </Row>
        <Divider />
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.meta}>{t('breakdown.total')}</Text>
          <MoneyText amountTZS={split.totalTZS} size={FontSize.lg} bold />
        </Row>
      </Card>

      <Text style={styles.sectionLabel}>{t('split.shares')}</Text>
      {split.shares.map((share) => {
        const isMine = share.id === split.myShareId;
        return (
          <Card key={share.id} style={{ marginBottom: Spacing.md, gap: Spacing.sm }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <View style={{ flex: 1 }}>
                <Row gap={Spacing.xs}>
                  <Text style={styles.name} numberOfLines={1}>{share.label}</Text>
                  {isMine ? <Text style={[styles.meta, { color: Colors.primaryDeep }]}>{t('dineIn.splitMyShare')}</Text> : null}
                </Row>
              </View>
              <MoneyText amountTZS={share.amountTZS} size={FontSize.sm} bold />
            </Row>
            <Row style={{ justifyContent: 'space-between' }}>
              <Pill label={share.status === 'paid' ? t('dineIn.splitPaid') : t('split.pending')} tone={share.status === 'paid' ? 'success' : 'neutral'} />
            </Row>
          </Card>
        );
      })}

      {mine?.status === 'pending' ? (
        <Card style={{ marginBottom: Spacing.md, gap: Spacing.md }}>
          <Text style={styles.sectionLabel}>{t('dineIn.splitMyShare')}</Text>
          <Btn label={t('dineIn.splitMarkPaid')} onPress={payMyShare} size="lg" loading={paying} />
        </Card>
      ) : null}

      {split.status === 'completed' ? (
        <Card style={{ marginBottom: Spacing.md, backgroundColor: Colors.successSoft }}>
          <Row gap={Spacing.md}>
            <Icon name="checkmark-circle-outline" size={18} color={Colors.success} />
            <Text style={{ color: Colors.success, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, flex: 1 }}>
              {t('dineIn.splitCompleted')}
            </Text>
          </Row>
        </Card>
      ) : null}

      <Card style={{ marginBottom: Spacing.md }}>
        <Row gap={Spacing.md}>
          <Icon name="information-circle-outline" size={18} color={Colors.textTertiary} />
          <Text style={styles.note}>{t('dineIn.splitCopayerNote')}</Text>
        </Row>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text, flex: 1, textAlign: 'center' },
  name: { fontSize: FontSize.md, fontFamily: Fonts.sansBold, color: Colors.text },
  value: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansMedium },
  meta: { fontSize: FontSize.xs, color: Colors.textSecondary, fontFamily: Fonts.sans },
  note: { fontSize: FontSize.xs, color: Colors.textSecondary, fontFamily: Fonts.sans, flex: 1, lineHeight: 16 },
  sectionLabel: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sansSemibold, marginVertical: Spacing.sm },
});
