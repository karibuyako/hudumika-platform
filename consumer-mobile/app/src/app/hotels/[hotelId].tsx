/* Hotel detail — GET /hotels/{hotelId}: header (name, stars, rating, address),
 * description, rooms with per-night rates and a booking sheet (dates presets,
 * guests, contact phone, nights × rate summary) → POST /hotel-bookings
 * (idempotency key) → /hotel-bookings/{id}. */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  Btn,
  Card,
  Divider,
  ErrorState,
  Field,
  Icon,
  MoneyText,
  Pill,
  Row,
  Screen,
  SheetModal,
  SkeletonCard,
} from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, formatTZS } from '@/i18n';
import { idempotencyKey } from '@/lib/idempotency';
import { toast } from '@/store/ui';
import { getHotelsRepository } from '@/repos';
import type { HotelBooking, HotelDetail, HotelRoom } from '@hudumika/contract';
import { ApiError } from '@/api/client';

const p2 = (n: number) => String(n).padStart(2, '0');

/** Local calendar day as YYYY-MM-DD (contract hotel dates are date strings). */
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

function starsLabel(stars?: number): string {
  return '★'.repeat(Math.max(0, Math.min(5, stars ?? 0)));
}

export default function HotelDetailScreen() {
  const router = useRouter();
  const { hotelId } = useLocalSearchParams<{ hotelId: string }>();
  const [detail, setDetail] = useState<HotelDetail | null>(null);
  const [error, setError] = useState('');
  const [bookOpen, setBookOpen] = useState(false);
  const [selectedRoom, setSelectedRoom] = useState<HotelRoom | null>(null);
  const [busy, setBusy] = useState(false);
  const [bookError, setBookError] = useState('');

  // Booking sheet state.
  const [today] = useState(() => new Date());
  const [checkInOffset, setCheckInOffset] = useState(0);
  const [nights, setNights] = useState(1);
  const [guests, setGuests] = useState(2);
  const [phone, setPhone] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setDetail(await getHotelsRepository().get(hotelId));
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? t('hotels.notFound') : t('common.error'));
    }
  }, [hotelId]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openBooking = (room: HotelRoom) => {
    setSelectedRoom(room);
    setBookError('');
    setCheckInOffset(0);
    setNights(1);
    setGuests(Math.min(2, room.capacity));
    setPhone('');
    setBookOpen(true);
  };

  const book = async () => {
    if (!selectedRoom) return;
    setBusy(true);
    setBookError('');
    try {
      const checkIn = isoDate(addDays(today, checkInOffset));
      const checkOut = isoDate(addDays(today, checkInOffset + nights));
      const booking: HotelBooking = await getHotelsRepository().book(
        {
          hotelId,
          roomId: selectedRoom.id,
          checkIn,
          checkOut,
          guests,
          contactPhone: phone.trim() || undefined,
        },
        idempotencyKey('cus_1', 'hotel.book'),
      );
      setBookOpen(false);
      toast(t('hotels.booked'));
      router.push({ pathname: '/hotel-bookings/[bookingId]', params: { bookingId: booking.id } });
    } catch (e) {
      setBookError(e instanceof ApiError ? e.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (!detail) {
    return (
      <Screen>
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={3} />
          <SkeletonCard rows={4} />
        </View>
      </Screen>
    );
  }

  const { hotel, description, rooms } = detail;
  const selectedRateTZS = selectedRoom ? nights * selectedRoom.pricePerNightTZS : 0;

  // Homestay / apartment mock data — gate per spec: if (hotel.businessType === 'homestay' || hotel.businessName.toLowerCase().includes('apartment'))
  const hotelAny = hotel as unknown as { businessType?: string; businessName?: string };
  const isHomestay =
    hotelAny.businessType === 'homestay' ||
    hotelAny.businessType === 'apartment' ||
    (hotelAny.businessName ?? hotel.name).toLowerCase().includes('apartment');

  const homestayMock = {
    hostName: 'John Doe',
    houseRules: 'No smoking, Check-in after 3PM',
    selfCheckIn: 'Self-check-in with lockbox — access code sent after booking confirmation.',
    securityDepositTZS: 50000,
    longStayNote: 'Stay 7+ nights save 10% · 28+ nights save 18% — weekly & monthly discounts applied at checkout.',
  };

  return (
    <Screen scroll>
      <View style={{ padding: Spacing.lg }}>
        <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" style={{ alignSelf: 'flex-start', marginBottom: Spacing.md }} />

        <Text style={styles.title}>{hotel.name}</Text>
        <Row gap={Spacing.sm} style={{ marginTop: 4 }}>
          <Text style={styles.stars}>{starsLabel(hotel.starRating)}</Text>
          <Text style={styles.meta}>
            {hotel.rating.toFixed(1)} · {t('merchant.reviews', { n: hotel.reviewCount ?? 0 })}
          </Text>
        </Row>
        {hotel.addressLine ? <Text style={styles.meta}>{hotel.addressLine}</Text> : null}
        <Text style={styles.cityMeta}>{hotel.cityName ?? hotel.cityId}</Text>

        {description ? (
          <Card style={styles.card}>
            <Text style={styles.sectionLabel}>{t('hotels.title')}</Text>
            <Text style={styles.meta}>{description}</Text>
          </Card>
        ) : null}

        {isHomestay ? (
          <Card style={styles.card}>
            <Text style={styles.sectionLabel}>Homestay details</Text>

            <Row gap={Spacing.md} style={{ alignItems: 'center' }}>
              <View style={styles.hostAvatar}>
                <Icon name="person" size={20} color={Colors.white} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.value}>{homestayMock.hostName}</Text>
                <Text style={styles.meta}>Host · Superhost</Text>
              </View>
              <Pill label="Host" tone="info" />
            </Row>

            <Divider style={{ marginVertical: Spacing.sm }} />

            <Text style={styles.sectionLabel}>House rules</Text>
            <Text style={styles.meta}>{homestayMock.houseRules}</Text>

            <Text style={[styles.sectionLabel, { marginTop: Spacing.md }]}>Self-check-in</Text>
            <Text style={styles.meta}>{homestayMock.selfCheckIn}</Text>

            <Row style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: Spacing.md }}>
              <Text style={styles.sectionLabel}>Security deposit</Text>
              <MoneyText amountTZS={homestayMock.securityDepositTZS} bold />
            </Row>
            <Text style={styles.meta}>Refundable if no damage — held at check-in</Text>

            <Text style={[styles.sectionLabel, { marginTop: Spacing.md }]}>Long-stay pricing</Text>
            <Text style={styles.meta}>{homestayMock.longStayNote}</Text>

            <Row gap={Spacing.sm} style={{ marginTop: Spacing.sm, alignItems: 'center' }}>
              <Icon name="people" size={16} color={Colors.textSecondary} />
              <Text style={styles.meta}>Multiple guests allowed — up to room capacity</Text>
            </Row>
          </Card>
        ) : null}

        <Text style={styles.section}>{t('hotels.rooms')}</Text>
        <View style={{ gap: Spacing.md }}>
          {rooms.map((room) => (
            <Card key={room.id} style={styles.card}>
              <Row style={{ justifyContent: 'space-between' }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.roomName}>{room.name}</Text>
                  <Text style={styles.meta}>{t('hotels.capacity', { n: room.capacity })}</Text>
                  <Row gap={4} style={{ marginTop: Spacing.sm }}>
                    <Text style={styles.price}>{formatTZS(room.pricePerNightTZS)}{t('hotels.perNight')}</Text>
                  </Row>
                </View>
                <View style={{ alignItems: 'flex-end', gap: Spacing.sm }}>
                  <Pill
                    label={room.available === false ? t('hotels.unavailable') : t('hotels.available')}
                    tone={room.available === false ? 'danger' : 'success'}
                  />
                  <Btn
                    label={t('hotels.select')}
                    size="sm"
                    variant="ghost"
                    disabled={room.available === false}
                    onPress={() => openBooking(room)}
                  />
                </View>
              </Row>
            </Card>
          ))}
        </View>

        <SheetModal visible={bookOpen} onClose={() => setBookOpen(false)} title={selectedRoom?.name}>
          {selectedRoom ? (
            <>
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={styles.meta}>{t('hotels.room')}</Text>
                <Text style={styles.price}>{formatTZS(selectedRoom.pricePerNightTZS)}{t('hotels.perNight')}</Text>
              </Row>

              <Text style={styles.sectionLabel}>{t('hotels.checkIn')}</Text>
              <Row gap={Spacing.xs}>
                <ChipWrap label={t('hotels.today')} selected={checkInOffset === 0} onPress={() => setCheckInOffset(0)} />
                <ChipWrap label={t('hotels.tomorrow')} selected={checkInOffset === 1} onPress={() => setCheckInOffset(1)} />
              </Row>

              <Text style={styles.sectionLabel}>{t('hotels.nights', { n: nights })}</Text>
              <Row gap={Spacing.xs}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <ChipWrap key={n} label={String(n)} selected={nights === n} onPress={() => setNights(n)} />
                ))}
              </Row>

              <Text style={styles.sectionLabel}>{t('hotels.guests')}</Text>
              <Row gap={Spacing.sm}>
                <Pressable
                  onPress={() => setGuests((g) => Math.max(1, g - 1))}
                  disabled={guests <= 1}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.stepBtn, pressed && { opacity: 0.7 }]}>
                  <Icon name="remove" size={16} color={Colors.text} />
                </Pressable>
                <Text style={styles.stepValue}>{guests}</Text>
                <Pressable
                  onPress={() => setGuests((g) => Math.min(10, g + 1))}
                  disabled={guests >= 10}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.stepBtn, pressed && { opacity: 0.7 }]}>
                  <Icon name="add" size={16} color={Colors.text} />
                </Pressable>
                <Text style={styles.meta}>{t('hotels.capacity', { n: selectedRoom.capacity })}</Text>
              </Row>

              <Field
                label={t('hotels.contactPhone')}
                value={phone}
                onChangeText={setPhone}
                placeholder="+255…"
                keyboardType="phone-pad"
                maxLength={20}
              />

              <Divider />
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={styles.meta}>
                  {t('hotels.nights', { n: nights })} × {formatTZS(selectedRoom.pricePerNightTZS)}
                </Text>
                <MoneyText amountTZS={selectedRateTZS} bold />
              </Row>
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={styles.meta}>{t('hotels.checkIn')}</Text>
                <Text style={styles.value}>{isoDate(addDays(today, checkInOffset))}</Text>
              </Row>
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={styles.meta}>{t('hotels.checkOut')}</Text>
                <Text style={styles.value}>{isoDate(addDays(today, checkInOffset + nights))}</Text>
              </Row>

              {bookError ? <Text style={[styles.meta, { color: Colors.danger }]}>{bookError}</Text> : null}
              <Btn label={t('hotels.bookAndPay')} onPress={book} loading={busy} variant="success" />
            </>
          ) : null}
        </SheetModal>
      </View>
    </Screen>
  );
}

