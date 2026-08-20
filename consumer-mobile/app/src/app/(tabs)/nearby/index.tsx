import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import {
  Btn,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  MoneyText,
  Row,
  Screen,
  Segmented,
  SkeletonCard,
  StatusPill,
} from '@/components/ui';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { getBookingsRepository, getProvidersRepository } from '@/repos';
import { dateISO } from '@/lib/dates';
import type { Booking, ProviderPublic, ServiceCategoryConfig } from '@hudumika/contract';

type Scope = 'services' | 'bookings';

export default function NearbyScreen() {
  const router = useRouter();
  const [scope, setScope] = useState<Scope>('services');
  const [categories, setCategories] = useState<ServiceCategoryConfig[] | null>(null);
  const [providers, setProviders] = useState<ProviderPublic[]>([]);
  const [preferred, setPreferred] = useState<ProviderPublic[]>([]);
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const cityId = undefined;
      setCategories(await getProvidersRepository().listServices({ cityId }));
      setProviders(await getProvidersRepository().list({ cityId }));
    } catch {
      setError(t('common.error'));
    }
    // Preferred providers (mock-only-until-adopted, docs/CONTRACT-ADDITIONS.md
    // #21): a live backend without the endpoint hides the section instead of
    // erroring the whole tab.
    try {
      setPreferred(await getProvidersRepository().listPreferred());
    } catch {
      setPreferred([]);
    }
  }, []);

  const loadBookings = useCallback(async () => {
    setError('');
    try {
      setBookings(await getBookingsRepository().list({ status: 'active' }));
    } catch {
      setError(t('common.error'));
    }
  }, []);

  useEffect(() => {
    if (scope === 'services') load();
    else loadBookings();
  }, [scope, load, loadBookings]);

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={scope === 'services' ? load : loadBookings} />
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg }}>
        <Text style={styles.title}>{t('tab.nearby')}</Text>
        <Segmented
          options={[
            { key: 'services', label: t('home.categories') },
            { key: 'bookings', label: t('tab.orders') },
          ]}
          value={scope}
          onChange={setScope}
        />
      </View>

      {scope === 'services' ? (
        !categories ? (
          <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
            <SkeletonCard rows={3} />
            <SkeletonCard rows={2} />
          </View>
        ) : (
          <FlatList
            data={categories}
            keyExtractor={(c) => c.id}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }}
            ListEmptyComponent={<EmptyState icon="construct-outline" title={t('onboard.none')} />}
            ListHeaderComponent={
              <>
                <Card style={styles.card} onPress={() => router.push('/hotels')} accessibilityRole="link" accessibilityLabel={t('hotels.title')}>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Row gap={Spacing.md}>
                      <View style={styles.hotelsIcon}>
                        <Icon name="bed" size={20} color={Colors.primaryDeep} />
                      </View>
                      <View>
                        <Text style={styles.providerName}>{t('hotels.title')}</Text>
                        <Text style={styles.meta}>{t('hotels.browse')}</Text>
                      </View>
                    </Row>
                    <Icon name="chevron-forward" size={15} color={Colors.textFaint} />
                  </Row>
                </Card>
                <Card style={styles.card} onPress={() => router.push('/travel')} accessibilityRole="link" accessibilityLabel={t('travel.title')}>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Row gap={Spacing.md}>
                      <View style={styles.hotelsIcon}>
                        <Icon name="airplane" size={20} color={Colors.primaryDeep} />
                      </View>
                      <View>
                        <Text style={styles.providerName}>{t('travel.title')}</Text>
                        <Text style={styles.meta}>{t('travel.tagline')}</Text>
                      </View>
                    </Row>
                    <Icon name="chevron-forward" size={15} color={Colors.textFaint} />
                  </Row>
                </Card>
                <Card style={styles.card} onPress={() => router.push('/events')} accessibilityRole="link" accessibilityLabel={t('events.title')}>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Row gap={Spacing.md}>
                      <View style={styles.hotelsIcon}>
                        <Icon name="musical-notes" size={20} color={Colors.primaryDeep} />
                      </View>
                      <View>
                        <Text style={styles.providerName}>{t('events.title')}</Text>
                        <Text style={styles.meta}>{t('events.entrySub')}</Text>
                      </View>
                    </Row>
                    <Icon name="chevron-forward" size={15} color={Colors.textFaint} />
                  </Row>
                </Card>
                {preferred.length > 0 ? (
                  <>
                    <Text style={styles.sectionLabel}>{t('providers.preferredSection')}</Text>
                    {preferred.map((p) => {
                      // Same trade↔category booking-service derivation as the
                      // main provider list below (ProviderPublic carries no
                      // service ids — the contract keeps provider services
                      // behind /providers/me/*).
                      const serviceId =
                        categories.find((c) => c.name.toLowerCase() === p.trade.toLowerCase())?.id ??
                        categories[0]?.id ??
                        'svc_001';
                      return (
                        <Card key={p.id} style={styles.card} onPress={() => router.push(`/provider/${p.id}`)}>
                          <Row style={{ justifyContent: 'space-between' }}>
                            <View style={{ flex: 1 }}>
                              <Row gap={6}>
                                <Icon name="star" size={14} color={Colors.gold} />
                                <Text style={styles.providerName} numberOfLines={1}>{p.name}</Text>
                                {p.verified ? <Icon name="shield-checkmark" size={14} color={Colors.success} /> : null}
                              </Row>
                              <Text style={styles.meta}>{p.trade} · {p.serviceAreas?.join(', ')}</Text>
                            </View>
                            {p.baseRateTZS ? <Row gap={2}><MoneyText amountTZS={p.baseRateTZS} size={FontSize.sm} bold /><Text style={styles.meta}>{t('common.perHour')}</Text></Row> : null}
                          </Row>
                          <Btn
                            label={t('booking.confirm')}
                            onPress={() => router.push({ pathname: '/book', params: { providerId: p.id, serviceId } })}
                            size="sm"
                            variant="ghost"
                            style={{ marginTop: Spacing.md, alignSelf: 'flex-start' }}
                          />
                        </Card>
                      );
                    })}
                  </>
                ) : null}
                {providers.length > 0 ? (
                  <>
                    <Text style={styles.sectionLabel}>{t('home.providers')}</Text>
                    {providers.map((p) => {
                      // ProviderPublic has no service ids — resolve the booking
                      // service from the provider's trade (same trade↔category
                      // match the booking mock uses), falling back to the first
                      // category only when no match exists.
                      const serviceId =
                        categories.find((c) => c.name.toLowerCase() === p.trade.toLowerCase())?.id ??
                        categories[0]?.id ??
                        'svc_001';
                      return (
                        <Card key={p.id} style={styles.card} onPress={() => router.push(`/provider/${p.id}`)}>
                          <Row style={{ justifyContent: 'space-between' }}>
                            <View style={{ flex: 1 }}>
                              <Row gap={6}>
                                <Text style={styles.providerName} numberOfLines={1}>{p.name}</Text>
                                {p.verified ? <Icon name="shield-checkmark" size={14} color={Colors.success} /> : null}
                              </Row>
                              <Text style={styles.meta}>{p.trade} · {p.serviceAreas?.join(', ')}</Text>
                            </View>
                            {p.baseRateTZS ? <Row gap={2}><MoneyText amountTZS={p.baseRateTZS} size={FontSize.sm} bold /><Text style={styles.meta}>{t('common.perHour')}</Text></Row> : null}
                          </Row>
                          <Btn
                            label={t('booking.confirm')}
                            onPress={() => router.push({ pathname: '/book', params: { providerId: p.id, serviceId } })}
                            size="sm"
                            variant="ghost"
                            style={{ marginTop: Spacing.md, alignSelf: 'flex-start' }}
                          />
                        </Card>
                      );
                    })}
                  </>
                ) : null}
              </>
            }
            renderItem={({ item }) => (
              <Card
                style={styles.card}
                onPress={() => router.push(`/service/${item.id}`)}
                accessibilityRole="link"
                accessibilityLabel={t('booking.title')}
              >
                <Row style={{ justifyContent: 'space-between' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.providerName}>{item.name}</Text>
                    <Text style={styles.meta}>{item.cancellationRules ?? ''}</Text>
                  </View>
                  <Icon name="chevron-forward" size={15} color={Colors.textFaint} />
                </Row>
              </Card>
            )}
          />
        )
      ) : !bookings ? (
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={2} />
          <SkeletonCard rows={2} />
        </View>
      ) : bookings.length === 0 ? (
        <EmptyState icon="calendar-outline" title={t('booking.empty')} />
      ) : (
        <FlatList
          data={bookings}
          keyExtractor={(b) => b.id}
          onRefresh={loadBookings}
          refreshing={false}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }}
          renderItem={({ item }) => (
            <Card style={styles.card} onPress={() => router.push({ pathname: '/booking/[bookingId]', params: { bookingId: item.id } })}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={styles.providerName}>{t('booking.title')} #{item.id.slice(-6)}</Text>
                <StatusPill status={item.status} />
              </Row>
              <Text style={styles.meta}>{dateISO(item.scheduledFor)}</Text>
              {item.price ? <MoneyText amountTZS={item.price.totalTZS} size={FontSize.md} bold /> : null}
            </Card>
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text, marginBottom: Spacing.md },
  sectionLabel: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sansSemibold, marginBottom: Spacing.sm, marginTop: Spacing.md },
  card: { marginBottom: Spacing.md },
  providerName: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  hotelsIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: Colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
