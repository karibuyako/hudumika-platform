import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { Btn, Card, Divider, EmptyState, ErrorState, Icon, Pill, Row, Screen, SkeletonCard } from '@/components/ui';
import { MapView } from '@/components/MapView';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { formatTZS } from '@/lib/format';
import { getRideRepository } from '@/repos';
import { toast } from '@/store/ui';
import { ApiError } from '@/api/client';
import type { Ride } from '@/repos';

const POLL_MS = 2500;

function statusTone(status: Ride['status']): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  if (status === 'matching') return 'info';
  if (status === 'matched' || status === 'arriving') return 'warning';
  if (status === 'in_ride') return 'info';
  if (status === 'completed') return 'success';
  if (status === 'cancelled') return 'danger';
  return 'neutral';
}

function statusLabel(status: Ride['status']): string {
  if (status === 'matching') return 'Driver matching';
  if (status === 'matched') return 'Driver assigned';
  if (status === 'arriving') return 'Driver arriving';
  if (status === 'in_ride') return 'On trip';
  if (status === 'completed') return 'Completed';
  if (status === 'cancelled') return 'Cancelled';
  return status;
}

/** Derive a fake driver coordinate for the map — moves toward destination through lifecycle. */
function driverCoordinate(ride: Ride): { lat: number; lon: number } | null {
  const base = ride.pickupCoord ?? { lat: -6.7924, lon: 39.2083 };
  const dest = ride.destinationCoord ?? { lat: base.lat + 0.02, lon: base.lon + 0.015 };
  if (ride.status === 'matching') return null;
  if (ride.status === 'matched') return { lat: base.lat + 0.006, lon: base.lon - 0.004 };
  if (ride.status === 'arriving') return { lat: base.lat + 0.0015, lon: base.lon + 0.001 };
  if (ride.status === 'in_ride') return { lat: (base.lat + dest.lat) / 2, lon: (base.lon + dest.lon) / 2 };
  if (ride.status === 'completed') return dest;
  return base;
}

