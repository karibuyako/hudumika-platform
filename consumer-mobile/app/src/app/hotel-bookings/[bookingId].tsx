/* Hotel booking detail — the contract exposes NO GET /hotel-bookings/{id},
 * so the record is resolved from GET /hotel-bookings/me (mock + live both
 * serve it). Status pill, stay dates, nights, guests, totalTZS. Cancellation
 * is not shown as an action: the contract ships no cancel endpoint, so the
 * screen says so honestly instead of faking a button. */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  Btn,
  Card,
  Divider,
  ErrorState,
  Icon,
  MoneyText,
  Row,
  Screen,
  SkeletonCard,
  StatusPill,
} from '@/components/ui';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { getHotelsRepository } from '@/repos';
import type { HotelBooking } from '@hudumika/contract';

export default function HotelBookingDetailScreen() {
  const router = useRouter();
  const { bookingId } = useLocalSearchParams<{ bookingId: string }>();
  const [booking, setBooking] = useState<HotelBooking | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const mine = await getHotelsRepository().listMyBookings();
      const found = mine.find((b) => b.id === bookingId);
      if (!found) {
        setError(t('hotels.bookingNotFound'));
        return;
      }
      setBooking(found);
    } catch {
      setError(t('common.error'));
    }
  }, [bookingId]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (!booking) {
    return (
      <Screen>
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={3} />
          <SkeletonCard rows={4} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={{ padding: Spacing.lg, flex: 1 }}>
        <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" style={{ alignSelf: 'flex-start', marginBottom: Spacing.md }} />

        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Text style={styles.title}>{booking.hotelName ?? booking.hotelId}</Text>
          <StatusPill status={booking.status} />
        </Row>

        <Card style={{ gap: Spacing.md }}>
          <Row gap={Spacing.md}>
            <View style={styles.avatar}>
              <Icon name="bed" size={22} color={Colors.primaryDeep} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.value}>{booking.roomName ?? booking.roomId}</Text>
              <Text style={styles.meta}>{booking.hotelName ?? booking.hotelId}</Text>
            </View>
          </Row>
          <Divider />
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={styles.meta}>{t('hotels.checkIn')}</Text>
            <Text style={styles.value}>{booking.checkIn}</Text>
          </Row>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={styles.meta}>{t('hotels.checkOut')}</Text>
            <Text style={styles.value}>{booking.checkOut}</Text>
          </Row>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={styles.meta}>{t('hotels.nights', { n: booking.nights ?? 1 })}</Text>
            <Text style={styles.value}>{t('hotels.guests')}: {booking.guests}</Text>
          </Row>
          <Divider />
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={styles.meta}>{t('hotels.total')}</Text>
            <MoneyText amountTZS={booking.totalTZS} bold />
          </Row>
        </Card>

        {booking.status === 'pending_payment' ? (
          /* Vertical checkout shell — hotel booking paid from /hotel/checkout. */
          <Btn
            label={t('booking.payViaCheckout')}
            onPress={() => router.push({ pathname: '/hotel/checkout', params: { hotelBookingId: bookingId } })}
            variant="outline"
            style={{ marginTop: Spacing.lg }}
          />
        ) : null}

        <Card style={{ gap: Spacing.sm, backgroundColor: Colors.surface, marginTop: Spacing.lg }}>
          <Row gap={Spacing.sm}>
            <Icon name="information-circle-outline" size={18} color={Colors.textTertiary} />
            <Text style={styles.meta}>{t('hotels.cancelNote')}</Text>
          </Row>
        </Card>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xl, fontFamily: Fonts.displayBold, color: Colors.text, flex: 1, marginRight: Spacing.md },
  avatar: { width: 48, height: 48, borderRadius: 12, backgroundColor: Colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  value: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansMedium },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
});