function ChipWrap({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.chip,
        selected && { backgroundColor: Colors.ink, borderColor: Colors.ink },
        pressed && { opacity: 0.8 },
      ]}>
      <Text style={[styles.chipText, selected && { color: Colors.white, fontFamily: Fonts.sansSemibold }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xl, fontFamily: Fonts.displayBold, color: Colors.text },
  stars: { color: Colors.gold, fontSize: FontSize.sm, letterSpacing: 1 },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  cityMeta: { fontSize: FontSize.xs, color: Colors.primaryDeep, fontFamily: Fonts.sansSemibold, marginTop: 2 },
  section: { fontSize: FontSize.lg, fontFamily: Fonts.sansExtraBold, color: Colors.text, marginTop: Spacing.lg, marginBottom: Spacing.sm },
  sectionLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sansSemibold, marginBottom: Spacing.xs },
  card: { gap: Spacing.sm },
  roomName: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text },
  price: { fontSize: FontSize.md, fontFamily: Fonts.sansBold, color: Colors.text },
  value: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansMedium },
  hostAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtn: {
    width: 30,
    height: 30,
    borderRadius: Radius.sm,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.borderStrong,
  },
  stepValue: { fontSize: FontSize.md, fontFamily: Fonts.sansBold, color: Colors.text, minWidth: 20, textAlign: 'center' },
  chip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    borderRadius: Radius.pill,
    backgroundColor: Colors.card,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
  },
  chipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sansMedium },
});
