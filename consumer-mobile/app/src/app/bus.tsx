/* Bus — Meituan bus parity: search route → origin → destination
 * → bus options (arrival time) → route (stops) → vehicle tracking
 * → stop reminders.
 *
 * Origin/destination are free-text stop names (case-insensitive substring);
 * the mock ranks the seeded Dar routes. Arrival times are server-owned
 * (nextArrivalMinutes / followingArrivalMinutes — never computed client-side).
 * Route view renders the server's stop list verbatim; vehicle tracking polls
 * every 15s (same cadence as order tracking). Stop reminders are idempotent
 * per key and ride the bus repo (mock-only until the contract ships the
 * surface — parity harness allow-list).
 */
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  Btn,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  MoneyText,
  Pill,
  Row,
  Screen,
  SheetModal,
  SkeletonCard,
} from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { formatTZS } from '@/lib/format';
import { ApiError } from '@/api/client';
import { idempotencyKey } from '@/lib/idempotency';
import { getBusRepository } from '@/repos';
import { toast } from '@/store/ui';
import type { BusOption, BusRoute, BusVehicle, StopReminder } from '@/repos';

function arrivalTone(minutes: number): 'success' | 'warning' | 'danger' {
  if (minutes <= 3) return 'success';
  if (minutes <= 8) return 'warning';
  return 'danger';
}

function arrivalLabel(minutes: number): string {
  if (minutes <= 1) return t('bus.arrivingNow');
  return t('bus.arrivesIn', { n: minutes });
}

function occupancyTone(o: BusVehicle['occupancy']): 'success' | 'warning' | 'danger' {
  if (o === 'low') return 'success';
  if (o === 'medium') return 'warning';
  return 'danger';
}

