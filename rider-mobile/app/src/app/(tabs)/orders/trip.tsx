/* Batch trip (P10c) — trip summary, per-stop status, manual reorder.
 *
 * Data: GET /riders/me/trips (active), POST /riders/me/trips/{tripId}/reorder.
 * earningsTZS is server-computed — the screen only renders it.
 * A completed trip shows the trip.completed summary (no reorder).
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import type { ListRenderItemInfo } from 'react-native';

import { ApiError } from '@/api/client';
import { Btn, Card, Empty, Pill, Row, Screen, Spinner } from '@/components/ui';
import { Colors, FontSize, NumberStyle, Spacing } from '@/constants/theme';
import { t, formatTZS } from '@/i18n';
import { clockISO } from '@/lib/format';
import { getTripsRepository } from '@/repos';
import type { Trip, TripStopsItem } from '@hudumika/contract';

const STOP_TONE: Record<TripStopsItem['status'], 'neutral' | 'success' | 'info' | 'danger'> = {
  pending: 'neutral',
  arrived: 'info',
  done: 'success',
  failed: 'danger',
};

const STOP_LABEL = {
  pending: 'trip.stopPending',
  arrived: 'trip.stopArrived',
  done: 'trip.stopDone',
  failed: 'trip.stopFailed',
} as const;

interface StopRow {
  orderId: string;
  pickup: TripStopsItem;
  dropoff: TripStopsItem;
}

export default function TripScreen() {
  const [trip, setTrip] = useState<Trip | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reorderError, setReorderError] = useState('');
  const [reordering, setReordering] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setTrip(await getTripsRepository().getActiveTrip());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('trip.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const rows = useMemo<StopRow[]>(() => {
    if (!trip) return [];
    const byOrder = new Map<string, TripStopsItem>();
    for (const stop of trip.stops) byOrder.set(`${stop.orderId}:${stop.stopType}`, stop);
    return trip.orderIds.map((orderId) => ({
      orderId,
      pickup: byOrder.get(`${orderId}:pickup`) ?? { orderId, sequence: 0, stopType: 'pickup', status: 'pending' },
      dropoff: byOrder.get(`${orderId}:dropoff`) ?? { orderId, sequence: 0, stopType: 'dropoff', status: 'pending' },
    }));
  }, [trip]);

  const move = useCallback(
    async (orderId: string, direction: -1 | 1) => {
      if (!trip) return;
      const idx = trip.orderIds.indexOf(orderId);
      const target = idx + direction;
      if (idx === -1 || target < 0 || target >= trip.orderIds.length) return;
      const next = [...trip.orderIds];
      [next[idx], next[target]] = [next[target], next[idx]];
      setReordering(true);
      setReorderError('');
      try {
        setTrip(await getTripsRepository().reorderStops(trip.id, next));
      } catch (e) {
        setReorderError(e instanceof ApiError ? e.message : t('trip.reorderFailed'));
      } finally {
        setReordering(false);
      }
    },
    [trip],
  );

  const renderStop = ({ item, index }: ListRenderItemInfo<StopRow>) => {
    const last = index === rows.length - 1;
    const reorderable = trip?.status === 'active';
    return (
      <Card flat style={styles.stopCard}>
        <Row style={{ justifyContent: 'space-between' }}>
          <View style={styles.stopIndex}>
            <Text style={styles.stopIndexText}>{index + 1}</Text>
          </View>
          <View style={{ flex: 1, paddingHorizontal: Spacing.md }}>
            <Text numberOfLines={1} style={styles.stopTitle}>
              {t('trip.title')} · {item.orderId.slice(0, 8)}
            </Text>
            <Row gap={Spacing.sm} style={{ marginTop: Spacing.sm }}>
              <Pill label={t('trip.stopPickup')} tone={STOP_TONE[item.pickup.status]} />
              <Pill label={t(STOP_LABEL[item.pickup.status])} tone="neutral" />
            </Row>
            <Row gap={Spacing.sm} style={{ marginTop: Spacing.xs }}>
              <Pill label={t('trip.stopDropoff')} tone={STOP_TONE[item.dropoff.status]} />
              <Pill label={t(STOP_LABEL[item.dropoff.status])} tone="neutral" />
            </Row>
          </View>
          {reorderable && (
            <View style={styles.moveCol}>
              <Btn
                label=""
                variant="ghost"
                icon="chevron-up"
                onPress={() => move(item.orderId, -1)}
                disabled={reordering || index === 0}
              />
              <Btn
                label=""
                variant="ghost"
                icon="chevron-down"
                onPress={() => move(item.orderId, 1)}
                disabled={reordering || last}
              />
            </View>
          )}
        </Row>
      </Card>
    );
  };

  if (loading) {
    return (
      <Screen>
        <View style={styles.center}>
          <Spinner color={Colors.primary} />
        </View>
      </Screen>
    );
  }

  if (error || !trip) {
    return (
      <Screen>
        <View style={styles.center}>
          <Text style={styles.error}>{error || t('trip.empty')}</Text>
          <Btn label={t('common.retry')} variant="ghost" onPress={load} />
        </View>
      </Screen>
    );
  }

  const completed = trip.status === 'completed';

  return (
    <Screen>
      <FlatList
        data={rows}
        keyExtractor={(row) => row.orderId}
        renderItem={renderStop}
        ItemSeparatorComponent={<View style={styles.separator} />}
        ListHeaderComponent={
          <View>
            <Card style={styles.summary}>
              <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <View style={{ flex: 1, paddingRight: Spacing.md }}>
                  <Text style={styles.summaryTitle}>
                    {completed ? t('trip.completed') : t('trip.active')}
                  </Text>
                  <Text style={styles.summarySub}>
                    {t('trip.stops', { count: trip.stops.length })} · {formatTZS(trip.earningsTZS ?? 0)}
                  </Text>
                  <Text style={styles.summarySub}>
                    {t(completed ? 'trip.completedAt' : 'trip.startedAt', {
                      time: clockISO(completed ? (trip.completedAt ?? trip.startedAt) : trip.startedAt),
                    })}
                  </Text>
                </View>
                <Pill
                  label={completed ? t('trip.completed') : t('trip.earnings')}
                  tone={completed ? 'success' : 'info'}
                />
              </Row>
            </Card>
            {!completed && <Text style={styles.hint}>{t('trip.reorderHint')}</Text>}
            {reorderError ? <Text style={styles.error}>{reorderError}</Text> : null}
          </View>
        }
        ListEmptyComponent={
          <Empty icon="git-branch-outline" title={t('trip.empty')} sub={t('trip.emptySub')} />
        }
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', gap: Spacing.md, paddingTop: 80 },
  error: { color: Colors.danger, fontSize: FontSize.sm, marginTop: Spacing.sm },
  summary: { marginBottom: Spacing.sm },
  summaryTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, fontVariant: NumberStyle.fontVariant },
  summarySub: { fontSize: FontSize.sm, color: Colors.textTertiary, marginTop: 2 },
  hint: { fontSize: FontSize.xs, color: Colors.textTertiary, marginBottom: Spacing.sm },
  stopCard: { borderWidth: 1, borderColor: Colors.border },
  stopIndex: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopIndexText: { color: Colors.white, fontSize: FontSize.sm, fontWeight: '700' },
  stopTitle: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  moveCol: { alignItems: 'center', justifyContent: 'space-between' },
  separator: { height: Spacing.md },
  listContent: { padding: Spacing.md, paddingBottom: 120 },
});