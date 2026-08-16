/* My travel bookings — GET /travel/bookings/me list with a detail sheet.
 * The consumer contract exposes NO travel-booking cancel endpoint (grep of
 * the generated endpoints: only listTravelOptions / createTravelBooking /
 * listMyTravelBookings), so the sheet is read-only and says so. */
import { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { Card, Divider, EmptyState, ErrorState, Icon, MoneyText, Row, Screen, SheetModal, SkeletonCard, StatusPill, type IconName } from '@/components/ui';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t, type I18nKey } from '@/i18n';
import { fullDateISO } from '@/lib/dates';
import { getTravelRepository } from '@/repos';
import type { TravelBooking, TravelBookingMode } from '@hudumika/contract';

function modeIcon(mode?: TravelBookingMode): IconName {
  if (mode === 'bus') return 'bus';
  if (mode === 'ferry') return 'boat';
  if (mode === 'flight') return 'airplane';
  // Mock-only until the contract adds 'train' to TravelBookingMode: the mock
  // serves train bookings whose mode arrives as the 'train' string.
  if ((mode as unknown) === 'train') return 'train-outline';
  return 'navigate-outline';
}

export default function TravelBookingsScreen() {
  const [bookings, setBookings] = useState<TravelBooking[] | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<TravelBooking | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      setBookings(await getTravelRepository().listMyBookings());
    } catch {
      setError(t('common.error'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (!bookings) {
    return (
      <Screen contentStyle={{ padding: Spacing.lg, gap: Spacing.md }}>
        <SkeletonCard rows={2} />
        <SkeletonCard rows={2} />
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.title}>{t('travel.myBookings')}</Text>
      </View>

      {bookings.length === 0 ? (
        <EmptyState icon="airplane-outline" title={t('travel.emptyBookings')} />
      ) : (
        <FlatList
          data={bookings}
          keyExtractor={(b) => b.id}
          onRefresh={load}
          refreshing={false}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }}
          renderItem={({ item }) => (
            <Card style={styles.card} onPress={() => setSelected(item)} accessibilityLabel={`${item.originCityName ?? ''} ${item.destinationCityName ?? ''}`}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Row gap={Spacing.sm} style={{ flex: 1 }}>
                  <View style={styles.modeIcon}>
                    <Icon name={modeIcon(item.mode)} size={16} color={Colors.textSecondary} />
                  </View>
                  <Text style={styles.route} numberOfLines={1}>{item.originCityName ?? '—'} → {item.destinationCityName ?? '—'}</Text>
                </Row>
                <StatusPill status={item.status} />
              </Row>
              <Text style={styles.meta}>{fullDateISO(item.departureAt)} · {t('travel.passengers')}: {item.passengers}</Text>
              <Row style={{ justifyContent: 'space-between', marginTop: Spacing.xs }}>
                <Text style={styles.meta}>{t(`travel.mode.${item.mode}` as I18nKey)}</Text>
                <MoneyText amountTZS={item.totalTZS} size={FontSize.md} bold />
              </Row>
            </Card>
          )}
        />
      )}

      <SheetModal
        visible={selected !== null}
        onClose={() => setSelected(null)}
        title={t('travel.bookingId', { id: (selected?.id ?? '').slice(-8) })}>
        {selected ? (
          <>
            <Row gap={Spacing.sm}>
              <View style={styles.modeIcon}>
                <Icon name={modeIcon(selected.mode)} size={16} color={Colors.textSecondary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.route}>{selected.originCityName ?? '—'} → {selected.destinationCityName ?? '—'}</Text>
                <Text style={styles.meta}>{t(`travel.mode.${selected.mode}` as I18nKey)}</Text>
              </View>
              <StatusPill status={selected.status} />
            </Row>
            <Divider />
            <Text style={styles.meta}>{t('travel.departure')}: {fullDateISO(selected.departureAt)}</Text>
            <Text style={styles.meta}>{t('travel.passengers')}: {selected.passengers}</Text>
            <Text style={styles.meta}>{t('travel.contactPhone')}: {selected.contactPhone ?? '—'}</Text>
            <Text style={styles.meta}>{t('travel.created')}: {fullDateISO(selected.createdAt)}</Text>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.meta}>{t('travel.total')}</Text>
              <MoneyText amountTZS={selected.totalTZS} size={FontSize.lg} bold />
            </Row>
            <Text style={styles.note}>{t('travel.cancelNote')}</Text>
          </>
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
  card: { marginBottom: Spacing.md },
  modeIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  route: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text, flexShrink: 1 },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  note: { fontSize: FontSize.xs, color: Colors.textFaint, fontFamily: Fonts.sans, marginTop: Spacing.sm },
});
