import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';

import { OrderTimer } from '@/components/order-timer';
import { Btn, Card, Chip, Empty, Icon, Pill, Row, Screen, Segmented, SheetModal, StatusPill } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { clock, preorderIn, tzs } from '@/lib/format';
import { api } from '@/api/client';
import type { BatchResultDto, StoreListItem } from '@/api/types';
import type { Order, OrderStatus } from '@/types';
import { useOrderStore } from '@/store/orders';

type TabKey = OrderStatus | 'advance';
type DeliveryFilter = 'all' | 'delivery' | 'pickup';
type Range = 'all' | '7d' | '30d';
type AdvanceTab = 'today' | 'upcoming' | 'past';

const TABS: { key: TabKey; label: I18nKey }[] = [
  { key: 'new', label: 'orders.tabAccept' },
  { key: 'advance', label: 'orders.tabAdvance' },
  { key: 'merchant_accepted', label: 'orders.tabAccepted' },
  { key: 'preparing', label: 'orders.tabPreparing' },
  { key: 'ready', label: 'orders.tabReady' },
  { key: 'completed', label: 'orders.tabCompleted' },
  { key: 'cancelled', label: 'orders.tabCancelled' },
  { key: 'refunded', label: 'orders.tabRefunded' },
  { key: 'disputed', label: 'orders.tabDisputed' },
];

const ADVANCE_TABS: { key: AdvanceTab; label: I18nKey }[] = [
  { key: 'today', label: 'orders.advToday' },
  { key: 'upcoming', label: 'orders.advUpcoming' },
  { key: 'past', label: 'orders.advPast' },
];

const RANGES: { key: Range; label: I18nKey }[] = [
  { key: 'all', label: 'orders.rangeAll' },
  { key: '7d', label: 'orders.range7' },
  { key: '30d', label: 'orders.range30' },
];

import { getUrgencyTier, RUSH_PRESETS_MIN, URGENCY_TONE } from '@/lib/urgency';

const SOURCE_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'success'> = {
  app: 'info',
  web: 'success',
  phone: 'warning',
  pos: 'neutral',
};