export default function BusScreen() {
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [options, setOptions] = useState<BusOption[] | null>(null);
  const [error, setError] = useState('');
  const [searching, setSearching] = useState(false);

  // Route detail + tracking state
  const [selected, setSelected] = useState<BusOption | null>(null);
  const [routeDetail, setRouteDetail] = useState<BusRoute | null>(null);
  const [vehicles, setVehicles] = useState<BusVehicle[] | null>(null);
  const [vehiclesError, setVehiclesError] = useState('');
  const [reminders, setReminders] = useState<StopReminder[] | null>(null);
  const [reminderBusyId, setReminderBusyId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const onSearch = useCallback(async () => {
    const o = origin.trim();
    const d = destination.trim();
    if (!o || !d) {
      setError(t('bus.needBoth'));
      return;
    }
    setSearching(true);
    setError('');
    try {
      const result = await getBusRepository().search({ origin: o, destination: d });
      setOptions(result);
    } catch (e) {
      setOptions(null);
      setError(e instanceof ApiError ? e.message : t('common.error'));
    } finally {
      setSearching(false);
    }
  }, [origin, destination]);

  const swap = () => {
    setOrigin(destination);
    setDestination(origin);
  };

  const openRoute = useCallback(async (option: BusOption) => {
    setSelected(option);
    setDetailOpen(true);
    setRouteDetail(null);
    setVehicles(null);
    setVehiclesError('');
    try {
      const [route, v, r] = await Promise.all([
        getBusRepository().getRoute(option.route.id),
        getBusRepository().getVehicles(option.route.id),
        getBusRepository().listReminders(),
      ]);
      setRouteDetail(route);
      setVehicles(v);
      setReminders(r);
    } catch (e) {
      setVehiclesError(e instanceof ApiError ? e.message : t('common.error'));
    }
  }, []);

  const refreshVehicles = useCallback(async () => {
    if (!selected) return;
    try {
      const v = await getBusRepository().getVehicles(selected.route.id);
      setVehicles(v);
    } catch {
      // transient poll failure — keep last-known
    }
  }, [selected]);

  useEffect(() => {
    if (!detailOpen || !selected) return;
    const timer = setInterval(() => void refreshVehicles(), 15000);
    return () => clearInterval(timer);
  }, [detailOpen, selected, refreshVehicles]);

  const toggleReminder = async (stopId: string, stopName: string) => {
    if (!selected) return;
    const key = `${selected.route.id}:${stopId}`;
    const exists = reminders?.some((r) => r.routeId === selected.route.id && r.stopId === stopId && r.enabled);
    setReminderBusyId(stopId);
    try {
      const result = await getBusRepository().setReminder(
        selected.route.id,
        stopId,
        !exists,
        idempotencyKey('cus_1', `bus-reminder-${key}`),
      );
      const next = await getBusRepository().listReminders();
      setReminders(next);
      if (result) toast(t('bus.remindSet', { stop: stopName }));
      else toast(t('bus.remindOff'));
    } catch (e) {
      toast(e instanceof ApiError ? e.message : t('common.error'), 'error');
    } finally {
      setReminderBusyId(null);
    }
  };

  const isReminded = (stopId: string): boolean =>
    !!reminders?.some((r) => r.routeId === (selected?.route.id ?? '') && r.stopId === stopId && r.enabled);

  return (
    <Screen scroll>
      <View style={styles.header}>
        <Text style={styles.title}>{t('bus.title')}</Text>
        <Text style={styles.subtitle}>{t('bus.subtitle')}</Text>
      </View>

      <Card style={styles.searchCard}>
        <View style={{ gap: Spacing.sm }}>
          <View style={styles.inputRow}>
            <View style={styles.inputIcon}>
              <Icon name="ellipse-outline" size={14} color={Colors.primaryDeep} />
            </View>
            <TextInput
              value={origin}
              onChangeText={setOrigin}
              placeholder={t('bus.originPlaceholder')}
              placeholderTextColor={Colors.textTertiary}
              accessibilityLabel={t('bus.origin')}
              style={styles.input}
              returnKeyType="next"
            />
          </View>
          <Row style={{ justifyContent: 'center' }}>
            <Pressable
              onPress={swap}
              accessibilityRole="button"
              accessibilityLabel={t('bus.swap')}
              style={({ pressed }) => [styles.swapBtn, pressed && { opacity: 0.7 }]}>
              <Icon name="swap-vertical" size={16} color={Colors.primaryDeep} />
              <Text style={styles.swapLabel}>{t('bus.swap')}</Text>
            </Pressable>
          </Row>
          <View style={styles.inputRow}>
            <View style={styles.inputIcon}>
              <Icon name="location" size={14} color={Colors.danger} />
            </View>
            <TextInput
              value={destination}
              onChangeText={setDestination}
              placeholder={t('bus.destinationPlaceholder')}
              placeholderTextColor={Colors.textTertiary}
              accessibilityLabel={t('bus.destination')}
              style={styles.input}
              returnKeyType="search"
              onSubmitEditing={onSearch}
            />
          </View>
        </View>
        <Btn
          label={t('bus.search')}
          icon="search"
          size="lg"
          loading={searching}
          disabled={!origin.trim() || !destination.trim() || searching}
          onPress={onSearch}
          style={{ marginTop: Spacing.md }}
        />
      </Card>

      {reminders && reminders.length > 0 ? (
        <View style={{ paddingHorizontal: Spacing.lg, marginTop: Spacing.md }}>
          <Text style={styles.sectionLabel}>{t('bus.reminders')}</Text>
          <Row gap={Spacing.sm} style={{ flexWrap: 'wrap' }}>
            {reminders.map((r) => (
              <Pill key={r.id} label={`${r.routeNumber} · ${r.stopName}`} tone="info" />
            ))}
          </Row>
        </View>
      ) : null}

      <View style={{ paddingHorizontal: Spacing.lg, marginTop: Spacing.lg }}>
        {error ? <ErrorState message={error} onRetry={onSearch} /> : null}

        {searching ? (
          <View style={{ gap: Spacing.md }}>
            <SkeletonCard rows={3} />
            <SkeletonCard rows={2} />
          </View>
        ) : options === null ? (
          !error ? (
            <EmptyState icon="bus-outline" title={t('bus.subtitle')} sub={t('bus.needBoth')} />
          ) : null
        ) : options.length === 0 ? (
          <EmptyState icon="bus-outline" title={t('bus.noOptions')} />
        ) : (
          <View style={{ gap: Spacing.md }}>
            <Text style={styles.sectionLabel}>{t('bus.route')}</Text>
            {options.map((opt) => (
              <Card key={opt.route.id} style={styles.optionCard} onPress={() => void openRoute(opt)}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Row gap={Spacing.sm} style={{ flex: 1 }}>
                    <View style={styles.routeBadge}>
                      <Icon name="bus" size={16} color={Colors.textSecondary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.routeNumber} numberOfLines={1}>
                        {opt.route.routeNumber} · {opt.route.routeName}
                      </Text>
                      <Text style={styles.meta} numberOfLines={1}>
                        {opt.route.origin} → {opt.route.destination} · {t('bus.stops', { n: opt.route.stops.length })}
                      </Text>
                    </View>
                  </Row>
                  <Pill label={arrivalLabel(opt.nextArrivalMinutes)} tone={arrivalTone(opt.nextArrivalMinutes)} />
                </Row>
                <Row style={{ justifyContent: 'space-between', marginTop: Spacing.sm }}>
                  <Text style={styles.meta}>
                    {opt.followingArrivalMinutes !== null ? t('bus.following', { n: opt.followingArrivalMinutes }) : '—'} ·{' '}
                    {t('bus.frequency', { n: opt.route.frequencyMinutes })}
                  </Text>
                  <MoneyText amountTZS={opt.route.fareTZS} size={FontSize.sm} bold />
                </Row>
                <Row style={{ justifyContent: 'space-between', marginTop: Spacing.xs }}>
                  <Text style={styles.meta}>
                    {t('bus.duration', { n: opt.route.durationMinutes })} · {t('bus.operatingHours', { hours: opt.route.operatingHours })}
                  </Text>
                  <Text style={styles.meta}>
                    {opt.vehicles.length} {t('bus.vehicles').toLowerCase()}
                  </Text>
                </Row>
                <Row gap={Spacing.sm} style={{ marginTop: Spacing.sm }}>
                  <Text style={styles.link}>{t('bus.viewRoute')} ›</Text>
                  {opt.vehicles.length > 0 ? <Text style={styles.link}>{t('bus.viewVehicles')} ›</Text> : null}
                </Row>
              </Card>
            ))}
          </View>
        )}
      </View>

      <SheetModal visible={detailOpen} onClose={() => setDetailOpen(false)} title={selected ? `${selected.route.routeNumber} · ${selected.route.routeName}` : t('bus.route')}>
        {selected ? (
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: Spacing.md, paddingBottom: Spacing.lg }}>
            {/* Fare + meta strip */}
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.meta}>
                {t('bus.fare', { amount: formatTZS(selected.route.fareTZS) })} · {t('bus.stops', { n: selected.route.stops.length })} ·{' '}
                {t('bus.frequency', { n: selected.route.frequencyMinutes })}
              </Text>
              <Text style={styles.meta}>{selected.route.operatingHours}</Text>
            </Row>

            {/* Route — stops timeline (server stop list verbatim) */}
            <View>
              <Text style={styles.sectionLabel}>{t('bus.stopsTitle')}</Text>
              {routeDetail ? (
                <Card style={{ gap: Spacing.sm }}>
                  {routeDetail.stops.map((stop, idx) => {
                    const reminded = isReminded(stop.id);
                    const busy = reminderBusyId === stop.id;
                    return (
                      <Row key={stop.id} gap={Spacing.md} style={{ alignItems: 'flex-start' }}>
                        <View style={styles.stopRail}>
                          <View style={[styles.stopDot, reminded && { backgroundColor: Colors.primary }]} />
                          {idx < routeDetail.stops.length - 1 ? <View style={styles.stopLine} /> : null}
                        </View>
                        <View style={{ flex: 1, paddingBottom: idx < routeDetail.stops.length - 1 ? Spacing.md : 0 }}>
                          <Row style={{ justifyContent: 'space-between' }}>
                            <Text style={[styles.stopName, reminded && { color: Colors.primaryDeep, fontFamily: Fonts.sansBold }]}>
                              {stop.sequence}. {stop.name}
                            </Text>
                            <Pressable
                              onPress={() => void toggleReminder(stop.id, stop.name)}
                              disabled={busy}
                              accessibilityRole="button"
                              accessibilityLabel={`${t('bus.reminder')} ${stop.name}`}
                              style={({ pressed }) => [
                                styles.reminderBtn,
                                reminded && styles.reminderBtnActive,
                                (pressed || busy) && { opacity: 0.7 },
                              ]}>
                              <Icon
                                name={reminded ? 'notifications' : 'notifications-outline'}
                                size={14}
                                color={reminded ? Colors.white : Colors.textSecondary}
                              />
                              <Text style={[styles.reminderLabel, reminded && { color: Colors.white }]}>
                                {reminded ? '✓' : t('bus.reminder')}
                              </Text>
                            </Pressable>
                          </Row>
                          <Text style={styles.meta}>
                            {stop.lat.toFixed(3)}, {stop.lon.toFixed(3)}
                          </Text>
                        </View>
                      </Row>
                    );
                  })}
                </Card>
              ) : vehiclesError ? (
                <ErrorState message={vehiclesError} onRetry={() => void openRoute(selected)} />
              ) : (
                <SkeletonCard rows={4} />
              )}
            </View>

            {/* Vehicle tracking — live positions (poll 15s) */}
            <View>
              <Text style={styles.sectionLabel}>{t('bus.tracking')}</Text>
              {vehiclesError ? (
                <ErrorState message={vehiclesError} onRetry={() => void openRoute(selected)} />
              ) : vehicles === null ? (
                <SkeletonCard rows={2} />
              ) : vehicles.length === 0 ? (
                <EmptyState icon="bus-outline" title={t('bus.noVehicles')} />
              ) : (
                <View style={{ gap: Spacing.md }}>
                  {vehicles.map((v) => (
                    <Card key={v.id} style={styles.vehicleCard}>
                      <Row style={{ justifyContent: 'space-between' }}>
                        <Row gap={Spacing.sm} style={{ flex: 1 }}>
                          <View style={styles.vehicleIcon}>
                            <Icon name="bus" size={16} color={Colors.primaryDeep} />
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.vehiclePlate} numberOfLines={1}>
                              {t('bus.vehicle', { plate: v.plateNumber })} · {v.routeNumber}
                            </Text>
                            <Text style={styles.meta} numberOfLines={1}>
                              {t('bus.nextStop', { name: v.nextStopName })} · {t(`bus.occupancy.${v.occupancy}` as const)}
                            </Text>
                          </View>
                        </Row>
                        <Pill
                          label={v.etaMinutes ? t('bus.eta', { n: v.etaMinutes }) : '—'}
                          tone={occupancyTone(v.occupancy)}
                        />
                      </Row>
                      <Text style={styles.meta}>
                        {v.lat.toFixed(4)}, {v.lon.toFixed(4)} · {t('bus.frequency', { n: v.etaMinutes ?? 0 })} · {new Date(v.lastUpdatedAt).toLocaleTimeString()}
                      </Text>
                    </Card>
                  ))}
                  <Btn label={t('common.retry')} variant="subtle" size="sm" onPress={() => void refreshVehicles()} icon="refresh" />
                </View>
              )}
            </View>
          </ScrollView>
        ) : null}
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text },
  subtitle: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  searchCard: { marginHorizontal: Spacing.lg, gap: Spacing.sm },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    backgroundColor: Colors.card,
    minHeight: 44,
  },
  inputIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    flex: 1,
    fontSize: FontSize.md,
    color: Colors.text,
    fontFamily: Fonts.sans,
    paddingVertical: 10,
  },
  swapBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.pill,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
  },
  swapLabel: { fontSize: FontSize.sm, color: Colors.primaryDeep, fontFamily: Fonts.sansMedium },
  sectionLabel: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sansSemibold, marginBottom: Spacing.sm },
  optionCard: { gap: Spacing.sm },
  routeBadge: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  routeNumber: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  link: { fontSize: FontSize.xs, color: Colors.primaryDeep, fontFamily: Fonts.sansSemibold },
  stopRail: { alignItems: 'center', width: 14, alignSelf: 'stretch' },
  stopDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: Colors.borderStrong },
  stopLine: { width: 2, flex: 1, minHeight: 18, backgroundColor: Colors.border, marginTop: 2 },
  stopName: { fontSize: FontSize.md, color: Colors.text, fontFamily: Fonts.sansMedium, flex: 1 },
  reminderBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 6,
    borderRadius: Radius.pill,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
  },
  reminderBtnActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  reminderLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontFamily: Fonts.sansMedium },
  vehicleCard: { gap: Spacing.sm },
  vehicleIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: Colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  vehiclePlate: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text },
});
