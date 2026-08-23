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
import { Colors, FontSize, LogisticsTokens, NumberStyle, Radius, Spacing } from '@/constants/theme';
import { t, formatTZS } from '@/i18n';
import { clockISO } from '@/lib/format';
import { capacityBarTone, capacityPercent } from '@/lib/logistics';
import { getLogisticsRepository, getTripsRepository } from '@/repos';
import type { LogisticsTrip, Trip, TripStopsItem, Vehicle } from '@hudumika/contract';

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

function CapacityBar({ used, max, label }: { used: number; max: number; label: string }) {
  const pct = capacityPercent(used, max);
  const tone = capacityBarTone(pct);
  const color = tone === 'danger' ? Colors.danger : tone === 'warning' ? Colors.warning : Colors.success;
  return (
    <View style={styles.capacityRow}>
      <Text style={styles.capacityLabel}>{label} {used}/{max}</Text>
      <View style={styles.capacityTrack}>
        <View style={[styles.capacityFill, { width: `${pct}%`, backgroundColor: color }]} />
      </View>
      <Text style={styles.capacityPct}>{pct}%</Text>
    </View>
  );
}

export default function TripScreen() {
  const [trip, setTrip] = useState<Trip | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reorderError, setReorderError] = useState('');
  const [reordering, setReordering] = useState(false);
  const [logisticsTrip, setLogisticsTrip] = useState<LogisticsTrip | null>(null);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [capacityError, setCapacityError] = useState<{ code: string; message: string; requestId?: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setCapacityError(null);
    try {
      setTrip(await getTripsRepository().getActiveTrip());
      try {
        const logisticsRepo = getLogisticsRepository();
        const trips = await logisticsRepo.listLogisticsTrips();
        if (trips.length > 0) {
          const lt = trips[0];
          setLogisticsTrip(lt);
          if (lt.vehicleId) {
            const v = await logisticsRepo.getVehicle(lt.vehicleId);
            setVehicle(v);
          }
        }
      } catch {
        // cargo summary optional
      }
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

  const usedWeight = vehicle ? (vehicle.capacity?.compartments ?? []).reduce((s, c) => s + (c.usedWeightKg ?? 0), 0) : 0;
  const maxWeight = vehicle?.capacity?.maxWeightKg ?? 0;
  const usedVolume = vehicle ? (vehicle.capacity?.compartments ?? []).reduce((s, c) => s + (c.usedVolumeL ?? 0), 0) : 0;
  const maxVolume = vehicle?.capacity?.maxVolumeL ?? 0;

  const checkCapacity = async (pkgId: string) => {
    if (!vehicle) return;
    setCapacityError(null);
    try {
      const repo = getLogisticsRepository();
      await repo.checkVehicleCapacity(vehicle.id, pkgId);
    } catch (e) {
      if (e instanceof ApiError) {
        setCapacityError({ code: e.code, message: e.message, requestId: e.requestId });
      }
    }
  };

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
            {logisticsTrip && vehicle ? (
              <Card style={styles.cargoCard}>
                <Text style={styles.cargoTitle}>{t('logistics.cargoSummary')} · {logisticsTrip.tripNumber}</Text>
                <Text style={styles.cargoSub}>Expected {logisticsTrip.manifestSummary?.expectedUnits ?? 0} · Verified {logisticsTrip.manifestSummary?.verifiedUnits ?? 0} · Exceptions {logisticsTrip.manifestSummary?.exceptions ?? 0}</Text>
                {maxWeight ? <CapacityBar used={usedWeight} max={maxWeight} label={t('logistics.cargoWeight')} /> : null}
                {maxVolume ? <CapacityBar used={usedVolume} max={maxVolume} label={t('logistics.cargoVolume')} /> : null}
                {vehicle.capacity?.compartments?.map((c) => (
                  <View key={c.name} style={styles.compartmentRow}>
                    <Text style={styles.compartmentName}>{t('logistics.compartment')} {c.name}</Text>
                    <Text style={styles.compartmentMeta}>{c.used}/{c.capacity} · {c.usedWeightKg ?? 0}kg · {c.usedVolumeL ?? 0}L</Text>
                  </View>
                ))}
                {capacityError ? (
                  <View style={styles.capacityErrorBox}>
                    <Text style={styles.capacityErrorText}>{capacityError.code}: {capacityError.message}</Text>
                    {capacityError.requestId ? <Text style={styles.capacityRequestId}>RequestId: {capacityError.requestId}</Text> : null}
                  </View>
                ) : null}
                <View style={styles.capacityActions}>
                  <Btn label="Check heavy pkg" variant="ghost" size="sm" onPress={() => checkCapacity('pkg_heavy')} />
                  <Btn label="Check bulky pkg" variant="ghost" size="sm" onPress={() => checkCapacity('pkg_bulky')} />
                  <Btn label="Check normal pkg" variant="ghost" size="sm" onPress={() => checkCapacity('pkg_1')} />
                </View>
              </Card>
            ) : null}
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
  cargoCard: { gap: Spacing.sm, marginBottom: Spacing.sm },
  cargoTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  cargoSub: { fontSize: FontSize.xs, color: Colors.textTertiary },
  capacityRow: { gap: 4 },
  capacityLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '600' },
  capacityTrack: { height: LogisticsTokens.capacityBarHeight, borderRadius: LogisticsTokens.capacityBarRadius, backgroundColor: Colors.surface, overflow: 'hidden' },
  capacityFill: { height: '100%', borderRadius: LogisticsTokens.capacityBarRadius },
  capacityPct: { fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'right' },
  compartmentRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 2 },
  compartmentName: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '600' },
  compartmentMeta: { fontSize: FontSize.xs, color: Colors.textTertiary },
  capacityErrorBox: { backgroundColor: Colors.dangerSoft, borderRadius: Radius.sm, padding: Spacing.sm, gap: 4, borderWidth: 1, borderColor: Colors.danger },
  capacityErrorText: { fontSize: FontSize.xs, color: Colors.danger, fontWeight: '700' },
  capacityRequestId: { fontSize: FontSize.xs, color: Colors.textTertiary },
  capacityActions: { flexDirection: 'row', gap: Spacing.sm, flexWrap: 'wrap' },
});