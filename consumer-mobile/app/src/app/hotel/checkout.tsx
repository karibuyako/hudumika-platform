import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Btn, Card, EmptyState, ErrorState, PriceBreakdown, Row, Screen, SkeletonCard } from '@/components/ui';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { getHotelsRepository } from '@/repos';
import type { HotelBooking } from '@hudumika/contract';

export default function HotelCheckoutScreen() {
  const router = useRouter();
  const { hotelBookingId } = useLocalSearchParams<{ hotelBookingId?: string }>();

  if (!hotelBookingId) {
    return (
      <Screen scroll>
        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <Text style={styles.title}>{t('checkout.title')}</Text>
        </Row>
        <View style={{ alignItems: 'center', marginBottom: Spacing.md }}>
          <View style={styles.typeChip}>
            <Text style={styles.typeChipText}>{t('checkout.type.hotel')}</Text>
          </View>
        </View>
        <EmptyState icon="receipt-outline" title={t('checkout.fromDetail')} actionLabel={t('common.back')} onAction={() => router.back()} />
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
        <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
        <Text style={styles.title}>{t('checkout.title')}</Text>
      </Row>
      <View style={{ alignItems: 'center', marginBottom: Spacing.md }}>
        <View style={styles.typeChip}>
          <Text style={styles.typeChipText}>{t('checkout.type.hotel')}</Text>
        </View>
      </View>
      <HotelCheckoutShell hotelBookingId={hotelBookingId} />
    </Screen>
  );
}

function HotelCheckoutShell({ hotelBookingId }: { hotelBookingId: string }) {
  const router = useRouter();
  const [booking, setBooking] = useState<HotelBooking | null>(null);
  const [loadError, setLoadError] = useState('');

  const load = useCallback(async () => {
    setLoadError('');
    setBooking(null);
    try {
      const mine = await getHotelsRepository().listMyBookings();
      const found = mine.find((b) => b.id === hotelBookingId);
      if (!found) {
        setLoadError(t('hotels.bookingNotFound'));
        return;
      }
      setBooking(found);
    } catch {
      setLoadError(t('common.error'));
    }
  }, [hotelBookingId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loadError) {
    return <ErrorState message={loadError} onRetry={load} />;
  }
  if (!booking) {
    return (
      <View style={{ gap: Spacing.md }}>
        <SkeletonCard rows={2} />
        <SkeletonCard rows={2} />
      </View>
    );
  }

  return (
    <>
      <Card style={styles.section}>
        <Text style={styles.sectionLabel}>{t('checkout.reviewTotal')}</Text>
        <PriceBreakdown
          rows={[{ label: `${booking.hotelName ?? booking.hotelId} — ${t('hotels.nights', { n: booking.nights ?? 1 })}`, amountTZS: booking.totalTZS }]}
          totalTZS={booking.totalTZS}
          totalLabel={t('breakdown.total')}
        />
      </Card>
      <EmptyState
        icon="bed-outline"
        title={t('checkout.fromDetail')}
        actionLabel={t('common.view')}
        onAction={() => router.push(`/hotel-bookings/${booking.id}`)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text, flex: 1, textAlign: 'center' },
  typeChip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Colors.primary,
    backgroundColor: Colors.primarySoft,
  },
  typeChipText: { fontSize: FontSize.xs, color: Colors.primaryDeep, fontFamily: Fonts.sansBold },
  section: { marginBottom: Spacing.md },
  sectionLabel: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sansSemibold, marginBottom: Spacing.sm },
});
