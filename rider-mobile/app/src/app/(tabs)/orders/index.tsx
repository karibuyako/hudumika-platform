import { router, useFocusEffect } from 'expo-router';
import { memo, useCallback, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import type { ListRenderItemInfo } from 'react-native';

import { ApiError } from '@/api/client';
import { Btn, Card, Empty, Icon, Pill, Row, Screen, Segmented, Spinner } from '@/components/ui';
import { Colors, FontSize, NumberStyle, Spacing } from '@/constants/theme';
import { t, formatTZS } from '@/i18n';
import { dateISO } from '@/lib/format';
import { statusMeta } from '@/lib/order';
import { getDeliveryRepository, getTripsRepository } from '@/repos';
import { useJobsStore } from '@/store/jobs';
import type { Order, Trip } from '@hudumika/contract';

type Scope = 'active' | 'completed';

const OrderRow = memo(function OrderRow({ order, scope, active }: { order: Order; scope: Scope; active: boolean }) {
  const meta = statusMeta(order.status);
  return (
    <Card
      onPress={() => router.push(`/orders/${order.id}`)}
      style={[active && { borderColor: Colors.success, borderWidth: 1 }]}>
      <Row style={{ justifyContent: 'space-between' }}>
        <View style={{ flex: 1, paddingRight: Spacing.md }}>
          <Text numberOfLines={1} style={styles.orderNo}>
            {order.no ?? order.id}
          </Text>
          <Text style={styles.orderSub}>
            {dateISO(scope === 'completed' ? (order.completedAt ?? order.createdAt) : order.createdAt)}
          </Text>
        </View>
        <Pill label={meta.label} tone={meta.tone} />
        <Icon name="chevron-forward" size={15} color={Colors.textFaint} />
      </Row>
    </Card>
  );
});

export default function OrdersIndexScreen() {
  const [scope, setScope] = useState<Scope>('active');
  const [orders, setOrders] = useState<Order[]>([]);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [list, activeTrip] = await Promise.all([
        getDeliveryRepository().listMyOrders(scope),
        getTripsRepository().getActiveTrip().catch(() => null),
      ]);
      setOrders(list);
      setTrip(activeTrip);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('orders.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const activeOrderId = useJobsStore((s) => s.activeOrder?.id ?? null);

  const renderOrder = ({ item }: ListRenderItemInfo<Order>) => (
    <OrderRow order={item} scope={scope} active={item.id === activeOrderId} />
  );

  return (
    <Screen>
      <FlatList
        data={orders}
        keyExtractor={(order) => order.id}
        renderItem={renderOrder}
        ItemSeparatorComponent={<View style={styles.separator} />}
        ListHeaderComponent={
          <View style={styles.segmentWrap}>
            <Segmented
              options={[
                { key: 'active', label: t('orders.active'), count: scope === 'active' ? orders.length : undefined },
                { key: 'completed', label: t('orders.completed') },
              ]}
              value={scope}
              onChange={setScope}
              equal
            />
            {trip && scope === 'active' && (
              <Card onPress={() => router.push('/orders/trip')} style={styles.tripCard}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <View style={{ flex: 1, paddingRight: Spacing.md }}>
                    <Text numberOfLines={1} style={styles.tripTitle}>
                      {t('trip.title')}
                    </Text>
                    <Text style={styles.orderSub}>
                      {t('trip.stops', { count: trip.stops.length })} · {formatTZS(trip.earningsTZS ?? 0)}
                    </Text>
                  </View>
                  <Pill
                    label={trip.status === 'completed' ? t('trip.completed') : t('trip.active')}
                    tone={trip.status === 'completed' ? 'success' : 'info'}
                  />
                  <Icon name="chevron-forward" size={15} color={Colors.textFaint} />
                </Row>
              </Card>
            )}
          </View>
        }
        ListEmptyComponent={
          loading ? (
            <View style={styles.center}>
              <Spinner color={Colors.primary} />
            </View>
          ) : error ? (
            <View style={styles.center}>
              <Text style={styles.error}>{error}</Text>
              <Btn label={t('common.retry')} variant="ghost" onPress={load} />
            </View>
          ) : (
            <Empty
              icon="receipt-outline"
              title={scope === 'active' ? t('orders.emptyActive') : t('orders.emptyCompleted')}
              sub={t('orders.emptySub')}
            />
          )
        }
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  segmentWrap: { padding: Spacing.md, paddingBottom: Spacing.sm, backgroundColor: Colors.bg },
  tripCard: { marginTop: Spacing.md },
  tripTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  center: { alignItems: 'center', gap: Spacing.md, paddingTop: 80 },
  error: { color: Colors.danger, fontSize: FontSize.sm },
  orderNo: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, fontVariant: NumberStyle.fontVariant },
  orderSub: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 },
  separator: { height: Spacing.md },
  listContent: { paddingBottom: 120 },
});