export default function OrdersScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const orders = useOrderStore((s) => s.orders);
  const loaded = useOrderStore((s) => s.loaded);
  const acceptOrder = useOrderStore((s) => s.acceptOrder);
  const acceptAllOrders = useOrderStore((s) => s.acceptAllOrders);
  const markReady = useOrderStore((s) => s.markReady);
  const startPreparing = useOrderStore((s) => s.startPreparing);
  const completeOrder = useOrderStore((s) => s.completeOrder);
  const replyRush = useOrderStore((s) => s.replyRush);
  const decideRefund = useOrderStore((s) => s.decideRefund);
  const holdOrder = useOrderStore((s) => s.holdOrder);
  const unholdOrder = useOrderStore((s) => s.unholdOrder);
  const cancelOrder = useOrderStore((s) => s.cancelOrder);
  const queueMode = useOrderStore((s) => s.queueMode);
  const setQueueMode = useOrderStore((s) => s.setQueueMode);
  const rushOrders = useOrderStore((s) => s.rushOrders);
  const enterpriseOrders = useOrderStore((s) => s.enterpriseOrders);
  const hydrateRush = useOrderStore((s) => s.hydrateRush);
  const hydrateEnterprise = useOrderStore((s) => s.hydrateEnterprise);
  const hydrateQueue = useOrderStore((s) => s.hydrateQueue);
  const loadMoreQueue = useOrderStore((s) => s.loadMoreQueue);
  const queueHasMore = useOrderStore((s) => s.queueHasMore);
  const advanceOrders = useOrderStore((s) => s.advanceOrders);
  const advanceLoaded = useOrderStore((s) => s.advanceLoaded);
  const advanceTab = useOrderStore((s) => s.advanceTab);
  const setAdvanceTab = useOrderStore((s) => s.setAdvanceTab);
  const hydrateAdvance = useOrderStore((s) => s.hydrateAdvance);
  const batchRejectOrder = useOrderStore((s) => s.batchRejectOrder);
  const [tab, setTab] = useState<TabKey>('new');
  const [type, setType] = useState<DeliveryFilter>('all');
  const [query, setQuery] = useState('');
  const [range, setRange] = useState<Range>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [stores, setStores] = useState<StoreListItem[]>([]);
  const [filterStore, setFilterStore] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<Order | null>(null);
  const [advanceError, setAdvanceError] = useState(false);
  const [rushReplyFor, setRushReplyFor] = useState<Order | null>(null);
  const [rushReplyText, setRushReplyText] = useState('');
  const [rushReplyBusy, setRushReplyBusy] = useState(false);
  const [rushReplied, setRushReplied] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectCodes, setRejectCodes] = useState<{ code: string; label: string }[]>([]);
  const [rejectBusy, setRejectBusy] = useState(false);
  const [rejectResult, setRejectResult] = useState<BatchResultDto | null>(null);
  const [acceptResult, setAcceptResult] = useState<BatchResultDto | null>(null);

  useEffect(() => {
    api
      .get<{ stores: StoreListItem[] }>('/stores', { retries: 1 })
      .then((r) => setStores(r.stores))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (queueMode === 'rush') hydrateRush('all');
    if (queueMode === 'enterprise') hydrateEnterprise('all');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueMode]);

  /* Server-side per-tab queue queries (GET /orders/me?status=&limit=&cursor=). */
  useEffect(() => {
    if (queueMode === 'mine' && tab !== 'advance' && !filterStore) {
      hydrateQueue(tab);
    } else if (tab === 'advance') {
      hydrateAdvance(advanceTab)
        .then(() => setAdvanceError(false))
        .catch(() => setAdvanceError(true));
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelected(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, filterStore, queueMode, advanceTab]);

  const changeFilter = (storeId: string | null) => {
    setFilterStore(storeId);
    useOrderStore.getState().hydrate(storeId ?? undefined);
  };

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    // eslint-disable-next-line react-hooks/purity
    const rangeStart = range === '7d' ? Date.now() - 7 * 86400000 : range === '30d' ? Date.now() - 30 * 86400000 : 0;
    return orders
      .filter((o) => o.status === tab)
      .filter((o) => (type === 'all' ? true : o.deliveryType === type))
      .filter((o) => (tab === 'completed' || tab === 'cancelled' ? o.createdAt >= rangeStart : true))
      .filter((o) =>
        q
          ? o.no.toLowerCase().includes(q) ||
            o.customer.name.toLowerCase().includes(q) ||
            o.customer.phone.includes(q) ||
            o.items.some((it) => it.name.toLowerCase().includes(q))
          : true,
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [orders, tab, type, query, range]);

  const onRefresh = () => {
    setRefreshing(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (queueMode === 'rush') hydrateRush('all');
    else if (queueMode === 'enterprise') hydrateEnterprise('all');
    else if (tab === 'advance') hydrateAdvance(advanceTab).catch(() => setAdvanceError(true));
    else if (filterStore) useOrderStore.getState().hydrate(filterStore);
    else hydrateQueue(tab);
    setTimeout(() => setRefreshing(false), 600);
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openPrint = () => {
    if (!selected.size) return;
    router.push(`/orders/print?ids=${[...selected].join(',')}`);
    setSelectMode(false);
    setSelected(new Set());
  };

  const openReject = () => {
    setRejectOpen(true);
    setRejectReason('');
    api
      .get<{ reasons: { code: string; label: string }[] }>('/orders/reject-reasons', { retries: 1 })
      .then((r) => setRejectCodes(r.reasons))
      .catch(() => setRejectCodes([]));
  };

  const confirmBatchReject = () => {
    if (!rejectReason || !selected.size) return;
    setRejectBusy(true);
    batchRejectOrder([...selected], rejectReason)
      .then((res) => {
        const failedIds = new Set((res.failures ?? []).map((f) => f.orderId));
        setSelected(failedIds); // failed rows stay selectable for retry
        setRejectResult(res);
        setRejectOpen(false);
      })
      .catch(() => undefined)
      .finally(() => setRejectBusy(false));
  };

  const openRushReply = (order: Order) => {
    setRushReplyFor(order);
    setRushReplyText('');
    setRushReplied(false);
  };

  const sendRushReply = () => {
    if (!rushReplyFor || !rushReplyText.trim()) return;
    setRushReplyBusy(true);
    replyRush(rushReplyFor.id, rushReplyText.trim())
      .then(() => setRushReplied(true))
      .catch(() => undefined)
      .finally(() => setRushReplyBusy(false));
  };

  const renderStatusActions = (item: Order) => {
    if (item.status === 'new') {
      return (
        <Row style={{ marginTop: Spacing.md, gap: 10 }}>
          <Btn
            label={item.scheduledAt ? t('orders.acceptPreorder') : t('orders.accept')}
            variant="primary"
            onPress={() => {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              acceptOrder(item.id).catch(() => undefined);
            }}
            style={{ flex: 1 }}
          />
          <Btn label={t('orders.decline')} variant="outline" onPress={() => router.push({ pathname: '/orders/[id]', params: { id: item.id, action: 'reject' } })} style={{ flex: 1 }} />
        </Row>
      );
    }
    if (item.status === 'merchant_accepted') {
      return (
        <Row style={{ marginTop: Spacing.md, gap: 10 }}>
          <Btn
            label={t('od.startPreparing')}
            icon="restaurant-outline"
            onPress={() => {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              startPreparing(item.id).catch(() => undefined);
            }}
            style={{ flex: 1 }}
          />
        </Row>
      );
    }
    if (item.status === 'preparing') {
      return (
        <Row style={{ marginTop: Spacing.md, gap: 10 }}>
          <Btn label={t('orders.markReady')} icon="checkmark-circle-outline" onPress={() => markReady(item.id).catch(() => undefined)} style={{ flex: 1 }} />
          {item.hold ? (
            <Btn label={t('orders.unhold')} icon="play-outline" variant="ghost" onPress={() => unholdOrder(item.id)} style={{ flex: 1 }} />
          ) : (
            <Btn
              label={t('orders.hold')}
              icon="pause-outline"
              variant="outline"
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                holdOrder(item.id, 'Held from the order list');
              }}
              style={{ flex: 1 }}
            />
          )}
        </Row>
      );
    }
    if (item.status === 'ready') {
      return (
        <View style={{ gap: 10 }}>
          <Row style={{ marginTop: Spacing.md, gap: 10 }}>
            <Btn
              label={item.rider ? t('orders.handedTo', { rider: item.rider }) : t('orders.confirmDelivered')}
              icon="bicycle-outline"
              variant="success"
              onPress={() => completeOrder(item.id).catch(() => undefined)}
              style={{ flex: 1 }}
            />
            <Btn label={t('orders.cancel')} icon="close-circle-outline" variant="outline" onPress={() => setConfirmCancel(item)} style={{ flex: 1 }} />
          </Row>
          <Row style={{ gap: 10 }}>
            {item.hold ? (
              <Btn label={t('orders.unhold')} icon="play-outline" variant="ghost" onPress={() => unholdOrder(item.id)} style={{ flex: 1 }} />
            ) : (
              <Btn
                label={t('orders.hold')}
                icon="pause-outline"
                variant="outline"
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  holdOrder(item.id, 'Held from the order list');
                }}
                style={{ flex: 1 }}
              />
            )}
          </Row>
        </View>
      );
    }
    return null;
  };

  const renderQueueCard = ({ item }: { item: Order }) => (
    <Card
      style={[styles.orderCard, selectMode && selected.has(item.id) && styles.orderCardSelected]}
      onPress={() => (selectMode ? toggleSelect(item.id) : router.push(`/orders/${item.id}`))}>
      {selectMode ? (
        <View style={[styles.checkbox, selected.has(item.id) && styles.checkboxOn]}>
          {selected.has(item.id) ? <Icon name="checkmark" size={13} color={Colors.white} /> : null}
        </View>
      ) : null}
      <Row style={{ justifyContent: 'space-between' }}>
        <Row gap={8} style={{ flexWrap: 'wrap' }}>
          <Text style={styles.orderNo}>{item.no}</Text>
          {!item.seen ? <Pill label={t('orders.seenBadge')} tone="danger" /> : null}
          {item.source ? <Pill label={t(`orders.source.${item.source}` as I18nKey)} tone={SOURCE_TONE[item.source] ?? 'neutral'} /> : null}
          {item.scheduledAt ? <Pill label={t('orders.preorder')} tone="warning" /> : null}
          {item.hold ? <Pill label={t('orders.hold').toUpperCase()} tone="warning" /> : null}
          <StatusPill status={item.status} />
        </Row>
        <Text style={styles.time}>{clock(item.createdAt)}</Text>
      </Row>

      <View style={styles.itemRows}>
        {item.items.slice(0, 3).map((it, i) => (
          <Text key={i} style={styles.itemText} numberOfLines={1}>
            {it.emoji} {it.name} ×{it.qty}
            {it.variants.length ? ` (${it.variants.join('/')})` : ''}
          </Text>
        ))}
        {item.items.length > 3 ? (
          <Text style={styles.itemMore}>{t('orders.moreItems', { n: item.items.length - 3 })}</Text>
        ) : null}
      </View>

      {item.status === 'cancelled' && item.cancelReason ? (
        <Text style={styles.itemMore}>{t('orders.cancelledReason', { reason: item.cancelReason })}</Text>
      ) : null}
      {item.status === 'disputed' ? (
        <Text style={styles.itemMore}>{t('od.heldPayout')}</Text>
      ) : null}

      <Row style={{ justifyContent: 'space-between' }}>
        <Row gap={6}>
          {item.deliveryType === 'pickup' ? (
            <Pill label={t('orders.pickup')} tone="info" />
          ) : (
            <Text style={styles.delivery}>{t('orders.deliveryName', { name: item.customer.name })}</Text>
          )}
          {item.scheduledAt ? (
            <Text style={styles.scheduled}>{preorderIn(item.scheduledAt)}</Text>
          ) : item.status === 'new' ? (
            <OrderTimer deadlineAt={item.deadlineAt} />
          ) : null}
        </Row>
        <Text style={styles.total}>
          <Text style={styles.totalNum}>{tzs(item.total)}</Text>
        </Text>
      </Row>
      {item.status === 'new' && item.deadlineAt ? (
        <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('orders.deadlineHint')}</Text>
      ) : null}

      {item.rushAt && !item.rushReplied && item.status !== 'cancelled' ? (
        <View style={styles.rushBanner}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.rushTitle}>{t('orders.rushing')}</Text>
            <Text style={styles.rushSub}>
              {t('orders.rushAsked', { t1: clock(item.rushAt), t2: clock(item.deadlineAt) })}
            </Text>
          </View>
          <Btn
            label={t('orders.imOnIt')}
            variant="danger"
            size="sm"
            onPress={() => {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              openRushReply(item);
            }}
          />
        </View>
      ) : null}

      {item.refund?.status === 'requested' ? (
        <View style={styles.refundBanner}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={styles.refundTitle}>{t('orders.refundRequest', { amount: tzs(item.refund.amount) })}</Text>
            <Text style={styles.refundSub}>{clock(item.refund.ts)}</Text>
          </Row>
          <Text style={styles.refundReason}>“{item.refund.reason}”</Text>
          <Row style={{ gap: 10 }}>
            <Btn
              label={t('orders.approve')}
              variant="success"
              size="sm"
              style={{ flex: 1 }}
              onPress={() => {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                decideRefund(item.id, true);
              }}
            />
            <Btn
              label={t('orders.decline')}
              variant="outline"
              size="sm"
              style={{ flex: 1 }}
              onPress={() => decideRefund(item.id, false)}
            />
          </Row>
        </View>
      ) : null}

      {!selectMode ? renderStatusActions(item) : null}
    </Card>
  );

  const renderRushCard = ({ item }: { item: Order }) => {
    const rush = rushOrders.find((r) => r.orderId === item.id);
    // Urgency is honest UI over contract data — no urgency field; dwell = now - createdAt.
    // Helper per spec: getUrgencyTier(createdAt) -> tier (<2m Low, <5m Medium, <10m High, >=10m Critical).
    const urgency = getUrgencyTier(item.createdAt);
    return (
      <Card style={styles.orderCard} onPress={() => router.push(`/orders/${item.id}`)}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Row gap={8}>
            <Text style={styles.orderNo}>{item.no}</Text>
            <Pill label={t(`orders.urgency.${urgency}` as I18nKey)} tone={URGENCY_TONE[urgency]} />
            {item.source ? <Pill label={t(`orders.source.${item.source}` as I18nKey)} tone={SOURCE_TONE[item.source] ?? 'neutral'} /> : null}
            <StatusPill status={item.status} />
          </Row>
          <Text style={styles.time}>{clock(item.createdAt)}</Text>
        </Row>
        {item.enterprise ? (
          <Row gap={6}>
            <Pill label={t('orders.enterprise')} tone="info" />
            <Text style={styles.delivery}>{item.enterprise.companyName}</Text>
          </Row>
        ) : null}
        <View style={styles.itemRows}>
          {item.items.slice(0, 2).map((it, i) => (
            <Text key={i} style={styles.itemText} numberOfLines={1}>
              {it.emoji} {it.name} ×{it.qty}
            </Text>
          ))}
        </View>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.delivery}>{t('orders.deliveryName', { name: item.customer.name })}</Text>
          <Text style={styles.total}>
            <Text style={styles.totalNum}>{tzs(item.total)}</Text>
          </Text>
        </Row>
        {rush && rush.status === 'open' ? (
          <View style={styles.rushBanner}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.rushTitle}>{t('orders.rushing')}</Text>
              <Text style={styles.rushSub}>{t('orders.rushAsked', { t1: clock(rush.requestedAt), t2: clock(item.deadlineAt) })}</Text>
            </View>
            <Btn label={t('orders.imOnIt')} variant="danger" size="sm" onPress={() => openRushReply(item)} />
          </View>
        ) : rush?.replyMessage ? (
          <Text style={styles.itemMore}>{t('orders.rushRepliedDone')} · “{rush.replyMessage}”</Text>
        ) : null}
      </Card>
    );
  };

  const renderAdvanceCard = ({ item }: { item: Order }) => (
    <Card style={styles.orderCard} onPress={() => router.push(`/orders/${item.id}`)}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Row gap={8}>
          <Text style={styles.orderNo}>{item.no}</Text>
          {item.source ? <Pill label={t(`orders.source.${item.source}` as I18nKey)} tone={SOURCE_TONE[item.source] ?? 'neutral'} /> : null}
          <StatusPill status={item.status} />
        </Row>
        <Text style={styles.time}>{clock(item.createdAt)}</Text>
      </Row>
      <View style={styles.itemRows}>
        {item.items.slice(0, 2).map((it, i) => (
          <Text key={i} style={styles.itemText} numberOfLines={1}>
            {it.emoji} {it.name} ×{it.qty}
          </Text>
        ))}
      </View>
      {item.scheduledAt ? (
        <Text style={styles.scheduled}>{preorderIn(item.scheduledAt)}</Text>
      ) : null}
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={styles.delivery}>{t('orders.deliveryName', { name: item.customer.name })}</Text>
        <Text style={styles.total}>
          <Text style={styles.totalNum}>{tzs(item.total)}</Text>
        </Text>
      </Row>
    </Card>
  );

  return (
    <Screen>
      <View style={styles.toolbar}>
        <View style={styles.searchBox}>
          <Icon name="search" size={16} color={Colors.textTertiary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t('orders.searchPh')}
            placeholderTextColor={Colors.textTertiary}
            style={styles.searchInput}
          />
          {query ? (
            <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.close')}>
              <Icon name="close-circle" size={15} color={Colors.textTertiary} />
            </Pressable>
          ) : null}
        </View>
        <Pressable
          onPress={() => {
            setSelectMode((v) => !v);
            setSelected(new Set());
          }}
          style={[styles.printToggle, selectMode && styles.printToggleActive]}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('orders.batchPrintA11y')}>
          <Icon name={selectMode ? 'close' : 'print-outline'} size={17} color={selectMode ? Colors.text : Colors.textSecondary} />
        </Pressable>
      </View>

      {selectMode && tab === 'new' ? (
        <View style={styles.batchBar}>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary, flex: 1 }}>
            {t('orders.selected', { n: selected.size })}
          </Text>
          <Btn label={t('orders.printCount', { n: selected.size })} size="sm" disabled={!selected.size} onPress={openPrint} />
          <Btn label={t('orders.batchReject', { n: selected.size })} size="sm" variant="danger" disabled={!selected.size} onPress={openReject} />
        </View>
      ) : selectMode ? (
        <View style={styles.batchBar}>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary, flex: 1 }}>
            {t('orders.selected', { n: selected.size })}
          </Text>
          <Btn label={t('orders.printCount', { n: selected.size })} size="sm" disabled={!selected.size} onPress={openPrint} />
        </View>
      ) : null}

      <View style={styles.tabWrap}>
        <Segmented
          value={tab}
          onChange={(k) => {
            setTab(k);
            setSelected(new Set());
          }}
          options={TABS.map((tabOpt) => ({ key: tabOpt.key, label: t(tabOpt.label), count: undefined }))}
          equal
        />
      </View>

      <Row gap={Spacing.sm} style={{ paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm }}>
        <Chip label={t('orders.allStores')} selected={filterStore === null} onPress={() => changeFilter(null)} />
        {stores.map((s) => (
          <Chip key={s.id} label={s.name} selected={filterStore === s.id} onPress={() => changeFilter(s.id)} tone="info" />
        ))}
      </Row>

      <Row gap={Spacing.sm} style={{ paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm }}>
        <Chip label={t('orders.all')} selected={type === 'all'} onPress={() => setType('all')} />
        <Chip label={t('orders.delivery')} selected={type === 'delivery'} onPress={() => setType('delivery')} tone="info" />
        <Chip label={t('orders.pickup')} selected={type === 'pickup'} onPress={() => setType('pickup')} tone="success" />
      </Row>

      <Row gap={Spacing.sm} style={{ paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm }}>
        <Chip label={t('orders.searchCta')} selected={false} onPress={() => router.push('/orders/search')} tone="neutral" />
        <Chip label={t('orders.rushQueue')} selected={queueMode === 'rush'} onPress={() => setQueueMode(queueMode === 'rush' ? 'mine' : 'rush')} tone="danger" />
        <Chip label={t('orders.enterprise')} selected={queueMode === 'enterprise'} onPress={() => setQueueMode(queueMode === 'enterprise' ? 'mine' : 'enterprise')} tone="info" />
        <Chip label={t('orders.refunds')} selected={false} onPress={() => router.push('/orders/refunds')} tone="info" />
        <Chip label={t('orders.receipts')} selected={false} onPress={() => router.push('/orders/receipts')} tone="info" />
      </Row>

      {queueMode === 'mine' && tab === 'advance' ? (
        <Row gap={Spacing.sm} style={{ paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm }}>
          {ADVANCE_TABS.map((a) => (
            <Chip key={a.key} label={t(a.label)} selected={advanceTab === a.key} onPress={() => setAdvanceTab(a.key)} tone="info" />
          ))}
        </Row>
      ) : null}

      {queueMode === 'mine' && (tab === 'completed' || tab === 'cancelled') ? (
        <Row gap={Spacing.sm} style={{ paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm }}>
          {RANGES.map((r) => (
            <Chip key={r.key} label={t(r.label)} selected={range === r.key} onPress={() => setRange(r.key)} tone="neutral" />
          ))}
        </Row>
      ) : null}

      {queueMode === 'mine' && tab === 'new' && list.length > 0 && !selectMode ? (
        <Row gap={Spacing.sm} style={{ paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm }}>
          <Btn
            label={t('orders.acceptAll', { n: list.length })}
            size="sm"
            variant="primary"
            onPress={() => {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              acceptAllOrders().then((res) => {
                if (res && res.failed) setAcceptResult(res);
              });
            }}
          />
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, alignSelf: 'center', flex: 1 }}>
            {t('orders.acceptAllHint')}
          </Text>
        </Row>
      ) : null}

      {queueMode !== 'mine' ? (
        <FlatList
          data={queueMode === 'rush' ? rushOrders.map((r) => orders.find((o) => o.id === r.orderId)).filter((o): o is Order => !!o) : enterpriseOrders}
          keyExtractor={(o) => o.id}
          contentContainerStyle={{ padding: Spacing.lg, paddingTop: 4, paddingBottom: 120, gap: Spacing.md }}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
          ListEmptyComponent={<Empty icon={queueMode === 'rush' ? 'notifications-outline' : 'business-outline'} title={queueMode === 'rush' ? t('orders.rushEmpty') : t('orders.enterpriseEmpty')} />}
          renderItem={renderRushCard}
        />
      ) : tab === 'advance' ? (
        <FlatList
          data={advanceOrders}
          keyExtractor={(o) => o.id}
          contentContainerStyle={{ padding: Spacing.lg, paddingTop: 4, paddingBottom: 120, gap: Spacing.md }}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
          ListEmptyComponent={
            !advanceLoaded ? (
              <View style={styles.loadFailed}>
                <ActivityIndicator color={Colors.primary} />
              </View>
            ) : advanceError ? (
              <View style={styles.loadFailed}>
                <Icon name="cloud-offline-outline" size={26} color={Colors.textTertiary} />
                <Text style={{ color: Colors.textSecondary, fontSize: FontSize.sm, fontWeight: '600', marginTop: Spacing.sm }}>
                  {t('orders.advLoadFailed')}
                </Text>
                <Btn
                  label={t('common.retry')}
                  size="sm"
                  variant="outline"
                  style={{ marginTop: Spacing.md }}
                  onPress={() => hydrateAdvance(advanceTab).then(() => setAdvanceError(false)).catch(() => undefined)}
                />
              </View>
            ) : (
              <Empty icon="calendar-outline" title={t('orders.advEmpty')} />
            )
          }
          renderItem={renderAdvanceCard}
        />
      ) : (
        <FlatList
        data={list}
        keyExtractor={(o) => o.id}
        contentContainerStyle={{ padding: Spacing.lg, paddingTop: 4, paddingBottom: 120, gap: Spacing.md }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        ListEmptyComponent={
          !loaded ? (
            <View style={styles.loadFailed}>
              <Icon name="cloud-offline-outline" size={26} color={Colors.textTertiary} />
              <Text style={{ color: Colors.textSecondary, fontSize: FontSize.sm, fontWeight: '600', marginTop: Spacing.sm }}>
                {t('orders.loadFailed')}
              </Text>
              <Btn
                label={t('common.retry')}
                size="sm"
                variant="outline"
                style={{ marginTop: Spacing.md }}
                onPress={() => (filterStore ? useOrderStore.getState().hydrate(filterStore) : hydrateQueue(tab))}
              />
            </View>
          ) : (
            <Empty icon="receipt-outline" title={t('orders.empty')} sub={query ? t('orders.emptySub') : undefined} />
          )
        }
        ListFooterComponent={
          queueHasMore && list.length >= 20 ? (
            <Btn label={t('orders.loadMore')} variant="outline" size="sm" onPress={() => loadMoreQueue()} />
          ) : null
        }
        renderItem={renderQueueCard}
      />
      )}

      <SheetModal visible={!!confirmCancel} onClose={() => setConfirmCancel(null)} title={t('od.cancelTitle')}>
        <View style={{ gap: Spacing.sm }}>
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>{t('od.cancelHint')}</Text>
          {confirmCancel && confirmCancel.cancelFeeTZS !== undefined ? (
            <>
              <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>{t('od.cancelFee', { fee: tzs(confirmCancel.cancelFeeTZS) })}</Text>
              <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>{t('od.refundAfterFee', { refund: tzs(confirmCancel.refundTZS ?? 0) })}</Text>
            </>
          ) : null}
          <Btn
            label={t('od.confirmCancel')}
            variant="danger"
            size="lg"
            onPress={() => {
              if (!confirmCancel) return;
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
              cancelOrder(confirmCancel.id, 'Cancelled from the order queue').catch(() => undefined);
              setConfirmCancel(null);
            }}
          />
        </View>
      </SheetModal>

      <SheetModal visible={!!rushReplyFor} onClose={() => setRushReplyFor(null)} title={t('orders.rushReplyTitle')}>
        <View style={{ gap: Spacing.sm }}>
          {rushReplied ? (
            <Text style={{ fontSize: FontSize.sm, color: Colors.success, fontWeight: '700' }}>{t('orders.rushRepliedDone')}</Text>
          ) : (
            <>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('orders.etaPresetHint')}</Text>
              <Row gap={6} style={{ flexWrap: 'wrap' }}>
                {RUSH_PRESETS_MIN.map((m) => (
                  <Chip
                    key={m}
                    label={t('orders.rushReplyPreset', { n: m })}
                    selected={false}
                    onPress={() => setRushReplyText(`ETA ${m} minutes`)}
                    tone="info"
                  />
                ))}
              </Row>
              <TextInput
                value={rushReplyText}
                onChangeText={(v) => setRushReplyText(v.slice(0, 300))}
                placeholder={t('orders.rushReplyPh')}
                placeholderTextColor={Colors.textTertiary}
                multiline
                style={[styles.input, { minHeight: 84, textAlignVertical: 'top' }]}
              />
              <Btn
                label={t('orders.rushReplySend')}
                variant="danger"
                size="lg"
                disabled={!rushReplyText.trim()}
                loading={rushReplyBusy}
                onPress={sendRushReply}
              />
            </>
          )}
        </View>
      </SheetModal>

      <SheetModal visible={rejectOpen} onClose={() => setRejectOpen(false)} title={t('orders.rejectTitle')}>
        <View style={{ gap: Spacing.sm }}>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('orders.rejectHint')}</Text>
          {(rejectCodes.length ? rejectCodes : [{ code: 'OTHER', label: 'Other' }]).map((r) => (
            <Pressable
              key={r.code}
              onPress={() => setRejectReason(r.label)}
              accessibilityRole="button"
              accessibilityState={{ selected: rejectReason === r.label }}
              style={[styles.reasonRow, rejectReason === r.label && styles.reasonActive]}>
              <Text style={{ fontSize: FontSize.md, color: rejectReason === r.label ? Colors.text : Colors.textSecondary }}>{r.label}</Text>
              {rejectReason === r.label ? <Icon name="checkmark-circle" size={17} color={Colors.success} /> : null}
            </Pressable>
          ))}
          <Btn
            label={t('orders.rejectConfirm', { n: selected.size })}
            variant="danger"
            size="lg"
            disabled={!rejectReason}
            loading={rejectBusy}
            onPress={confirmBatchReject}
          />
        </View>
      </SheetModal>

      <SheetModal visible={!!rejectResult} onClose={() => setRejectResult(null)} title={t('orders.rejectResult', { n: rejectResult?.accepted ?? 0, m: (rejectResult?.accepted ?? 0) + (rejectResult?.failed ?? 0) })}>
        <View style={{ gap: Spacing.sm }}>
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>
            {t('orders.rejectResult', { n: rejectResult?.accepted ?? 0, m: (rejectResult?.accepted ?? 0) + (rejectResult?.failed ?? 0) })}
          </Text>
          {rejectResult?.failures?.length ? (
            <>
              <Text style={{ fontSize: FontSize.xs, color: Colors.danger, fontWeight: '700' }}>
                {t('orders.rejectFailures', { ids: rejectResult.failures.map((f) => `${f.orderId}:${f.code}`).join(', ') })}
              </Text>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('orders.rejectRetry')}</Text>
            </>
          ) : null}
          <Btn label={t('common.close')} variant="outline" size="lg" onPress={() => setRejectResult(null)} />
        </View>
      </SheetModal>

      <SheetModal visible={!!acceptResult} onClose={() => setAcceptResult(null)} title={t('orders.batchAcceptResult', { n: acceptResult?.accepted ?? 0, m: (acceptResult?.accepted ?? 0) + (acceptResult?.failed ?? 0), f: acceptResult?.failed ?? 0 })}>
        <View style={{ gap: Spacing.sm }}>
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>
            {t('orders.batchAcceptResult', { n: acceptResult?.accepted ?? 0, m: (acceptResult?.accepted ?? 0) + (acceptResult?.failed ?? 0), f: acceptResult?.failed ?? 0 })}
          </Text>
          {acceptResult?.failures?.length ? (
            <>
              <Text style={{ fontSize: FontSize.xs, color: Colors.danger, fontWeight: '700' }}>
                {t('orders.batchAcceptFailures', { ids: acceptResult.failures.map((f) => `${f.orderId}:${f.code}`).join(', ') })}
              </Text>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('orders.rejectRetry')}</Text>
            </>
          ) : null}
          <Btn label={t('common.close')} variant="outline" size="lg" onPress={() => setAcceptResult(null)} />
        </View>
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  loadFailed: { alignItems: 'center', paddingVertical: Spacing.xxl * 1.5, gap: 2 },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: Spacing.lg, paddingTop: Spacing.md },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    paddingHorizontal: Spacing.md,
    height: 40,
  },
  searchInput: { flex: 1, fontSize: FontSize.sm, color: Colors.text, paddingVertical: 0 },
  printToggle: {
    width: 40,
    height: 40,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  printToggleActive: { backgroundColor: Colors.primary, borderColor: Colors.primaryDark },
  batchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.sm,
    padding: 10,
    borderRadius: Radius.md,
    backgroundColor: Colors.primarySoft,
    borderWidth: 1,
    borderColor: Colors.primary,
  },
  tabWrap: { paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md },
  orderCard: { paddingVertical: 14, gap: 10 },
  orderCardSelected: { borderWidth: 2, borderColor: Colors.primary },
  checkbox: {
    position: 'absolute',
    right: 12,
    top: 12,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: Colors.primary, borderColor: Colors.primaryDark },
  orderNo: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text, letterSpacing: 0.3 },
  time: { fontSize: FontSize.xs, color: Colors.textTertiary },
  itemRows: { gap: 3, paddingVertical: 4 },
  itemText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  itemMore: { fontSize: FontSize.xs, color: Colors.textTertiary },
  delivery: { fontSize: FontSize.xs, color: Colors.info, fontWeight: '600' },
  scheduled: { fontSize: FontSize.xs, color: Colors.warning, fontWeight: '700' },
  rushBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: `${Colors.danger}14`,
    borderWidth: 1,
    borderColor: `${Colors.danger}40`,
    borderRadius: Radius.md,
    padding: 10,
  },
  rushTitle: { fontSize: FontSize.sm, fontWeight: '800', color: Colors.danger },
  rushSub: { fontSize: FontSize.xs, color: Colors.textTertiary },
  refundBanner: {
    gap: 8,
    backgroundColor: Colors.warningSoft,
    borderWidth: 1,
    borderColor: `${Colors.warning}55`,
    borderRadius: Radius.md,
    padding: 12,
  },
  refundTitle: { fontSize: FontSize.sm, fontWeight: '800', color: Colors.text },
  refundSub: { fontSize: FontSize.xs, color: Colors.textTertiary },
  refundReason: { fontSize: FontSize.sm, color: Colors.textSecondary, fontStyle: 'italic' },
  total: { fontSize: FontSize.sm, color: Colors.textSecondary },
  totalNum: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  input: { borderWidth: 1, borderColor: Colors.borderStrong, borderRadius: Radius.md, paddingHorizontal: Spacing.md, paddingVertical: 12, fontSize: FontSize.md, color: Colors.text },
  reasonRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 13,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
  },
  reasonActive: { borderColor: Colors.primaryDark, backgroundColor: Colors.primarySoft },
});
