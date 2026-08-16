/* Travel vertical — search intercity departures (bus / ferry / flight) and
 * book seats. Contract surface: GET /travel/options, POST /travel/bookings
 * (idempotent). Date is a local day serialized as YYYY-MM-DD (toISODate);
 * the mock schedules the seeded routes on the requested date.
 *
 * Duration is DISPLAY-only, computed client-side from the two server
 * timestamps (arrival − departure) — the house no-ETA rule governs delivery
 * promises, not this static schedule math. */
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Btn, Card, Chip, EmptyState, ErrorState, Field, Icon, MoneyText, Pill, Row, Screen, SheetModal, SkeletonCard, type IconName } from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, type I18nKey } from '@/i18n';
import { formatTZS, minutesLabel } from '@/lib/format';
import { ApiError } from '@/api/client';
import { fullDateISO, toISODate } from '@/lib/dates';
import { idempotencyKey } from '@/lib/idempotency';
import { getHomeRepository, getTravelRepository } from '@/repos';
import { toast } from '@/store/ui';
import type { City, TravelOption, TravelOptionMode } from '@hudumika/contract';

const PHONE_RE = /^\+255[67]\d{8}$/;
const MAX_PASSENGERS = 20;

/* Mock-only until the contract adds 'train' to TravelOptionMode: the chip
 * row offers Train and the mode value rides through the repository as a
 * string (mock serves it; the live API forwards it in the query string). */
type ModeFilter = 'all' | TravelOptionMode | 'train';
type PickerTarget = 'origin' | 'destination';

const DATE_OFFSET_DAYS = [0, 1, 2, 3];
const DATE_LABEL_KEYS: I18nKey[] = ['travel.today', 'travel.tomorrow', 'travel.inDays', 'travel.inDays'];
const MODES: { key: ModeFilter; icon: IconName }[] = [
  { key: 'all', icon: 'navigate-outline' },
  { key: 'bus', icon: 'bus' },
  { key: 'ferry', icon: 'boat' },
  { key: 'flight', icon: 'airplane' },
  { key: 'train', icon: 'train-outline' },
];

function modeIcon(mode?: TravelOptionMode): IconName {
  if (mode === 'bus') return 'bus';
  if (mode === 'ferry') return 'boat';
  if (mode === 'flight') return 'airplane';
  if (mode === 'train') return 'train-outline';
  return 'navigate-outline';
}

function durationMinutes(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60000));
}

function seatsTone(seats: number): 'success' | 'warning' | 'danger' {
  if (seats <= 5) return 'danger';
  if (seats <= 10) return 'warning';
  return 'success';
}

