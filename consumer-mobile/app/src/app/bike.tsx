/* Bike rental — Meituan bike: Map → Nearby bikes → Select bike →
 * Scan QR/Bluetooth unlock → Ride → Temporary lock → Finish → Lock →
 * Geofence → Fare → Payment → History
 *
 * Uses MapView with nearby bike pins, QrScanner for QR unlock, theme + Screen
 * primitives. Ride timer updates every 10s. Geofence surcharge is rendered
 * as a warning when the server flags the finish as out-of-zone.
 */
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { MapView } from '@/components/MapView';
import { QrScanner } from '@/components/QrScanner';
import {
  Btn,
  Card,
  Chip,
  Divider,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  MoneyText,
  Pill,
  Row,
  Screen,
  SkeletonCard,
  StatusPill,
} from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { formatTZS } from '@/lib/format';
import { fullDateISO } from '@/lib/dates';
import { haversineKm } from '@/lib/geolocation';
import { GEOFENCE_CENTER, GEOFENCE_RADIUS_KM, parseBikeQr, BIKE_QR_EXAMPLE } from '@/lib/bike';
import { idempotencyKey } from '@/lib/idempotency';
import { getBikeRepository } from '@/repos';
import type { Bike, BikeRide } from '@/repos';
import { ApiError } from '@/api/client';
import { toast } from '@/store/ui';
import { useSessionStore } from '@/store/session';

const DEFAULT_CENTER = { lat: GEOFENCE_CENTER.lat, lon: GEOFENCE_CENTER.lon };

function formatDistance(m?: number): string {
  if (m === undefined || m === null) return '—';
  if (m < 1000) return t('bike.distance', { n: m });
  return t('bike.distanceKm', { n: (m / 1000).toFixed(1) });
}

function bikeStatusTone(status: Bike['status']): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'available') return 'success';
  if (status === 'riding') return 'warning';
  if (status === 'disabled') return 'danger';
  return 'neutral';
}

