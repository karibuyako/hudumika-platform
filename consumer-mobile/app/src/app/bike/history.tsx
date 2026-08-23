/* Bike ride history — GET /bikes/rides/me grouped newest first.
 * Fare, distance, duration, geofence violation pill + pay action for pending rides.
 */
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { Btn, Card, Divider, EmptyState, ErrorState, Icon, MoneyText, Pill, Row, Screen, SkeletonCard, StatusPill } from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { formatTZS } from '@/lib/format';
import { dateISO, fullDateISO } from '@/lib/dates';
import { getBikeRepository } from '@/repos';
import type { BikeRide } from '@/repos';
import { idempotencyKey } from '@/lib/idempotency';
import { useSessionStore } from '@/store/session';
import { toast } from '@/store/ui';
import { ApiError } from '@/api/client';

export default function BikeHistoryScreen() {
  const router = useRouter();
  const user = useSessionStore((s) => s.user);
  const [rides, setRides] = useState<BikeRide[] | null>(null);
  const [error, setError] = useState('');
  const [payingId, setPayingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      setRides(await getBikeRepository().listHistory());
    } catch {
      setError(t('common.error'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const pay = async (ride: BikeRide) => {
    if (!ride.fareTZS) return;
    setPayingId(ride.id);
    try {
      await getBikeRepository().pay(ride.id, 'wallet', idempotencyKey(user?.id ?? 'cus_1', 'bike.pay'));
      toast(t('bike.paySuccess'));
      load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : t('common.error'), 'error');
    } finally {
      setPayingId(null);
    }
  };

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (!rides) {
    return (
      <Screen>
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={3} />
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg }}>
        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <Text style={styles.title}>{t('bike.history')}</Text>
          <View style={{ width: 40 }} />
        </Row>
      </View>

      {rides.length === 0 ? (
        <EmptyState icon="bicycle-outline" title={t('bike.noHistory')} />
      ) : (
        <FlatList
          data={rides}
          keyExtractor={(r) => r.id}
          onRefresh={load}
          refreshing={false}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }}
          renderItem={({ item }) => {
            const isPendingPay = item.paymentStatus === 'pending' && !!item.fareTZS;
            const isViolation = item.geofenceViolation === true;
            return (
              <Card style={styles.card}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Row gap={Spacing.sm} style={{ flex: 1 }}>
                    <View style={[styles.icon, { backgroundColor: item.bikeType === 'ebike' ? Colors.goldSoft : Colors.primarySoft }]}>
                      <Icon name="bicycle" size={18} color={item.bikeType === 'ebike' ? Colors.gold : Colors.primaryDeep} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.name}>{item.bikeCode}</Text>
                      <Text style={styles.meta}>{item.bikeType === 'ebike' ? 'E-bike' : 'Bike'} · {dateISO(item.startAt)}</Text>
                    </View>
                  </Row>
                  <StatusPill status={item.status} />
                </Row>

                <Row gap={Spacing.sm} style={{ flexWrap: 'wrap', marginTop: Spacing.sm }}>
                  {item.durationMinutes ? <Text style={styles.meta}>{t('bike.duration', { n: item.durationMinutes })}</Text> : null}
                  {item.distanceKm ? <Text style={styles.meta}>{t('bike.distanceLabel', { n: item.distanceKm.toFixed(1) })}</Text> : null}
                  {item.fareTZS ? <MoneyText amountTZS={item.fareTZS} size={FontSize.sm} bold /> : null}
                </Row>

                <Row gap={Spacing.sm} style={{ flexWrap: 'wrap', marginTop: Spacing.xs }}>
                  {item.paymentStatus ? <Pill label={item.paymentStatus} tone={item.paymentStatus === 'paid' ? 'success' : item.paymentStatus === 'failed' ? 'danger' : 'warning'} /> : null}
                  {isViolation ? <Pill label={t('bike.geofenceViolation')} tone="warning" /> : null}
                </Row>

                {isViolation && item.fareBreakdown?.geofenceSurchargeTZS ? (
                  <View style={[styles.violationBox, { backgroundColor: Colors.warningSoft, borderColor: Colors.warning }]}>
                    <Text style={[styles.meta, { color: Colors.warning, fontFamily: Fonts.sansSemibold }]}>{t('bike.geofenceNote')}</Text>
                    <Text style={styles.meta}>{t('bike.geofenceSurcharge')}: {formatTZS(item.fareBreakdown.geofenceSurchargeTZS)}</Text>
                  </View>
                ) : null}

                {item.startAt ? <Text style={styles.meta}>{t('bike.startedAt', { t: fullDateISO(item.startAt) })}</Text> : null}
                {item.endAt ? <Text style={styles.meta}>{t('bike.endedAt', { t: fullDateISO(item.endAt) })}</Text> : null}

                {item.fareBreakdown ? (
                  <>
                    <Divider style={{ marginVertical: Spacing.sm }} />
                    <Row style={{ justifyContent: 'space-between' }}>
                      <Text style={styles.meta}>{t('bike.unlockFee')}</Text>
                      <Text style={styles.value}>{formatTZS(item.fareBreakdown.unlockFeeTZS)}</Text>
                    </Row>
                    <Row style={{ justifyContent: 'space-between' }}>
                      <Text style={styles.meta}>{t('breakdown.subtotal')}</Text>
                      <Text style={styles.value}>{formatTZS(item.fareBreakdown.rideFeeTZS)}</Text>
                    </Row>
                    {item.fareBreakdown.geofenceSurchargeTZS > 0 ? (
                      <Row style={{ justifyContent: 'space-between' }}>
                        <Text style={[styles.meta, { color: Colors.warning }]}>{t('bike.geofenceSurcharge')}</Text>
                        <Text style={[styles.value, { color: Colors.warning }]}>{formatTZS(item.fareBreakdown.geofenceSurchargeTZS)}</Text>
                      </Row>
                    ) : null}
                    <Row style={{ justifyContent: 'space-between', marginTop: Spacing.xs }}>
                      <Text style={[styles.name, { fontFamily: Fonts.sansBold }]}>{t('breakdown.total')}</Text>
                      <MoneyText amountTZS={item.fareBreakdown.totalTZS} bold />
                    </Row>
                  </>
                ) : null}

                {isPendingPay ? (
                  <Btn label={t('bike.pay', { amount: formatTZS(item.fareTZS!) })} onPress={() => pay(item)} loading={payingId === item.id} size="sm" style={{ marginTop: Spacing.md, alignSelf: 'flex-start' }} />
                ) : null}
              </Card>
            );
          }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xl, fontFamily: Fonts.displayBold, color: Colors.text, flex: 1, textAlign: 'center' },
  card: { marginBottom: Spacing.md, gap: Spacing.sm },
  icon: { width: 36, height: 36, borderRadius: Radius.md, alignItems: 'center', justifyContent: 'center' },
  name: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text },
  value: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansSemibold, fontVariant: ['tabular-nums'] },
  meta: { fontSize: FontSize.xs, color: Colors.textSecondary, fontFamily: Fonts.sans, marginTop: 2 },
  violationBox: { borderRadius: Radius.md, borderWidth: 1, padding: Spacing.sm, marginTop: Spacing.sm, gap: 4 },
});