export default function TravelScreen() {
  const router = useRouter();
  const [cities, setCities] = useState<City[] | null>(null);
  const [cityError, setCityError] = useState('');
  const [originId, setOriginId] = useState('');
  const [destinationId, setDestinationId] = useState('');
  const [pickerFor, setPickerFor] = useState<PickerTarget | null>(null);
  const [dateIndex, setDateIndex] = useState(0);
  const [mode, setMode] = useState<ModeFilter>('all');
  const [options, setOptions] = useState<TravelOption[] | null>(null);
  const [error, setError] = useState('');
  const [searching, setSearching] = useState(false);

  // Booking sheet state.
  const [bookOption, setBookOption] = useState<TravelOption | null>(null);
  const [passengers, setPassengers] = useState(1);
  const [phone, setPhone] = useState('');
  const [bookError, setBookError] = useState('');
  const [bookingBusy, setBookingBusy] = useState(false);

  const loadCities = useCallback(async () => {
    setCityError('');
    try {
      const list = await getHomeRepository().listCities();
      setCities(list);
      // Dar es Salaam is the hub for every seeded route — a sensible default origin.
      const dar = list.find((c) => c.id === 'city_dar');
      setOriginId((prev) => prev || dar?.id || list[0]?.id || '');
    } catch {
      setCityError(t('common.error'));
    }
  }, []);

  useEffect(() => {
    loadCities();
  }, [loadCities]);

  const searchDate = () => toISODate(new Date(Date.now() + DATE_OFFSET_DAYS[dateIndex] * 86400_000));

  const onSearch = useCallback(async () => {
    if (!originId || !destinationId) return;
    setSearching(true);
    setError('');
    try {
      const result = await getTravelRepository().search({
        originCityId: originId,
        destinationCityId: destinationId,
        date: searchDate(),
        // Mock-only cast until the contract adds 'train' to TravelOptionMode:
        // the value flows through as a string; the mock serves the seeded
        // train departure and the live API forwards it in the query string.
        mode: mode === 'all' ? undefined : (mode as TravelOption['mode']),
      });
      setOptions(result);
    } catch {
      setOptions(null);
      setError(t('common.error'));
    } finally {
      setSearching(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originId, destinationId, mode, dateIndex]);

  const pickCity = (city: City) => {
    if (pickerFor === 'origin') {
      setOriginId(city.id);
      if (destinationId === city.id) setDestinationId('');
    } else if (pickerFor === 'destination') {
      setDestinationId(city.id);
    }
    setPickerFor(null);
  };

  const openBook = (option: TravelOption) => {
    setBookOption(option);
    setPassengers(1);
    setPhone('');
    setBookError('');
  };

  const onBook = async () => {
    if (!bookOption) return;
    if (!PHONE_RE.test(phone.trim())) {
      setBookError(t('login.invalidPhone'));
      return;
    }
    setBookError('');
    setBookingBusy(true);
    try {
      await getTravelRepository().book(
        { travelOptionId: bookOption.id, passengers, contactPhone: phone.trim() },
        idempotencyKey('cus_1', 'travel-book'),
      );
      setBookOption(null);
      toast(t('travel.booked'));
      router.push('/travel-bookings');
    } catch (e) {
      setBookError(e instanceof ApiError ? e.message : t('common.error'));
    } finally {
      setBookingBusy(false);
    }
  };

  const pickerCities = (pickerFor ?? 'origin') === 'origin' ? (cities ?? []).filter((c) => c.id !== destinationId) : (cities ?? []).filter((c) => c.id !== originId);

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.title}>{t('travel.title')}</Text>
        <Btn label={t('travel.myBookings')} variant="ghost" size="sm" onPress={() => router.push('/travel-bookings')} />
      </View>

      <View style={{ paddingHorizontal: Spacing.lg, gap: Spacing.md }}>
        {cityError ? <ErrorState message={cityError} onRetry={loadCities} /> : null}

        {!cities && !cityError ? <SkeletonCard rows={3} /> : null}

        {cities && cities.length > 0 ? (
          <>
            <Row gap={Spacing.sm}>
              <Pressable
                style={styles.cityField}
                onPress={() => setPickerFor('origin')}
                accessibilityRole="button"
                accessibilityLabel={t('travel.chooseOrigin')}>
                <Icon name="arrow-up-circle-outline" size={16} color={Colors.primaryDeep} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.fieldCaption}>{t('travel.origin')}</Text>
                  <Text style={styles.fieldValue}>{cities.find((c) => c.id === originId)?.name ?? t('travel.chooseOrigin')}</Text>
                </View>
                <Icon name="chevron-down" size={14} color={Colors.textFaint} />
              </Pressable>
              <Pressable
                style={styles.cityField}
                onPress={() => setPickerFor('destination')}
                accessibilityRole="button"
                accessibilityLabel={t('travel.chooseDestination')}>
                <Icon name="arrow-down-circle-outline" size={16} color={Colors.primaryDeep} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.fieldCaption}>{t('travel.destination')}</Text>
                  <Text style={styles.fieldValue}>{cities.find((c) => c.id === destinationId)?.name ?? t('travel.chooseDestination')}</Text>
                </View>
                <Icon name="chevron-down" size={14} color={Colors.textFaint} />
              </Pressable>
            </Row>

            <View style={{ gap: Spacing.xs }}>
              <Text style={styles.sectionLabel}>{t('travel.date')}</Text>
              <Row gap={Spacing.sm}>
                {DATE_OFFSET_DAYS.map((offset, i) => (
                  <Chip
                    key={offset}
                    label={t(DATE_LABEL_KEYS[i], { n: offset })}
                    selected={dateIndex === i}
                    onPress={() => setDateIndex(i)}
                  />
                ))}
              </Row>
            </View>

            <View style={{ gap: Spacing.xs }}>
              <Text style={styles.sectionLabel}>{t('travel.mode')}</Text>
              <Row gap={Spacing.sm}>
                {MODES.map((m) => (
                  <Chip key={m.key} label={m.key === 'all' ? t('travel.mode.all') : t(`travel.mode.${m.key}` as I18nKey)} selected={mode === m.key} onPress={() => setMode(m.key)} />
                ))}
              </Row>
            </View>

            <Btn
              label={t('travel.search')}
              icon="search"
              size="lg"
              loading={searching}
              disabled={!originId || !destinationId || searching}
              onPress={onSearch}
            />
          </>
        ) : null}
      </View>

      {error ? (
        <View style={styles.body}>
          <ErrorState message={error} onRetry={onSearch} />
        </View>
      ) : searching ? (
        <View style={styles.body}>
          <SkeletonCard rows={2} />
          <SkeletonCard rows={2} />
        </View>
      ) : options === null ? (
        <View style={styles.body} />
      ) : options.length === 0 ? (
        <View style={styles.body}>
          <EmptyState icon="airplane-outline" title={t('travel.noOptions')} />
        </View>
      ) : (
        <View style={styles.body}>
          <Text style={styles.sectionLabel}>{t('travel.search')}</Text>
          {options.map((o) => (
            <Card key={o.id} style={styles.card}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Row gap={Spacing.sm} style={{ flex: 1 }}>
                  <View style={styles.modeIcon}>
                    <Icon name={modeIcon(o.mode)} size={16} color={Colors.textSecondary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.providerName} numberOfLines={1}>{o.provider ?? t(`travel.mode.${o.mode}` as I18nKey)}</Text>
                    <Text style={styles.meta}>{t(`travel.mode.${o.mode}` as I18nKey)}</Text>
                  </View>
                </Row>
                <MoneyText amountTZS={o.priceTZS} size={FontSize.md} bold />
              </Row>
              <Row style={{ justifyContent: 'space-between', marginTop: Spacing.sm }}>
                <Text style={styles.route} numberOfLines={1}>{o.originCityName ?? '—'} → {o.destinationCityName ?? '—'}</Text>
                <Pill label={t('travel.seatsLeft', { n: o.seatsAvailable })} tone={seatsTone(o.seatsAvailable)} />
              </Row>
              <Row style={{ justifyContent: 'space-between', marginTop: Spacing.xs }}>
                <Text style={styles.meta}>{t('travel.departure')} {fullDateISO(o.departureAt)}</Text>
                <Text style={styles.meta}>{t('travel.arrival')} {fullDateISO(o.arrivalAt)}</Text>
              </Row>
              <Text style={styles.meta}>{t('travel.duration')} {minutesLabel(durationMinutes(o.departureAt, o.arrivalAt))} · {t('travel.pricePerPassenger', { amount: formatTZS(o.priceTZS) })}</Text>
              <Btn label={t('travel.book')} onPress={() => openBook(o)} size="sm" style={{ marginTop: Spacing.md, alignSelf: 'flex-start' }} />
            </Card>
          ))}
        </View>
      )}

      <SheetModal visible={pickerFor !== null} onClose={() => setPickerFor(null)} title={pickerFor === 'origin' ? t('travel.chooseOrigin') : t('travel.chooseDestination')}>
        {pickerFor !== null ? (
          <View style={{ gap: Spacing.sm }}>
            {pickerCities.length === 0 ? (
              <EmptyState icon="location-outline" title={t('onboard.none')} />
            ) : (
              pickerCities.map((city) => {
                const active = (pickerFor === 'origin' ? originId : destinationId) === city.id;
                return (
                  <Pressable
                    key={city.id}
                    onPress={() => pickCity(city)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    style={({ pressed }) => [styles.pickerRow, active && styles.pickerRowActive, pressed && { opacity: 0.85 }]}>
                    <Icon name={active ? 'radio-button-on' : 'radio-button-off'} size={18} color={active ? Colors.primary : Colors.borderStrong} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.pickerName}>{city.name}</Text>
                      <Text style={styles.meta}>{(city.serviceAreas ?? []).map((a) => a.name).join(' · ') || city.country}</Text>
                    </View>
                  </Pressable>
                );
              })
            )}
          </View>
        ) : null}
      </SheetModal>

      <SheetModal visible={bookOption !== null} onClose={() => setBookOption(null)} title={t('travel.book')}>
        {bookOption ? (
          <>
            <Text style={styles.route} numberOfLines={1}>{bookOption.originCityName ?? '—'} → {bookOption.destinationCityName ?? '—'}</Text>
            <Text style={styles.meta}>
              {fullDateISO(bookOption.departureAt)} · {t(`travel.mode.${bookOption.mode}` as I18nKey)} · {bookOption.provider}
            </Text>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.fieldCaption}>{t('travel.passengers')}</Text>
              <Row gap={Spacing.sm}>
                <Pressable
                  onPress={() => setPassengers((p) => Math.max(1, p - 1))}
                  disabled={passengers <= 1}
                  accessibilityRole="button"
                  accessibilityLabel={t('travel.decrease')}
                  style={[styles.stepper, passengers <= 1 && styles.stepperDisabled]}>
                  <Icon name="remove" size={16} color={passengers <= 1 ? Colors.textFaint : Colors.text} />
                </Pressable>
                <Text style={styles.count} accessibilityLabel={`${passengers}`}>{passengers}</Text>
                <Pressable
                  onPress={() => setPassengers((p) => Math.min(MAX_PASSENGERS, p + 1))}
                  disabled={passengers >= MAX_PASSENGERS}
                  accessibilityRole="button"
                  accessibilityLabel={t('travel.increase')}
                  style={[styles.stepper, passengers >= MAX_PASSENGERS && styles.stepperDisabled]}>
                  <Icon name="add" size={16} color={passengers >= MAX_PASSENGERS ? Colors.textFaint : Colors.text} />
                </Pressable>
              </Row>
            </Row>
            <Field
              label={t('travel.contactPhone')}
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
              maxLength={20}
              placeholder="+255700000000"
            />
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.totalLabel}>{t('travel.total')} · {t('travel.pricePerPassenger', { amount: formatTZS(bookOption.priceTZS) })}</Text>
              <MoneyText amountTZS={bookOption.priceTZS * passengers} size={FontSize.lg} bold />
            </Row>
            {bookError ? <Text style={styles.error}>{bookError}</Text> : null}
            <Btn label={t('travel.bookAndPay')} onPress={onBook} loading={bookingBusy} size="lg" />
          </>
        ) : null}
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text },
  sectionLabel: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sansSemibold, marginTop: Spacing.sm },
  body: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg },
  card: { marginBottom: Spacing.md },
  cityField: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    backgroundColor: Colors.card,
  },
  fieldCaption: { fontSize: FontSize.xs, color: Colors.textFaint, fontFamily: Fonts.sansMedium },
  fieldValue: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansSemibold, marginTop: 1 },
  modeIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  providerName: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  route: { fontSize: FontSize.md, fontFamily: Fonts.sansBold, color: Colors.text, flexShrink: 1 },
  stepper: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.card,
  },
  stepperDisabled: { opacity: 0.45 },
  count: { fontSize: FontSize.lg, fontFamily: Fonts.displayBold, color: Colors.text, minWidth: 28, textAlign: 'center', fontVariant: ['tabular-nums'] },
  totalLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sansMedium, flexShrink: 1 },
  error: { color: Colors.danger, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.lg,
    backgroundColor: Colors.card,
  },
  pickerRowActive: { borderColor: Colors.primary, borderWidth: 1.5 },
  pickerName: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text },
});