export default function BikeScreen() {
  const router = useRouter();
  const user = useSessionStore((s) => s.user);
  const [bikes, setBikes] = useState<Bike[] | null>(null);
  const [activeRide, setActiveRide] = useState<BikeRide | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);
  const [qr, setQr] = useState('');
  const [qrError, setQrError] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [lockBusy, setLockBusy] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [completedRide, setCompletedRide] = useState<BikeRide | null>(null);
  const [payMethod, setPayMethod] = useState('wallet');
  const [now, setNow] = useState(Date.now());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const selectedBike = useMemo(() => (selectedId ? bikes?.find((b) => b.id === selectedId) ?? null : null), [bikes, selectedId]);
  const center = useMemo(() => DEFAULT_CENTER, []);

  const load = useCallback(async () => {
    setError('');
    try {
      const [nearby, active] = await Promise.all([getBikeRepository().listNearby({ lat: center.lat, lon: center.lon }), getBikeRepository().getActiveRide()]);
      setBikes(nearby);
      setActiveRide(active);
      // If an active ride exists, highlight its bike
      if (active) setSelectedId(active.bikeId);
      // Auto-select first available when nothing selected
      if (!active && !selectedId && nearby.length > 0) {
        const avail = nearby.find((b) => b.status === 'available');
        if (avail) setSelectedId(avail.id);
      }
    } catch {
      setError(t('common.error'));
    }
  }, [center.lat, center.lon, selectedId]);

  useEffect(() => {
    load();
  }, [load]);

  // Ride timer — tick every 10s while a ride is active (riding or locked).
  useEffect(() => {
    if (!activeRide || activeRide.status === 'completed') {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }
    timerRef.current = setInterval(() => setNow(Date.now()), 10000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [activeRide]);

  const elapsedMinutes = useMemo(() => {
    if (!activeRide) return 0;
    return Math.max(0, Math.round((now - Date.parse(activeRide.startAt)) / 60000));
  }, [activeRide, now]);

  const doUnlock = async (codeOrId: string) => {
    const parsed = parseBikeQr(codeOrId);
    const isQr = !!parsed;
    const input = isQr ? { code: parsed!.code } : { bikeId: codeOrId };
    // Also try resolving bikeId fallback: if input is bike id like bike_001, find by id
    if (!isQr && !codeOrId.startsWith('BK-')) {
      // treat as bikeId directly
    }
    setUnlocking(true);
    setQrError('');
    try {
      const ride = await getBikeRepository().unlock(input, idempotencyKey(user?.id ?? 'cus_1', 'bike.unlock'));
      setActiveRide(ride);
      setCompletedRide(null);
      toast(t('bike.unlocked'));
      // Refresh bike list — unlocked bike becomes riding.
      const nearby = await getBikeRepository().listNearby({ lat: center.lat, lon: center.lon });
      setBikes(nearby);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'BIKE_NOT_FOUND') setQrError(t('bike.bikeNotFound'));
        else if (e.code === 'BIKE_NOT_AVAILABLE' || e.code === 'BIKE_LOW_BATTERY') setQrError(t('bike.notAvailable'));
        else if (e.code === 'RIDE_ALREADY_ACTIVE') toast(t('bike.alreadyActive'), 'error');
        else setQrError(e.message);
      } else {
        setQrError(t('common.error'));
      }
    } finally {
      setUnlocking(false);
    }
  };

  const onManualUnlock = () => {
    if (!qr.trim()) {
      setQrError(t('bike.qrInvalid'));
      return;
    }
    if (!parseBikeQr(qr) && !qr.trim().startsWith('bike_')) {
      setQrError(t('bike.qrInvalid'));
      return;
    }
    void doUnlock(qr.trim());
  };

  const onScan = (payload: string) => {
    setScannerOpen(false);
    setQr(payload);
    void doUnlock(payload);
  };

  const onSelectUnlock = () => {
    if (!selectedBike) return;
    void doUnlock(selectedBike.id);
  };

  const toggleLock = async () => {
    if (!activeRide) return;
    setLockBusy(true);
    try {
      const next =
        activeRide.lockStatus === 'locked'
          ? await getBikeRepository().temporaryUnlock(activeRide.id, idempotencyKey(user?.id ?? 'cus_1', 'bike.unlock_tmp'))
          : await getBikeRepository().temporaryLock(activeRide.id, idempotencyKey(user?.id ?? 'cus_1', 'bike.lock_tmp'));
      setActiveRide(next);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : t('common.error'), 'error');
    } finally {
      setLockBusy(false);
    }
  };

  const finishRide = async (outsideZone = false) => {
    if (!activeRide) return;
    setFinishing(true);
    try {
      // Finish at the bike's current position (mock uses lat/lon we send).
      // Use the selected bike's location or center; outsideZone simulates geofence violation.
      const bike = bikes?.find((b) => b.id === activeRide.bikeId);
      let lat = bike?.lat ?? center.lat;
      let lon = bike?.lon ?? center.lon;
      if (outsideZone) {
        // 12km north of Dar — outside 7km allowed zone.
        lat = GEOFENCE_CENTER.lat + 0.11;
        lon = GEOFENCE_CENTER.lon;
      }
      const ride = await getBikeRepository().finish({ rideId: activeRide.id, lat, lon }, idempotencyKey(user?.id ?? 'cus_1', 'bike.finish'));
      setActiveRide(null);
      setCompletedRide(ride);
      // Refresh bikes — finish returns bike to fleet (or disabled if geofence violated).
      const nearby = await getBikeRepository().listNearby({ lat: center.lat, lon: center.lon });
      setBikes(nearby);
      toast(t('bike.fare'));
    } catch (e) {
      toast(e instanceof ApiError ? e.message : t('common.error'), 'error');
    } finally {
      setFinishing(false);
    }
  };

  const payFare = async () => {
    if (!completedRide || !completedRide.fareTZS) return;
    setPaying(true);
    try {
      const paid = await getBikeRepository().pay(completedRide.id, payMethod, idempotencyKey(user?.id ?? 'cus_1', 'bike.pay'));
      setCompletedRide(paid);
      toast(t('bike.paySuccess'));
    } catch (e) {
      toast(e instanceof ApiError ? e.message : t('common.error'), 'error');
    } finally {
      setPaying(false);
    }
  };

  const bikePins = useMemo(() => (bikes ?? []).map((b) => ({ lat: b.lat, lon: b.lon })), [bikes]);
  const selectedIndex = useMemo(() => (bikes ?? []).findIndex((b) => b.id === selectedId), [bikes, selectedId]);

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  // Active ride view — takes over the screen (Meituan: full-screen ride card with map still visible).
  if (activeRide) {
    const distanceKm = haversineKm(activeRide.startLat, activeRide.startLon, center.lat, center.lon);
    return (
      <Screen scroll>
        <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg }}>
          <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
            <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
            <Text style={styles.title}>{t('bike.rideActive')}</Text>
            <Btn label={t('bike.viewHistory')} variant="ghost" size="sm" onPress={() => router.push('/bike/history' as any)} />
          </Row>

          <MapView
            center={center}
            marker={center}
            bikePins={bikePins}
            selectedBikeIndex={selectedIndex >= 0 ? selectedIndex : null}
            userLocation={center}
            interactive
            height={180}
            label={t('bike.mapA11y')}
          />

          <Card style={{ gap: Spacing.md, marginTop: Spacing.lg }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Row gap={Spacing.sm}>
                <View style={[styles.badge, { backgroundColor: activeRide.bikeType === 'ebike' ? Colors.goldSoft : Colors.primarySoft }]}>
                  <Icon name="bicycle" size={18} color={activeRide.bikeType === 'ebike' ? Colors.gold : Colors.primaryDeep} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{activeRide.bikeCode}</Text>
                  <Text style={styles.meta}>{activeRide.bikeType === 'ebike' ? 'E-bike' : 'Bike'} · {t('bike.startedAt', { t: fullDateISO(activeRide.startAt) })}</Text>
                </View>
              </Row>
              <StatusPill status={activeRide.status} />
            </Row>
            <Row gap={Spacing.sm} style={{ flexWrap: 'wrap' }}>
              <Pill label={activeRide.lockStatus === 'locked' ? t('bike.locked') : t('bike.riding')} tone={activeRide.lockStatus === 'locked' ? 'warning' : 'success'} />
              <Text style={styles.meta}>{t('bike.duration', { n: elapsedMinutes })} · {distanceKm.toFixed(1)} km</Text>
            </Row>
            <Text style={styles.hint}>{t('bike.finishHint')}</Text>
            <Divider />
            <Row gap={Spacing.sm}>
              <Btn
                label={activeRide.lockStatus === 'locked' ? t('bike.temporaryUnlock') : t('bike.temporaryLock')}
                onPress={toggleLock}
                loading={lockBusy}
                variant={activeRide.lockStatus === 'locked' ? 'primary' : 'outline'}
                icon={activeRide.lockStatus === 'locked' ? 'lock-open-outline' : 'lock-closed-outline'}
                style={{ flex: 1 }}
              />
              <Btn label={t('bike.finish')} onPress={() => finishRide(false)} loading={finishing} variant="dark" icon="checkmark" style={{ flex: 1 }} />
            </Row>
            <Btn label="Finish outside zone (geofence test)" onPress={() => finishRide(true)} variant="ghost" size="sm" />
          </Card>
        </View>
      </Screen>
    );
  }

  if (completedRide) {
    const breakdown = completedRide.fareBreakdown;
    const isViolation = completedRide.geofenceViolation === true;
    const paid = completedRide.paymentStatus === 'paid';
    return (
      <Screen scroll>
        <View style={{ padding: Spacing.lg, gap: Spacing.md }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Btn label={t('common.back')} onPress={() => setCompletedRide(null)} variant="subtle" size="sm" icon="arrow-back" />
            <Text style={styles.title}>{t('bike.fare')}</Text>
            <Btn label={t('bike.viewHistory')} variant="ghost" size="sm" onPress={() => router.push('/bike/history' as any)} />
          </Row>

          <Card style={{ gap: Spacing.md }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.name}>{completedRide.bikeCode}</Text>
              <StatusPill status={completedRide.status} />
            </Row>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.meta}>{t('bike.startedAt', { t: fullDateISO(completedRide.startAt) })}</Text>
              <Text style={styles.meta}>{completedRide.endAt ? t('bike.endedAt', { t: fullDateISO(completedRide.endAt) }) : null}</Text>
            </Row>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.meta}>{completedRide.durationMinutes ? t('bike.duration', { n: completedRide.durationMinutes }) : null}</Text>
              <Text style={styles.meta}>{completedRide.distanceKm ? t('bike.distanceLabel', { n: completedRide.distanceKm.toFixed(1) }) : null}</Text>
            </Row>
            {isViolation ? (
              <View style={[styles.warningBox, { backgroundColor: Colors.warningSoft, borderColor: Colors.warning }]}>
                <Row gap={Spacing.sm}>
                  <Icon name="warning-outline" size={18} color={Colors.warning} />
                  <Text style={[styles.meta, { color: Colors.text, flex: 1, fontFamily: Fonts.sansSemibold }]}>{t('bike.geofenceViolation')}</Text>
                </Row>
                <Text style={[styles.meta, { marginTop: Spacing.xs }]}>{t('bike.geofenceNote')}</Text>
              </View>
            ) : null}
            <Divider />
            <Text style={styles.sectionLabel}>{t('bike.fareBreakdown')}</Text>
            {breakdown ? (
              <View style={{ gap: Spacing.sm }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={styles.meta}>{t('bike.unlockFee')}</Text>
                  <Text style={styles.value}>{formatTZS(breakdown.unlockFeeTZS)}</Text>
                </Row>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={styles.meta}>{t('breakdown.subtotal')}</Text>
                  <Text style={styles.value}>{formatTZS(breakdown.rideFeeTZS)}</Text>
                </Row>
                {breakdown.geofenceSurchargeTZS > 0 ? (
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Text style={[styles.meta, { color: Colors.warning }]}>{t('bike.geofenceSurcharge')}</Text>
                    <Text style={[styles.value, { color: Colors.warning }]}>{formatTZS(breakdown.geofenceSurchargeTZS)}</Text>
                  </Row>
                ) : null}
                <Divider />
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={[styles.name, { fontFamily: Fonts.sansBold }]}>{t('breakdown.total')}</Text>
                  <MoneyText amountTZS={breakdown.totalTZS} size={FontSize.lg} bold />
                </Row>
              </View>
            ) : (
              <MoneyText amountTZS={completedRide.fareTZS ?? 0} size={FontSize.xxl} bold />
            )}
            {!paid && completedRide.fareTZS ? (
              <>
                <Text style={styles.sectionLabel}>{t('checkout.payment')}</Text>
                <Row gap={Spacing.sm} style={{ flexWrap: 'wrap' }}>
                  {['wallet', 'mpesa', 'tigo_pesa', 'card'].map((m) => (
                    <Chip key={m} label={m === 'wallet' ? 'Wallet' : m === 'mpesa' ? 'M-Pesa' : m === 'tigo_pesa' ? 'Tigo Pesa' : 'Card'} selected={payMethod === m} onPress={() => setPayMethod(m)} />
                  ))}
                </Row>
                <Btn label={t('bike.pay', { amount: formatTZS(completedRide.fareTZS) })} onPress={payFare} loading={paying} size="lg" />
              </>
            ) : paid ? (
              <View style={[styles.successBox, { backgroundColor: Colors.successSoft }]}>
                <Row gap={Spacing.sm}>
                  <Icon name="checkmark-circle" size={18} color={Colors.success} />
                  <Text style={[styles.meta, { color: Colors.success, fontFamily: Fonts.sansSemibold }]}>{t('bike.paySuccess')}</Text>
                </Row>
              </View>
            ) : null}
          </Card>

          <Btn label={t('common.done')} onPress={() => setCompletedRide(null)} variant="outline" />
        </View>
      </Screen>
    );
  }

  if (!bikes) {
    return (
      <Screen>
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={4} />
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg }}>
        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.sm }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <Text style={styles.title}>{t('bike.title')}</Text>
          <Btn label={t('bike.viewHistory')} variant="ghost" size="sm" onPress={() => router.push('/bike/history' as any)} />
        </Row>
        <Text style={styles.sub}>{t('bike.subtitle')}</Text>
      </View>

      <FlatList
        data={bikes}
        keyExtractor={(b) => b.id}
        showsVerticalScrollIndicator={false}
        onRefresh={load}
        refreshing={false}
        contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 120, gap: Spacing.md }}
        ListHeaderComponent={
          <View style={{ gap: Spacing.md }}>
            <MapView
              center={center}
              marker={center}
              bikePins={bikePins}
              selectedBikeIndex={selectedIndex >= 0 ? selectedIndex : null}
              userLocation={center}
              interactive
              height={200}
              label={t('bike.mapA11y')}
            />
            <Text style={styles.meta}>
              {t('map.coordinates')}: {center.lat.toFixed(5)}, {center.lon.toFixed(5)} · {t('bike.nearby')} · {GEOFENCE_RADIUS_KM} km zone
            </Text>

            <Card style={{ gap: Spacing.md }}>
              <Text style={styles.sectionLabel}>{t('bike.scanToUnlock')}</Text>
              <Row gap={Spacing.sm} style={{ alignItems: 'flex-end' }}>
                <View style={{ flex: 1 }}>
                  <Field label={t('bike.qrField')} value={qr} onChangeText={(v) => { setQr(v); setQrError(''); }} placeholder={BIKE_QR_EXAMPLE} autoCapitalize="none" />
                  {qrError ? <Text style={styles.errorText}>{qrError}</Text> : null}
                </View>
                <Btn label={t('bike.scan')} onPress={() => setScannerOpen(true)} icon="scan-outline" style={{ marginBottom: 2 }} />
              </Row>
              <Btn label={t('bike.bluetoothUnlock')} onPress={onManualUnlock} loading={unlocking} icon="bluetooth" />
              <Text style={styles.hint}>{t('bike.manualHint')}</Text>
            </Card>

            <QrScanner
              visible={scannerOpen}
              onClose={() => setScannerOpen(false)}
              onScan={onScan}
              filter={(payload) => !!parseBikeQr(payload)}
              title={t('bike.scan')}
              hint={t('bike.scanHint')}
            />

            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.sectionLabel}>{t('bike.nearby')}</Text>
              <Text style={styles.meta}>{bikes.length} bikes</Text>
            </Row>
          </View>
        }
        ListEmptyComponent={<EmptyState icon="bicycle-outline" title={t('bike.noBikes')} />}
        renderItem={({ item }) => {
          const isSelected = item.id === selectedId;
          const isAvailable = item.status === 'available';
          return (
            <Pressable
              onPress={() => setSelectedId(item.id)}
              accessibilityRole="button"
              accessibilityLabel={t(item.type === 'ebike' ? 'bike.ebikeA11y' : 'bike.bikeA11y', { code: item.code, battery: item.batteryPct ?? 0 } as any)}
              style={({ pressed }) => [styles.bikeCard, isSelected && styles.bikeCardSelected, pressed && { opacity: 0.88 }]}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Row gap={Spacing.sm} style={{ flex: 1 }}>
                  <View style={[styles.badge, { backgroundColor: isSelected ? Colors.primarySoft : Colors.surface, borderColor: isSelected ? Colors.primary : Colors.border }]}>
                    <Icon name="bicycle" size={20} color={isSelected ? Colors.primaryDeep : Colors.textSecondary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Row gap={Spacing.sm} style={{ flexWrap: 'wrap' }}>
                      <Text style={[styles.name, isSelected && { color: Colors.primaryDeep }]}>{item.code}</Text>
                      <Pill label={item.type === 'ebike' ? 'E-bike' : 'Bike'} tone={item.type === 'ebike' ? 'warning' : 'neutral'} />
                      <StatusPill status={item.status} />
                    </Row>
                    <Row gap={Spacing.sm} style={{ marginTop: 4, flexWrap: 'wrap' }}>
                      <Text style={styles.meta}>{formatDistance(item.distanceM)}</Text>
                      {item.batteryPct !== undefined ? <Text style={styles.meta}>{t('bike.battery', { n: item.batteryPct })}</Text> : null}
                      <Text style={styles.meta}>{formatTZS(item.pricePerMinuteTZS)}{t('common.perHour').replace('/hr', '/min')}</Text>
                    </Row>
                    <Text style={styles.meta}>{t('bike.unlockFee', { amount: formatTZS(item.unlockFeeTZS) })} · {item.type === 'ebike' ? t('bike.pricePerMinute', { amount: formatTZS(item.pricePerMinuteTZS) }) : t('bike.pricePerMinute', { amount: formatTZS(item.pricePerMinuteTZS) })}</Text>
                  </View>
                </Row>
                {isSelected ? <Icon name="checkmark-circle" size={20} color={Colors.primary} /> : null}
              </Row>
              {isSelected ? (
                <Btn
                  label={isAvailable ? t('bike.unlock') : t(bikeStatusTone(item.status) === 'danger' ? 'bike.disabled' : 'bike.notAvailable')}
                  onPress={onSelectUnlock}
                  disabled={!isAvailable}
                  loading={unlocking}
                  size="sm"
                  icon="lock-open-outline"
                  style={{ marginTop: Spacing.md, alignSelf: 'flex-start' }}
                />
              ) : null}
            </Pressable>
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xl, fontFamily: Fonts.displayBold, color: Colors.text, textAlign: 'center', flex: 1 },
  sub: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sans, textAlign: 'center', marginBottom: Spacing.md },
  sectionLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sansSemibold, textTransform: 'uppercase', letterSpacing: 0.3 },
  name: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text },
  value: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansSemibold, fontVariant: ['tabular-nums'] },
  meta: { fontSize: FontSize.xs, color: Colors.textSecondary, fontFamily: Fonts.sans, marginTop: 2 },
  hint: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, textAlign: 'center' },
  errorText: { color: Colors.danger, fontSize: FontSize.xs, fontFamily: Fonts.sansSemibold, marginTop: Spacing.xs },
  badge: {
    width: 44,
    height: 44,
    borderRadius: Radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bikeCard: {
    backgroundColor: Colors.card,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  bikeCardSelected: {
    borderColor: Colors.primary,
    borderWidth: 1.5,
    backgroundColor: Colors.primarySoft,
  },
  warningBox: {
    borderRadius: Radius.md,
    borderWidth: 1,
    padding: Spacing.md,
    gap: Spacing.xs,
  },
  successBox: {
    borderRadius: Radius.md,
    padding: Spacing.md,
  },
});
