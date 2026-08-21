import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import {
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
  type IconName,
} from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { ORDER_TAB_EVENTS } from '@/store/events';
import {
  getBookingsRepository,
  getDineInRepository,
  getOrdersRepository,
  getReservationsRepository,
  getVouchersRepository,
} from '@/repos';
import { dateISO } from '@/lib/dates';
import { isActiveOrder } from '@/lib/order';

/* Universal activity center (MASTER-BLUEPRINT §13) — every segment lists its
 * items from the matching repo, active first, history below. Each segment
 * fetches on focus and owns its loading/empty/error/retry states. */
type Scope = 'orders' | 'bookings' | 'dineIn' | 'reservations' | 'vouchers';

interface ActivityRow {
  id: string;
  icon: IconName;
  title: string;
  time: string;
  status: string;
  amountTZS?: number;
  ts: number;
}

const ACTIVE_BOOKING = ['draft', 'pending_payment', 'paid', 'validating', 'matching', 'offered', 'provider_requested', 'provider_accepted', 'scheduled', 'reminder_sent', 'en_route', 'provider_arrived', 'check_in', 'diagnosing', 'quote_required', 'quote_submitted', 'quote_accepted', 'in_progress', 'completion_review', 'awaiting_customer_confirmation', 'settled', 'warranty'];
const ACTIVE_DINE_IN = ['open', 'billing'];
const ACTIVE_RESERVATION = ['pending', 'confirmed', 'seated'];

/** Active first, newest first within each group (per-segment ordering). */
function sortActive<T extends { ts: number }>(rows: T[], isActive: (row: T) => boolean): T[] {
  return [...rows].sort((a, b) => {
    if (isActive(a) !== isActive(b)) return isActive(a) ? -1 : 1;
    return b.ts - a.ts;
  });
}

