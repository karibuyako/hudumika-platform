import { StyleSheet, Text, View } from 'react-native';

import { StatusPill } from '@/components/StatusPill';
import { Card, Icon, Row } from '@/components/ui';
import { Colors, FontSize, NumberStyle, Spacing } from '@/constants/theme';
import { formatTZS, t } from '@/i18n';
import { dateISO } from '@/lib/format';
import type { Booking, BookingStatus, PriceBreakdown } from '@hudumika/contract';

/** Compact booking row for lists (My Jobs, Today's jobs). */
export function BookingCard({ booking, onPress }: { booking: Booking; onPress?: () => void }) {
  const total = booking.price?.totalTZS;
  const upcoming = ['scheduled', 'reminder_sent', 'en_route', 'provider_arrived'].includes(booking.status);

  return (
    <Card onPress={onPress} style={{ gap: Spacing.sm }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <StatusPill status={booking.status} />
        {upcoming ? (
          <Row gap={4}>
            <Icon name="time-outline" size={13} color={Colors.textTertiary} />
            <Text style={styles.upcoming}>{dateISO(booking.scheduledFor)}</Text>
          </Row>
        ) : null}
      </Row>
      <View style={{ gap: 4 }}>
        <Text style={styles.service}>{booking.serviceId}</Text>
        <Row gap={6}>
          <Icon name="calendar-outline" size={13} color={Colors.textTertiary} />
          <Text style={styles.meta}>{dateISO(booking.scheduledFor)}</Text>
        </Row>
        {booking.technicianId ? (
          <Row gap={6}>
            <Icon name="person-outline" size={13} color={Colors.textTertiary} />
            <Text style={styles.meta}>{t('booking.technician')} · {booking.technicianId}</Text>
          </Row>
        ) : null}
      </View>
      {total != null ? <PriceRow price={booking.price} /> : null}
    </Card>
  );
}

export function PriceRow({ price }: { price?: PriceBreakdown | null }) {
  if (!price) return null;
  return (
    <Row style={{ justifyContent: 'space-between', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border, paddingTop: Spacing.sm }}>
      <Text style={styles.totalLabel}>{t('invoice.total')}</Text>
      <Text style={[styles.total, { fontVariant: NumberStyle.fontVariant }]}>{formatTZS(price.totalTZS)}</Text>
    </Row>
  );
}

export function isBookingStatus(s: string): s is BookingStatus {
  return ['draft', 'pending_payment', 'paid', 'validating', 'matching', 'offered', 'provider_requested', 'provider_accepted', 'scheduled', 'reminder_sent', 'en_route', 'provider_arrived', 'check_in', 'diagnosing', 'quote_required', 'quote_submitted', 'quote_accepted', 'in_progress', 'completion_review', 'awaiting_customer_confirmation', 'completed', 'settled', 'warranty', 'declined', 'cancelled', 'customer_cancelled', 'provider_cancelled', 'refunded', 'disputed', 'escalated', 'reassignment', 'no_show', 'provider_late'].includes(s);
}

const styles = StyleSheet.create({
  service: { fontSize: FontSize.md, fontFamily: 'PlusJakartaSans_700Bold', color: Colors.text },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: 'PlusJakartaSans_600SemiBold' },
  upcoming: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: 'PlusJakartaSans_600SemiBold' },
  totalLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: 'PlusJakartaSans_600SemiBold' },
  total: { fontSize: FontSize.md, color: Colors.primaryDeep, fontFamily: 'PlusJakartaSans_800ExtraBold' },
});