export default function RideTrackingScreen() {
  const router = useRouter();
  const { rideId } = useLocalSearchParams<{ rideId: string }>();
  const [ride, setRide] = useState<Ride | null>(null);
  const [error, setError] = useState('');
  const [rating, setRating] = useState(0);
  const [rated, setRated] = useState(false);

  const load = useCallback(
    async (silent = false) => {
      if (!rideId) return;
      if (!silent) setError('');
      try {
        const data = await getRideRepository().get(rideId);
        setRide(data);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) setError('Ride not found');
        else if (!silent) setError('Could not load ride');
      }
    },
    [rideId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => void load(true), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const contactDriver = () => {
    if (!ride?.driver?.phone) {
      toast('Driver contact unavailable');
      return;
    }
    const url = `tel:${ride.driver.phone}`;
    void Linking.openURL(url).catch(() => toast(`Driver: ${ride.driver?.phone}`));
  };

  const cancelRide = async () => {
    if (!ride) return;
    try {
      const updated = await getRideRepository().cancel(ride.id, `cancel-${Date.now()}`);
      setRide(updated);
      toast('Ride cancelled');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not cancel ride');
    }
  };

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={() => load()} />
      </Screen>
    );
  }

  if (!ride) {
    return (
      <Screen>
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={3} />
          <SkeletonCard rows={2} />
        </View>
      </Screen>
    );
  }

  const driverLoc = driverCoordinate(ride);
  const mapCenter = driverLoc ?? ride.pickupCoord ?? { lat: -6.7924, lon: 39.2083 };
  const eta = ride.etaMin;
  const canCancel = ride.status === 'matching' || ride.status === 'matched';

  return (
    <Screen scroll contentStyle={{ padding: Spacing.lg, paddingBottom: 40 }}>
      <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
        <Btn label="Back" onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
        <Pill label={statusLabel(ride.status)} tone={statusTone(ride.status)} />
      </Row>

      {/* Route tracking — MapView with driver marker + ETA */}
      <Card>
        <Text style={styles.head}>{ride.pickup} → {ride.destination}</Text>
        <Text style={styles.meta}>{ride.rideType.toUpperCase()} · {ride.distanceKm.toFixed(1)} km · ~{ride.durationMin} min · {formatTZS(ride.fareTZS)}</Text>
        <View style={{ marginTop: Spacing.md }}>
          <MapView center={mapCenter} marker={driverLoc} height={180} label="Driver location" interactive />
        </View>
        <Row gap={Spacing.md} style={{ marginTop: Spacing.md, justifyContent: 'space-between' }}>
          <View>
            <Text style={styles.etaLabel}>ETA</Text>
            <Text style={styles.eta}>{eta !== undefined ? `~${eta} min` : ride.status === 'completed' ? 'Arrived' : '—'}</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={styles.meta}>Fare estimate</Text>
            <Text style={styles.valueStrong}>{formatTZS(ride.fareTZS)}</Text>
          </View>
        </Row>
        {ride.status === 'matching' ? (
          <View style={[styles.banner, { backgroundColor: Colors.infoSoft }]}>
            <Row gap={Spacing.sm}>
              <Icon name="search" size={16} color={Colors.info} />
              <Text style={[styles.bannerText, { color: Colors.info }]}>Finding your driver…</Text>
            </Row>
          </View>
        ) : null}
      </Card>

      {/* Driver details */}
      {ride.driver ? (
        <Card style={{ marginTop: Spacing.md, gap: Spacing.md }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={styles.section}>Driver details</Text>
            <Pill label={`${ride.driver.rating.toFixed(1)} ★`} tone="success" />
          </Row>
          <Row gap={Spacing.md}>
            <View style={styles.driverAvatar}>
              <Icon name="person" size={22} color={Colors.white} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.driverName}>{ride.driver.name}</Text>
              <Text style={styles.meta}>{ride.driver.carColor} {ride.driver.carModel} · {ride.driver.plate}</Text>
            </View>
          </Row>
          <Row gap={Spacing.md}>
            <Btn label="Contact driver" onPress={contactDriver} icon="call" size="sm" style={{ flex: 1 }} />
            <Btn label="Share trip" onPress={() => toast('Trip shared — hudumika://ride/' + ride.id)} variant="outline" size="sm" icon="share-social-outline" style={{ flex: 1 }} />
          </Row>
          {ride.status === 'arriving' ? (
            <View style={[styles.banner, { backgroundColor: Colors.warningSoft }]}>
              <Text style={[styles.bannerText, { color: Colors.warning }]}>Driver is arriving — meet at pickup</Text>
            </View>
          ) : null}
        </Card>
      ) : (
        <Card style={{ marginTop: Spacing.md }}>
          <EmptyState icon="car-outline" title="Matching driver" sub="We’ll show driver details once assigned" />
        </Card>
      )}

      {/* Ride phases */}
      <Text style={styles.sectionTitle}>Trip progress</Text>
      <Card style={{ gap: Spacing.sm }}>
        {(['matching', 'matched', 'arriving', 'in_ride', 'completed'] as Ride['status'][]).map((s, i, arr) => {
          const done = arr.indexOf(ride.status) >= i || ride.status === 'completed';
          const active = ride.status === s;
          return (
            <Row key={s} gap={Spacing.md}>
              <View style={styles.phaseRail}>
                <View style={[styles.phaseDot, done && { backgroundColor: Colors.success }, active && { backgroundColor: Colors.primary }]} />
                {i < arr.length - 1 ? <View style={styles.phaseLine} /> : null}
              </View>
              <View style={{ flex: 1, paddingBottom: i < arr.length - 1 ? Spacing.sm : 0 }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={[styles.value, active && { color: Colors.primaryDeep, fontFamily: Fonts.sansBold }]}>{statusLabel(s)}</Text>
                  {active ? <Pill label="Now" tone="info" /> : done ? <Pill label="Done" tone="success" /> : <Pill label="Pending" tone="neutral" />}
                </Row>
              </View>
            </Row>
          );
        })}
      </Card>

      {/* Payment */}
      {ride.status === 'completed' ? (
        <Card style={{ marginTop: Spacing.md, gap: Spacing.md }}>
          <Text style={styles.section}>Payment</Text>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={styles.meta}>Total fare</Text>
            <Text style={styles.valueStrong}>{formatTZS(ride.fareTZS)}</Text>
          </Row>
          <Divider />
          <Text style={styles.meta}>Paid via wallet · Receipt will appear in wallet transactions</Text>
          <Btn label={`Pay ${formatTZS(ride.fareTZS)}`} onPress={() => toast('Payment confirmed — asante!')} icon="wallet-outline" />
        </Card>
      ) : null}

      {/* Rating */}
      {ride.status === 'completed' ? (
        <Card style={{ marginTop: Spacing.md, gap: Spacing.md }}>
          <Text style={styles.section}>Rate your ride</Text>
          {rated ? (
            <Text style={[styles.meta, { color: Colors.success, fontFamily: Fonts.sansBold }]}>Thanks — you rated {rating} ★</Text>
          ) : (
            <>
              <Row gap={Spacing.sm}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <Pressable
                    key={n}
                    onPress={() => setRating(n)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={`Rate ${n} star${n > 1 ? 's' : ''}`}
                    style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }]}>
                    <Icon name={n <= rating ? 'star' : 'star-outline'} size={28} color={n <= rating ? Colors.gold : Colors.borderStrong} />
                  </Pressable>
                ))}
              </Row>
              <Btn label="Submit rating" onPress={() => { if (!rating) { toast('Pick a rating first'); return; } setRated(true); toast('Rating submitted — asante!'); }} disabled={!rating} />
            </>
          )}
        </Card>
      ) : null}

      {canCancel ? (
        <Btn label="Cancel ride" onPress={cancelRide} variant="danger" style={{ marginTop: Spacing.lg }} />
      ) : null}

      <Text style={[styles.meta, { textAlign: 'center', marginTop: Spacing.md }]}>Route tracking updates live · Driver location refreshes every few seconds</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { fontSize: FontSize.md, fontFamily: Fonts.sansBold, color: Colors.text },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  etaLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontFamily: Fonts.sansSemibold, letterSpacing: 0.3, textTransform: 'uppercase' },
  eta: { fontSize: FontSize.xl, fontFamily: Fonts.displayBold, color: Colors.text },
  value: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansMedium },
  valueStrong: { fontSize: FontSize.lg, fontFamily: Fonts.displayBold, color: Colors.text },
  section: { fontSize: FontSize.md, fontFamily: Fonts.sansBold, color: Colors.text },
  sectionTitle: { fontSize: FontSize.lg, fontFamily: Fonts.sansExtraBold, color: Colors.text, marginTop: Spacing.lg, marginBottom: Spacing.sm },
  driverAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Colors.primaryDeep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  driverName: { fontSize: FontSize.md, fontFamily: Fonts.sansBold, color: Colors.text },
  banner: { marginTop: Spacing.md, padding: Spacing.md, borderRadius: Radius.md },
  bannerText: { fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold },
  phaseRail: { alignItems: 'center', width: 14, alignSelf: 'stretch' },
  phaseDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: Colors.borderStrong },
  phaseLine: { width: 2, flex: 1, minHeight: 14, backgroundColor: Colors.border, marginTop: 2 },
});
