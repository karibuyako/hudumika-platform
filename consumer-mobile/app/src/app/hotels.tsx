/* Hotels — city-scoped search (GET /hotels) with check-in/check-out date
 * presets, a guests stepper, hotel cards (stars, rating, starting price) and
 * a "My hotels" section (GET /hotel-bookings/me → /hotel-bookings/{id}). */
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  Card,
  Chip,
  Divider,
  EmptyState,
  ErrorState,
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
import { getHotelsRepository } from '@/repos';
import { useLocationStore } from '@/store/location';
import type { Hotel, HotelBooking } from '@hudumika/contract';

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

export default function HotelsScreen() {
  const router = useRouter();
  const city = useLocationStore((s) => s.city);
  const [hotels, setHotels] = useState<Hotel[] | null>(null);
  const [bookings, setBookings] = useState<HotelBooking[] | null>(null);
  const [error, setError] = useState('');

  // Filters — kept local; the server (and mock) resolve availability.
  const [today] = useState(() => new Date());
  const [checkInOffset, setCheckInOffset] = useState(0); // 0 = today, 1 = tomorrow
  const [nights, setNights] = useState(1);
  const [guests, setGuests] = useState(2);

  const load = useCallback(async (cityId: string | undefined, offset: number, stayNights: number, partySize: number, baseDay: Date) => {
    setError('');
    try {
      const checkIn = isoDate(addDays(baseDay, offset));
      const checkOut = isoDate(addDays(baseDay, offset + stayNights));
      const [list, mine] = await Promise.all([
        getHotelsRepository().list({ cityId, checkIn, checkOut, guests: partySize }),
        getHotelsRepository().listMyBookings(),
      ]);
      setHotels(list.results);
      setBookings(mine);
    } catch {
      setError(t('common.error'));
    }
  }, []);

  useEffect(() => {
    void load(city?.id, checkInOffset, nights, guests, today);
  }, [city?.id, checkInOffset, nights, guests, today, load]);

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={() => void load(city?.id, checkInOffset, nights, guests, today)} />
      </Screen>
    );
  }

  const filterCard = (
    <Card style={styles.filterCard}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={styles.sectionLabel}>{t('hotels.checkIn')}</Text>
        <Text style={styles.sectionLabel}>{t('hotels.checkOut')}</Text>
      </Row>
      <Row style={{ justifyContent: 'space-between', gap: Spacing.sm }}>
        <Row gap={Spacing.xs} style={{ flex: 1, flexWrap: 'wrap' }}>
          <Chip label={t('hotels.today')} selected={checkInOffset === 0} onPress={() => setCheckInOffset(0)} />
          <Chip label={t('hotels.tomorrow')} selected={checkInOffset === 1} onPress={() => setCheckInOffset(1)} />
        </Row>
        <Row gap={Spacing.xs} style={{ flex: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {[1, 2, 3].map((n) => (
            <Chip key={n} label={t('hotels.nights', { n })} selected={nights === n} onPress={() => setNights(n)} />
          ))}
        </Row>
      </Row>
      <Divider style={{ marginVertical: Spacing.md }} />
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={styles.sectionLabel}>{t('hotels.guests')}</Text>
        <Row gap={Spacing.sm}>
          <Pressable
            onPress={() => setGuests((g) => Math.max(1, g - 1))}
            disabled={guests <= 1}
            accessibilityRole="button"
            accessibilityLabel={`${t('hotels.guests')} −`}
            style={({ pressed }) => [styles.stepBtn, pressed && { opacity: 0.7 }]}>
            <Icon name="remove" size={16} color={Colors.text} />
          </Pressable>
          <Text style={styles.stepValue}>{guests}</Text>
          <Pressable
            onPress={() => setGuests((g) => Math.min(10, g + 1))}
            disabled={guests >= 10}
            accessibilityRole="button"
            accessibilityLabel={`${t('hotels.guests')} +`}
            style={({ pressed }) => [styles.stepBtn, pressed && { opacity: 0.7 }]}>
            <Icon name="add" size={16} color={Colors.text} />
          </Pressable>
        </Row>
      </Row>
    </Card>
  );

  const myBookingsSection = bookings === null ? null : bookings.length > 0 ? (
    <>
      <Text style={styles.sectionLabel}>{t('hotels.myBookings')}</Text>
      {bookings.map((b) => (
        <Card
          key={b.id}
          style={styles.card}
          onPress={() => router.push({ pathname: '/hotel-bookings/[bookingId]', params: { bookingId: b.id } })}>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.hotelName} numberOfLines={1}>{b.hotelName ?? b.hotelId}</Text>
              <Text style={styles.meta}>
                {b.checkIn} → {b.checkOut} · {b.guests} {t('hotels.guests')}
              </Text>
            </View>
            <StatusPill status={b.status} />
          </Row>
          {b.totalTZS !== undefined ? <MoneyText amountTZS={b.totalTZS} size={FontSize.sm} bold /> : null}
        </Card>
      ))}
    </>
  ) : (
    <Card style={styles.card}>
      <Text style={styles.meta}>{t('hotels.bookingsEmpty')}</Text>
    </Card>
  );

  return (
    <Screen>
      <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg }}>
        <Text style={styles.title}>{t('hotels.title')}</Text>
        <Row gap={6} style={{ marginBottom: Spacing.md }}>
          <Icon name="location" size={14} color={Colors.primary} />
          <Text style={styles.cityLabel}>{city?.name ?? t('onboard.title')}</Text>
        </Row>
      </View>
      {!hotels ? (
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={3} />
          <SkeletonCard rows={2} />
          <SkeletonCard rows={2} />
        </View>
      ) : (
        <FlatList
          data={hotels}
          keyExtractor={(h) => h.id}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }}
          ListHeaderComponent={
            <>
              {filterCard}
              {myBookingsSection}
              <Text style={[styles.sectionLabel, { marginTop: Spacing.lg }]}>
                {city?.name ? `${t('hotels.title')} · ${city.name}` : t('hotels.title')}
              </Text>
            </>
          }
          ListEmptyComponent={
            <EmptyState icon="bed-outline" title={t('hotels.noHotels')} />
          }
          renderItem={({ item }) => (
            <Card
              style={styles.card}
              onPress={() => router.push(`/hotels/${item.id}`)}
              accessibilityRole="link"
              accessibilityLabel={item.name}>
              <Row style={{ justifyContent: 'space-between' }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.hotelName} numberOfLines={1}>{item.name}</Text>
                  <Row gap={Spacing.sm} style={{ marginTop: 4 }}>
                    <Text style={styles.stars}>{starsLabel(item.starRating)}</Text>
                    {item.starRating ? <Text style={styles.meta}>{item.starRating}.0</Text> : null}
                    <Text style={styles.meta}>
                      {item.rating.toFixed(1)} · {t('merchant.reviews', { n: item.reviewCount ?? 0 })}
                    </Text>
                  </Row>
                </View>
                <Icon name="chevron-forward" size={15} color={Colors.textFaint} />
              </Row>
              <Row gap={4} style={{ marginTop: Spacing.sm, flexWrap: 'wrap' }}>
                <Text style={styles.priceLabel}>{t('hotels.from')}</Text>
                <Text style={styles.price}>{formatTZS(item.startingPriceTZS)}{t('hotels.perNight')}</Text>
              </Row>
              <Text style={styles.meta}>{item.cityName ?? item.cityId}</Text>
              <Row gap={Spacing.xs} style={{ marginTop: Spacing.sm, flexWrap: 'wrap' }}>
                {(item.amenities ?? []).slice(0, 3).map((a) => (
                  <Pill key={a} label={a} tone="neutral" />
                ))}
              </Row>
            </Card>
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text, marginBottom: Spacing.sm },
  cityLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sansMedium },
  sectionLabel: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sansSemibold, marginBottom: Spacing.sm },
  filterCard: { gap: Spacing.sm, marginBottom: Spacing.lg },
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
  card: { marginBottom: Spacing.md },
  hotelName: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text },
  stars: { color: Colors.gold, fontSize: FontSize.sm, letterSpacing: 1 },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  priceLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sans },
  price: { fontSize: FontSize.md, fontFamily: Fonts.sansBold, color: Colors.text },
});
