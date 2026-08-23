import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Btn, Card, Chip, Field, Icon, Row, Screen } from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { formatTZS } from '@/lib/format';
import { idempotencyKey } from '@/lib/idempotency';
import { getRideRepository } from '@/repos';
import { useSessionStore } from '@/store/session';
import { useLocationStore } from '@/store/location';
import { toast } from '@/store/ui';
import { ApiError } from '@/api/client';
import type { RideEstimate, RideType } from '@/repos';

const RIDE_TYPES: { key: RideType; label: string; sub: string; icon: 'car' | 'car-sport' | 'bus' }[] = [
  { key: 'express', label: 'Express', sub: 'Economy · 2–3 min', icon: 'car' },
  { key: 'premier', label: 'Premier', sub: 'Comfort · 3–5 min', icon: 'car-sport' },
  { key: 'taxi', label: 'Taxi', sub: 'Metered · 2–4 min', icon: 'bus' },
];

export default function RideScreen() {
  const router = useRouter();
  const user = useSessionStore((s) => s.user);
  const city = useLocationStore((s) => s.city);
  const [pickup, setPickup] = useState(city?.name ? `Current location · ${city.name}` : 'Current location');
  const [destination, setDestination] = useState('');
  const [rideType, setRideType] = useState<RideType>('express');
  const [estimate, setEstimate] = useState<RideEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [estimateError, setEstimateError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const loadEstimate = useCallback(async () => {
    if (!pickup.trim() || !destination.trim()) {
      setEstimate(null);
      setEstimateError('');
      return;
    }
    if (pickup.trim() === destination.trim()) {
      setEstimate(null);
      setEstimateError('Pickup and destination must be different');
      return;
    }
    setEstimating(true);
    setEstimateError('');
    try {
      const est = await getRideRepository().estimate({ pickup: pickup.trim(), destination: destination.trim(), rideType });
      setEstimate(est);
    } catch (e) {
      setEstimate(null);
      setEstimateError(e instanceof ApiError ? e.message : 'Could not estimate fare');
    } finally {
      setEstimating(false);
    }
  }, [pickup, destination, rideType]);

  useEffect(() => {
    void loadEstimate();
  }, [loadEstimate]);

  const confirm = async () => {
    if (!pickup.trim() || !destination.trim()) {
      setSubmitError('Enter pickup and destination');
      return;
    }
    setSubmitError('');
    setSubmitting(true);
    try {
      const ride = await getRideRepository().create(
        { pickup: pickup.trim(), destination: destination.trim(), rideType },
        idempotencyKey(user?.id ?? 'customer', 'ride'),
      );
      toast('Ride requested — finding your driver');
      router.push({ pathname: '/ride/tracking' as any, params: { rideId: ride.id } } as any);
    } catch (e) {
      setSubmitError(e instanceof ApiError ? e.message : 'Could not create ride');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen scroll contentStyle={{ padding: Spacing.lg, paddingBottom: 40 }}>
      <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
        <Btn label="Back" onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
        <Text style={styles.title}>Ride</Text>
        <View style={{ width: 72 }} />
      </Row>

      <Card style={{ gap: Spacing.md }}>
        <Field label="Pickup · Current location" value={pickup} onChangeText={setPickup} placeholder="Current location" />
        <Field label="Destination" value={destination} onChangeText={setDestination} placeholder="Where to?" />
        {estimateError ? <Text style={styles.error}>{estimateError}</Text> : null}
      </Card>

      <Text style={styles.section}>Ride type</Text>
      <View style={{ gap: Spacing.sm }}>
        {RIDE_TYPES.map((t) => {
          const selected = rideType === t.key;
          return (
            <Pressable
              key={t.key}
              onPress={() => setRideType(t.key)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              style={({ pressed }) => [styles.typeCard, selected && styles.typeSelected, pressed && { opacity: 0.85 }]}>
              <View style={[styles.typeIcon, selected && { backgroundColor: Colors.ink }]}>
                <Icon name={t.icon} size={18} color={selected ? Colors.white : Colors.primaryDeep} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.typeLabel, selected && { color: Colors.text }]}>{t.label}</Text>
                <Text style={styles.typeSub}>{t.sub}</Text>
              </View>
              <Icon name={selected ? 'radio-button-on' : 'radio-button-off'} size={18} color={selected ? Colors.primary : Colors.borderStrong} />
            </Pressable>
          );
        })}
      </View>

      {/* Fare estimate via mock */}
      <Card style={{ marginTop: Spacing.lg }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.section}>Fare estimate</Text>
          {estimating ? <ActivityIndicator size="small" color={Colors.primary} /> : null}
        </Row>
        {estimate ? (
          <View style={{ gap: Spacing.sm, marginTop: Spacing.sm }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.meta}>Distance</Text>
              <Text style={styles.value}>{estimate.distanceKm.toFixed(1)} km</Text>
            </Row>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.meta}>Duration</Text>
              <Text style={styles.value}>~{estimate.durationMin} min</Text>
            </Row>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.meta}>Estimated fare</Text>
              <Text style={styles.valueStrong}>{formatTZS(estimate.fareTZS)}</Text>
            </Row>
            <View style={styles.chipsRow}>
              <Chip label={`Express ${formatTZS(3500 + Math.round(estimate.distanceKm * 900))}`} selected={rideType === 'express'} onPress={() => setRideType('express')} />
              <Chip label={`Premier ${formatTZS(6500 + Math.round(estimate.distanceKm * 1500))}`} selected={rideType === 'premier'} onPress={() => setRideType('premier')} />
              <Chip label={`Taxi ${formatTZS(5000 + Math.round(estimate.distanceKm * 1100))}`} selected={rideType === 'taxi'} onPress={() => setRideType('taxi')} />
            </View>
          </View>
        ) : (
          <Text style={[styles.meta, { marginTop: Spacing.sm }]}>{destination.trim() ? 'Enter a destination to see fare' : 'Enter pickup and destination'}</Text>
        )}
      </Card>

      {submitError ? <Text style={[styles.error, { marginTop: Spacing.md }]}>{submitError}</Text> : null}

      <Btn
        label="Confirm pickup"
        onPress={confirm}
        size="lg"
        loading={submitting}
        disabled={!pickup.trim() || !destination.trim() || estimating || submitting}
        icon="car"
        style={{ marginTop: Spacing.lg }}
      />
      <Text style={[styles.meta, { textAlign: 'center', marginTop: Spacing.sm }]}>Driver matching starts after confirmation · ETA updates live</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text, textAlign: 'center' },
  section: { fontSize: FontSize.md, fontFamily: Fonts.sansBold, color: Colors.text, marginTop: Spacing.lg, marginBottom: Spacing.sm },
  meta: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sans },
  value: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansMedium },
  valueStrong: { fontSize: FontSize.lg, fontFamily: Fonts.displayBold, color: Colors.text },
  error: { color: Colors.danger, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold },
  typeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
  },
  typeSelected: { borderColor: Colors.primary, backgroundColor: Colors.primarySoft },
  typeIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  typeLabel: { fontSize: FontSize.md, fontFamily: Fonts.sansBold, color: Colors.text },
  typeSub: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginTop: Spacing.md },
});