export default function OrdersScreen() {
  const router = useRouter();
  const [scope, setScope] = useState<Scope>('orders');
  const [data, setData] = useState<Record<Scope, ActivityRow[] | null>>({
    orders: null,
    bookings: null,
    dineIn: null,
    reservations: null,
    vouchers: null,
  });
  const [error, setError] = useState<Record<Scope, boolean>>({
    orders: false,
    bookings: false,
    dineIn: false,
    reservations: false,
    vouchers: false,
  });

  const load = useCallback(async (target: Scope) => {
    setError((prev) => ({ ...prev, [target]: false }));
    try {
      let rows: ActivityRow[] = [];
      switch (target) {
        case 'orders': {
          const all = await getOrdersRepository().list({ limit: 50 });
          rows = sortActive(
            all.map((o) => ({
              id: o.id,
              icon: 'receipt-outline' as IconName,
              title: `${t('order.title')} ${o.no ?? o.id}`,
              time: dateISO(o.createdAt),
              status: o.status,
              amountTZS: o.totals.totalTZS,
              ts: Date.parse(o.createdAt),
            })),
            (r) => isActiveOrder(r.status),
          );
          break;
        }
        case 'bookings': {
          const all = await getBookingsRepository().list({ limit: 50 });
          rows = sortActive(
            all.map((b) => ({
              id: b.id,
              icon: 'construct-outline' as IconName,
              title: `${t('booking.title')} ${b.id.slice(-6)}`,
              time: dateISO(b.scheduledFor),
              status: b.status,
              amountTZS: b.price?.totalTZS,
              ts: Date.parse(b.scheduledFor),
            })),
            (r) => ACTIVE_BOOKING.includes(r.status),
          );
          break;
        }
        case 'dineIn': {
          const all = await getDineInRepository().listMyOrders();
          rows = sortActive(
            all.map((o) => ({
              id: o.id,
              icon: 'restaurant-outline' as IconName,
              title: t('dineIn.table', { table: o.tableId }),
              time: dateISO(o.createdAt),
              status: o.status,
              amountTZS: o.totals.totalTZS,
              ts: Date.parse(o.createdAt),
            })),
            (r) => ACTIVE_DINE_IN.includes(r.status),
          );
          break;
        }
        case 'reservations': {
          const all = await getReservationsRepository().list();
          rows = sortActive(
            all.map((r) => ({
              id: r.id,
              icon: 'calendar-outline' as IconName,
              title: t('reservation.party', { n: r.partySize }),
              time: dateISO(r.scheduledFor),
              status: r.status,
              ts: Date.parse(r.scheduledFor),
            })),
            (r) => ACTIVE_RESERVATION.includes(r.status),
          );
          break;
        }
        case 'vouchers': {
          const all = await getVouchersRepository().list();
          rows = sortActive(
            all.map((v) => ({
              id: v.code,
              icon: 'ticket-outline' as IconName,
              title: v.title ?? t('vouchers.title'),
              time: dateISO(v.purchasedAt),
              status: v.status,
              amountTZS: v.priceTZS,
              ts: Date.parse(v.purchasedAt),
            })),
            (r) => r.status === 'unused',
          );
          break;
        }
      }
      setData((prev) => ({ ...prev, [target]: rows }));
    } catch {
      setError((prev) => ({ ...prev, [target]: true }));
    }
  }, []);

  useEffect(() => {
    load(scope);
  }, [load, scope]);

  // Realtime: order/payment/dispute events refetch the active segment (the
  // orders row set, incl. bookings) — ORDER_TAB_EVENTS in src/store/events.ts.
  useLiveRefresh(ORDER_TAB_EVENTS, () => load(scope));

  const openRow = (row: ActivityRow) => {
    switch (scope) {
      case 'orders':
        router.push(`/order/${row.id}`);
        break;
      case 'bookings':
        router.push(`/booking/${row.id}`);
        break;
      default:
        // Dine-in (detail lives on that screen), reservations and vouchers
        // open their own list screens.
        router.push(scope === 'dineIn' ? '/dine-in' : `/${scope}`);
    }
  };

  const renderRow = ({ item }: { item: ActivityRow }) => (
    <Card style={styles.rowCard} onPress={() => openRow(item)} accessibilityLabel={t('activity.rowA11y', { title: item.title })}>
      <Row gap={Spacing.md}>
        <View style={styles.rowIcon}>
          <Icon name={item.icon} size={18} color={Colors.primaryDeep} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowTitle} numberOfLines={1}>{item.title}</Text>
          <Text style={styles.rowTime}>{item.time}</Text>
        </View>
        <View style={styles.rowTrailing}>
          <StatusPill status={item.status} />
          {item.amountTZS !== undefined ? <MoneyText amountTZS={item.amountTZS} size={FontSize.sm} bold /> : null}
        </View>
      </Row>
    </Card>
  );

  const empty = (target: Scope) => {
    switch (target) {
      case 'orders':
        return (
          <EmptyState
            icon="receipt-outline"
            title={t('order.empty')}
            actionLabel={t('cart.browse')}
            onAction={() => router.push('/home')}
          />
        );
      case 'bookings':
        return (
          <EmptyState
            icon="construct-outline"
            title={t('booking.empty')}
            actionLabel={t('activity.browseServices')}
            onAction={() => router.push('/nearby')}
          />
        );
      case 'dineIn':
        return (
          <EmptyState
            icon="restaurant-outline"
            title={t('dineIn.empty')}
            sub={t('dineIn.emptyHint')}
            actionLabel={t('home.quick.scan')}
            onAction={() => router.push('/dine-in')}
          />
        );
      case 'reservations':
        return (
          <EmptyState
            icon="calendar-outline"
            title={t('reservation.empty')}
            actionLabel={t('activity.browseRestaurants')}
            onAction={() => router.push('/home')}
          />
        );
      case 'vouchers':
        return (
          <EmptyState
            icon="ticket-outline"
            title={t('vouchers.empty')}
            sub={t('vouchers.emptyHint')}
            actionLabel={t('activity.viewDeals')}
            onAction={() => router.push('/group-buys')}
          />
        );
    }
  };

  return (
    <Screen>
      <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg }}>
        <Text style={styles.title}>{t('tab.orders')}</Text>
        <Segmented
          options={[
            { key: 'orders', label: t('activity.orders') },
            { key: 'bookings', label: t('activity.bookings') },
            { key: 'dineIn', label: t('activity.dineIn') },
            { key: 'reservations', label: t('activity.reservations') },
            { key: 'vouchers', label: t('activity.vouchers') },
          ]}
          value={scope}
          onChange={setScope}
        />
      </View>
      {error[scope] ? (
        <View style={{ padding: Spacing.lg }}>
          <ErrorState message={t('common.error')} onRetry={() => load(scope)} />
        </View>
      ) : data[scope] === null ? (
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={2} />
          <SkeletonCard rows={2} />
          <SkeletonCard rows={2} />
        </View>
      ) : data[scope]!.length === 0 ? (
        empty(scope)
      ) : (
        <FlatList
          data={data[scope]!}
          keyExtractor={(r) => `${scope}-${r.id}`}
          renderItem={renderRow}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text, marginBottom: Spacing.md },
  rowCard: { marginBottom: Spacing.md },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: Radius.md,
    backgroundColor: Colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text },
  rowTime: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  rowTrailing: { alignItems: 'flex-end', gap: 4 },
});
