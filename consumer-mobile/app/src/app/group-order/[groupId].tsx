/* Group order (拼单 — Meituan shared-order parity, docs/CONTRACT-ADDITIONS.md
 * #11, mock-only until the contract ships a shared-cart resource).
 *
 * A shared cart session: members add their own items, one payer converts the
 * session into a real order at the end. The mock is honest about scope — no
 * realtime presence: members are the seeded local user + invited "Juma"
 * (module-local to the mock); the session expires on a clock and every
 * mutation rejects with 409 CONFLICT once it has. This screen refetches on
 * mount (deep-link/notification entry included — 404 renders "not visible").
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, Share, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import {
  Btn,
  Card,
  Divider,
  EmptyState,
  ErrorState,
  Icon,
  MoneyText,
  Pill,
  PriceBreakdown,
  Row,
  Screen,
  SheetModal,
  SkeletonCard,
} from '@/components/ui';
import { useDealClock } from '@/components/DealCountdown';
import { Colors, Fonts, FontSize, NumberStyle, Spacing } from '@/constants/theme';
import { t, type I18nKey } from '@/i18n';
import { track } from '@/lib/analytics';
import { countdownISO } from '@/lib/dates';
import { formatTZS } from '@/lib/format';
import { idempotencyKey } from '@/lib/idempotency';
import { pickDefaultMethod } from '@/lib/payments';
import { getGroupOrdersRepository, getMerchantsRepository, getPaymentsRepository, type GroupOrder, type PaymentMethodRecord } from '@/repos';
import { useAddressesStore } from '@/store/addresses';
import { useSessionStore } from '@/store/session';
import { toast } from '@/store/ui';
import type { Catalogue, CatalogueItem, OrderCreatePaymentMethod } from '@hudumika/contract';

// Fallback only while GET /payments/methods is unreachable — the server list wins.
const FALLBACK_METHODS: PaymentMethodRecord[] = [
  { id: 'pm_mpesa', method: 'mpesa', label: t('payments.mpesa') },
  { id: 'pm_tigo', method: 'tigo_pesa', label: t('payments.tigoPesa') },
  { id: 'pm_airtel', method: 'airtel_money', label: t('payments.airtelMoney') },
  { id: 'pm_card', method: 'card', label: t('payments.card') },
  { id: 'pm_cod', method: 'cod', label: t('payments.cod') },
];

const STATUS_TONE: Record<GroupOrder['status'], 'danger' | 'warning' | 'info' | 'success' | 'neutral'> = {
  open: 'success',
  ordered: 'info',
  expired: 'neutral',
};

export default function GroupOrderScreen() {
  const router = useRouter();
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const user = useSessionStore((s) => s.user);
  const addresses = useAddressesStore((s) => s.addresses);
  const selectedAddressId = useAddressesStore((s) => s.selectedId);

  const [session, setSession] = useState<GroupOrder | null>(null);
  const [merchantName, setMerchantName] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [adding, setAdding] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [methods, setMethods] = useState<PaymentMethodRecord[] | null>(null);
  const [method, setMethod] = useState<OrderCreatePaymentMethod>('mpesa');
  const [methodSheet, setMethodSheet] = useState(false);
  const [addressSheet, setAddressSheet] = useState(false);
  useDealClock(); // re-render so the countdown ticks down every minute

  const myName = user?.fullName ?? '';
  const selectedAddress = addresses.find((a) => a.id === selectedAddressId) ?? addresses[0];
  const ownMember = session?.members.find((m) => m.name === myName);
  const creatorName = session?.members[0]?.name ?? '';

  const load = useCallback(async () => {
    setError('');
    try {
      const repo = getGroupOrdersRepository();
      const current = await repo.get(groupId);
      setSession(current);
      setMerchantName((await getMerchantsRepository().get(current.merchantId)).businessName);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? t('groupOrder.notFound') : t('common.error'));
    }
  }, [groupId]);

  useEffect(() => {
    load();
    getPaymentsRepository()
      .getPaymentMethods()
      .then((list) => {
        if (list.length > 0) {
          setMethods(list);
          const preferred = pickDefaultMethod(list);
          if (preferred) setMethod(preferred.method as OrderCreatePaymentMethod);
        }
      })
      .catch(() => setMethods(FALLBACK_METHODS));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openPicker = async () => {
    setPickerOpen(true);
    if (!catalogue && session) {
      try {
        const c = await getMerchantsRepository().getCatalogue(session.merchantId);
        setCatalogue(c);
        setQuantities(
          Object.fromEntries(c.items.filter((i) => i.available !== false && i.id).map((i) => [i.id as string, 1])),
        );
      } catch {
        toast(t('common.error'), 'error');
      }
    }
  };

  const closePicker = () => {
    setPickerOpen(false);
    setQuantities({});
  };

  const addItems = async () => {
    if (!session || !myName || !catalogue) return;
    setAdding(true);
    try {
      const repo = getGroupOrdersRepository();
      let updated = session;
      for (const item of catalogue.items) {
        if (!item.id) continue;
        const qty = quantities[item.id] ?? 0;
        if (qty < 1) continue;
        updated = await repo.addItem(
          session.id,
          myName,
          { catalogueItemId: item.id, quantity: qty },
          idempotencyKey(user?.id ?? 'customer', 'group-order-add'),
        );
      }
      setSession(updated);
      setNotice('');
      closePicker();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFLICT') {
        // Session expired/finalized while picking — refetch and show the state.
        closePicker();
        load();
      } else if (e instanceof ApiError) {
        toast(e.message, 'error');
      } else {
        toast(t('common.error'), 'error');
      }
    } finally {
      setAdding(false);
    }
  };

  const removeOwnItem = async (catalogueItemId: string) => {
    if (!session || !myName) return;
    try {
      setSession(
        await getGroupOrdersRepository().removeItem(
          session.id,
          myName,
          catalogueItemId,
          idempotencyKey(user?.id ?? 'customer', 'group-order-remove'),
        ),
      );
      setNotice('');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFLICT') load();
      else if (e instanceof ApiError) toast(e.message, 'error');
      else toast(t('common.error'), 'error');
    }
  };

  const share = async () => {
    if (!session) return;
    try {
      await Share.share({ title: session.title, message: `hudumika://group-order/${session.id}` });
    } catch {
      toast(t('groupOrder.shareFailed'), 'error');
    }
  };

  const finalize = async () => {
    if (!session || !myName || !selectedAddress) return;
    setFinalizing(true);
    setNotice('');
    try {
      const order = await getGroupOrdersRepository().finalize(
        session.id,
        method,
        selectedAddress,
        idempotencyKey(user?.id ?? 'customer', 'group-order-finalize'),
      );
      track({ name: 'group_order_finalized', groupOrderId: session.id, orderId: order.id });
      toast(t('checkout.orderPlaced'));
      router.replace(`/order/confirmation/${order.id}`);
    } catch (e) {
      setFinalizing(false);
      if (e instanceof ApiError) {
        switch (e.code) {
          case 'ORDER_EMPTY':
            setNotice(t('groupOrder.addItemsFirst'));
            break;
          case 'ORDER_MERCHANT_CLOSED':
            setNotice(t('merchant.closed'));
            break;
          case 'ORDER_ITEM_UNAVAILABLE':
            setNotice(t('cart.unavailable'));
            load();
            break;
          case 'ORDER_PRICE_CHANGED':
            setNotice(t('cart.priceChanged'));
            load();
            break;
          case 'CONFLICT':
            // Session expired or already finalized — refetch and show the state.
            setNotice(t('groupOrder.finalizeFailed'));
            load();
            break;
          default:
            setNotice(t('groupOrder.finalizeFailed'));
        }
      } else {
        setNotice(t('groupOrder.finalizeFailed'));
      }
    }
  };

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (!session) {
    return (
      <Screen>
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  const canFinalize =
    !!ownMember &&
    session.status === 'open' &&
    session.members.some((m) => m.items.length > 0) &&
    !!selectedAddress;

  const totalsRows: { label: string; amountTZS: number; signed?: boolean }[] = [
    { label: t('breakdown.subtotal'), amountTZS: session.totals.subtotalTZS },
    { label: t('breakdown.delivery'), amountTZS: session.totals.deliveryFeeTZS },
    { label: t('breakdown.platform'), amountTZS: session.totals.platformFeeTZS },
  ];
  if (session.totals.taxTZS !== 0) totalsRows.push({ label: t('breakdown.tax'), amountTZS: session.totals.taxTZS });
  if (session.totals.discountTZS !== 0) totalsRows.push({ label: t('breakdown.discount'), amountTZS: session.totals.discountTZS, signed: true });

  const pickerItems = (catalogue?.items ?? []).filter((i): i is CatalogueItem & { id: string } => i.available !== false && !!i.id);

  return (
    <Screen scroll>
      <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
        <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
        <Text style={styles.title} numberOfLines={1}>{merchantName || session.title}</Text>
        <Pill label={t(`groupOrder.status.${session.status}` as I18nKey)} tone={STATUS_TONE[session.status]} />
      </Row>

      <Card style={{ gap: Spacing.md }}>
        <Text style={styles.name}>{session.title}</Text>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.meta}>
            {session.status === 'open' ? t('groupOrder.expiresIn', { t: countdownISO(session.expiresAt) }) : t(`groupOrder.status.${session.status}` as I18nKey)}
          </Text>
          <Btn label={t('groupOrder.share')} onPress={share} variant="ghost" size="sm" icon="share-social-outline" />
        </Row>
      </Card>

      <Text style={styles.sectionLabel}>{t('groupOrder.members')}</Text>
      {session.members.map((member) => {
        const isOwn = member.name === myName;
        return (
          <Card key={member.name} style={{ marginBottom: Spacing.md, gap: Spacing.sm }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{member.name}</Text>
                {!isOwn && creatorName ? <Text style={styles.meta}>{t('groupOrder.invitedBy', { name: creatorName })}</Text> : null}
              </View>
              <MoneyText amountTZS={member.subtotalTZS} size={FontSize.sm} bold />
            </Row>
            <Divider />
            {member.items.length === 0 ? (
              <Text style={styles.meta}>{t('groupOrder.empty')}</Text>
            ) : (
              member.items.map((line) => (
                <Row key={`${member.name}-${line.catalogueItemId}`} style={{ justifyContent: 'space-between' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemName} numberOfLines={1}>{line.quantity} × {line.catalogueItemId}</Text>
                    {line.options && line.options.length > 0 ? (
                      <Text style={styles.meta}>{line.options.join(' · ')}</Text>
                    ) : null}
                  </View>
                  <MoneyText amountTZS={line.unitPriceTZS * line.quantity} size={FontSize.sm} />
                  {isOwn ? (
                    <Pressable
                      onPress={() => removeOwnItem(line.catalogueItemId)}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={t('groupOrder.remove')}
                      style={styles.iconBtn}>
                      <Icon name="trash-outline" size={15} color={Colors.danger} />
                    </Pressable>
                  ) : null}
                </Row>
              ))
            )}
          </Card>
        );
      })}

      {session.status === 'open' && ownMember ? (
        <Btn label={t('groupOrder.addItem')} onPress={openPicker} variant="outline" icon="add" style={{ marginBottom: Spacing.lg }} />
      ) : null}

      <Card style={{ gap: Spacing.md }}>
        <Text style={styles.sectionLabel}>{t('checkout.reviewTotal')}</Text>
        <PriceBreakdown rows={totalsRows} totalTZS={session.totals.totalTZS} totalLabel={t('breakdown.total')} />
      </Card>

      {session.status === 'open' && ownMember ? (
        <Card style={{ marginTop: Spacing.lg, gap: Spacing.md }}>
          <Pressable onPress={() => setMethodSheet(true)} accessibilityRole="button" style={styles.rowPressable}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.sectionLabel}>{t('checkout.payment')}</Text>
              <Text style={styles.value}>{methods?.find((m) => m.method === method)?.label ?? t('checkout.payment')} ›</Text>
            </Row>
          </Pressable>
          <Divider />
          <Pressable
            onPress={() => (selectedAddress ? setAddressSheet(true) : router.push('/addresses'))}
            accessibilityRole="button"
            style={styles.rowPressable}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.sectionLabel}>{t('checkout.address')}</Text>
              <Text style={[styles.value, { flex: 1, textAlign: 'right' }]} numberOfLines={1}>
                {selectedAddress ? `${selectedAddress.label} — ${selectedAddress.lines}` : t('checkout.noAddress')} ›
              </Text>
            </Row>
          </Pressable>
          {notice ? <Text style={styles.errorText}>{notice}</Text> : null}
          <Btn
            label={t('groupOrder.finalize')}
            onPress={finalize}
            size="lg"
            loading={finalizing}
            disabled={!canFinalize}
          />
        </Card>
      ) : session.status === 'open' ? (
        <Text style={[styles.errorText, { marginTop: Spacing.lg, textAlign: 'center' }]}>{t('groupOrder.addItemsFirst')}</Text>
      ) : (
        <Text style={[styles.meta, { marginTop: Spacing.lg, textAlign: 'center' }]}>{t(`groupOrder.status.${session.status}` as I18nKey)}</Text>
      )}

      <SheetModal visible={pickerOpen} onClose={closePicker} title={t('groupOrder.addItem')}>
        {pickerItems.length === 0 ? (
          <EmptyState icon="restaurant-outline" title={t('dineIn.menuEmpty')} />
        ) : (
          <>
            <FlatList
              data={pickerItems}
              keyExtractor={(i) => i.id}
              showsVerticalScrollIndicator={false}
              style={{ maxHeight: 360 }}
              renderItem={({ item }) => (
                <Row style={{ justifyContent: 'space-between', paddingVertical: Spacing.sm }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemName} numberOfLines={1}>{item.name}</Text>
                    <Text style={styles.meta}>{formatTZS(item.priceTZS)}</Text>
                  </View>
                  <Row gap={Spacing.sm}>
                    <Pressable
                      onPress={() => setQuantities((q) => ({ ...q, [item.id]: Math.max(0, (q[item.id] ?? 1) - 1) }))}
                      accessibilityRole="button"
                      style={styles.iconBtn}>
                      <Icon name="remove" size={16} color={Colors.text} />
                    </Pressable>
                    <Text style={[styles.qty, { fontVariant: NumberStyle.fontVariant }]}>{quantities[item.id] ?? 1}</Text>
                    <Pressable
                      onPress={() => setQuantities((q) => ({ ...q, [item.id]: Math.min(99, (q[item.id] ?? 1) + 1) }))}
                      accessibilityRole="button"
                      style={styles.iconBtn}>
                      <Icon name="add" size={16} color={Colors.text} />
                    </Pressable>
                  </Row>
                </Row>
              )}
            />
            <Btn label={t('groupOrder.addItem')} onPress={addItems} loading={adding} />
          </>
        )}
      </SheetModal>

      <SheetModal visible={methodSheet} onClose={() => setMethodSheet(false)} title={t('checkout.payment')}>
        {(methods ?? FALLBACK_METHODS).map((m) => (
          <Pressable
            key={m.id}
            onPress={() => {
              setMethod(m.method as OrderCreatePaymentMethod);
              setMethodSheet(false);
            }}
            accessibilityRole="button"
            accessibilityState={{ selected: method === m.method }}
            style={[styles.methodRow, method === m.method && styles.methodSelected]}>
            <Text style={[styles.value, { flex: 1 }]}>{m.label}</Text>
            <Icon name={method === m.method ? 'radio-button-on' : 'radio-button-off'} size={18} color={method === m.method ? Colors.primary : Colors.borderStrong} />
          </Pressable>
        ))}
      </SheetModal>

      <SheetModal visible={addressSheet} onClose={() => setAddressSheet(false)} title={t('checkout.address')}>
        {addresses.length === 0 ? (
          <EmptyState icon="location-outline" title={t('addresses.empty')} />
        ) : (
          addresses.map((a) => (
            <Pressable
              key={a.id}
              onPress={() => {
                useAddressesStore.getState().select(a.id);
                setAddressSheet(false);
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: a.id === selectedAddress?.id }}
              style={[styles.methodRow, a.id === selectedAddress?.id && styles.methodSelected]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.value}>{a.label} — {a.lines}</Text>
                <Text style={styles.meta}>{a.landmark}</Text>
              </View>
              <Icon name={a.id === selectedAddress?.id ? 'radio-button-on' : 'radio-button-off'} size={18} color={a.id === selectedAddress?.id ? Colors.primary : Colors.borderStrong} />
            </Pressable>
          ))
        )}
        <Btn label={t('addresses.add')} onPress={() => router.push('/addresses')} variant="ghost" />
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text, flex: 1, textAlign: 'center' },
  name: { fontSize: FontSize.md, fontFamily: Fonts.sansBold, color: Colors.text },
  itemName: { fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, color: Colors.text },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  value: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansMedium },
  sectionLabel: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sansSemibold, marginVertical: Spacing.sm },
  qty: { fontSize: FontSize.md, fontFamily: Fonts.sansBold, color: Colors.text, minWidth: 24, textAlign: 'center' },
  errorText: { color: Colors.danger, fontSize: FontSize.xs, fontFamily: Fonts.sansSemibold, marginTop: Spacing.sm },
  iconBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center' },
  methodRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
  },
  methodSelected: { borderColor: Colors.primary, backgroundColor: Colors.primarySoft },
  rowPressable: { paddingVertical: Spacing.xs },
});
