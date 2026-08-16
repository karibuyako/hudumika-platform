import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { api } from '@/api/client';
import type { GroupBuyDeal, GroupBuyStatus } from '@/api/types';
import { Btn, Card, Empty, Icon, Pill, Row, Screen } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { dayLabel, tzs } from '@/lib/format';

const STATUS_META: Record<GroupBuyStatus, { label: I18nKey; tone: 'neutral' | 'info' | 'success' | 'danger' | 'warning' }> = {
  draft: { label: 'gb.statusDraft', tone: 'neutral' },
  pending_review: { label: 'gb.statusPendingReview', tone: 'info' },
  live: { label: 'gb.statusLive', tone: 'success' },
  extended: { label: 'gb.statusExtended', tone: 'success' },
  delisted: { label: 'gb.statusDelisted', tone: 'warning' },
  ended: { label: 'gb.statusEnded', tone: 'neutral' },
  rejected: { label: 'gb.statusRejected', tone: 'danger' },
};

export default function DealsScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const [deals, setDeals] = useState<GroupBuyDeal[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(() => {
    let cancelled = false;
    api
      .get<{ deals: GroupBuyDeal[] }>('/group-buys', { retries: 1 })
      .then((r) => {
        if (!cancelled) {
          setDeals(r.deals);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  useEffect(load, [load]);
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  return (
    <Screen scroll>
      <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.sm }}>
        <Text style={styles.subtitle}>{t('gb.listSub')}</Text>
        <Btn label={t('gb.newDeal')} icon="add" size="sm" onPress={() => router.push('/marketing/deal/new')} />
      </Row>

      {failed ? (
        <Card style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.xl }}>
          <Icon name="cloud-offline-outline" size={22} color={Colors.textTertiary} />
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('gb.errLoad')}</Text>
          <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => setAttempt((n) => n + 1)} />
        </Card>
      ) : deals === null ? (
        <Card style={{ alignItems: 'center', paddingVertical: Spacing.xl }}>
          <Icon name="time-outline" size={22} color={Colors.textTertiary} />
          <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary, marginTop: Spacing.sm }}>{t('mkt.loading')}</Text>
        </Card>
      ) : deals.length === 0 ? (
        <Empty icon="people-outline" title={t('gb.empty')} sub={t('gb.emptySub')} />
      ) : (
        <View style={{ gap: Spacing.md }}>
          {deals.map((d) => {
            const meta = STATUS_META[d.status];
            const progress = Math.min(1, d.soldCount / Math.max(d.quantity, 1));
            return (
              <Card key={d.id} onPress={() => router.push(`/marketing/deal/${d.id}`)} style={{ gap: Spacing.sm }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={styles.dealTitle} numberOfLines={2}>{d.title}</Text>
                  <Pill label={t(meta.label)} tone={meta.tone} />
                </Row>
                {d.status === 'rejected' && d.rejectReason ? (
                  <Text style={{ fontSize: FontSize.xs, color: Colors.danger, lineHeight: 16 }} numberOfLines={2}>
                    {t('gb.rejected', { reason: d.rejectReason })}
                  </Text>
                ) : null}
                <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
                  <View style={{ gap: 2 }}>
                    <Row gap={8} style={{ alignItems: 'baseline' }}>
                      <Text style={styles.price}>{tzs(d.priceTZS)}</Text>
                      <Text style={styles.priceOld}>{tzs(d.originalPriceTZS)}</Text>
                    </Row>
                    <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                      {dayLabel(d.salesStartAt)} ~ {dayLabel(d.salesEndAt)} · {t('gb.validity', { n: d.validityDays })}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end', gap: 4 }}>
                    <Text style={{ fontSize: FontSize.xs, fontWeight: '700', color: Colors.textSecondary }}>
                      {t('gb.soldOf', { sold: d.soldCount, quantity: d.quantity })}
                    </Text>
                    <View style={styles.progressTrack}>
                      <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
                    </View>
                  </View>
                </Row>
              </Card>
            );
          })}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  subtitle: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600', flex: 1, paddingRight: Spacing.md },
  dealTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flex: 1, paddingRight: Spacing.md },
  price: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  priceOld: { fontSize: FontSize.xs, color: Colors.textTertiary, textDecorationLine: 'line-through' },
  progressTrack: {
    height: 5,
    width: 84,
    borderRadius: 3,
    backgroundColor: Colors.surface,
    overflow: 'hidden',
  },
  progressFill: { height: 5, borderRadius: 3, backgroundColor: Colors.primary },
});