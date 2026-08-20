import { useRouter } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import {
  Btn,
  Card,
  Divider,
  EmptyState,
  Icon,
  MoneyText,
  Row,
  Screen,
} from '@/components/ui';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { track } from '@/lib/analytics';
import { formatTZS } from '@/lib/format';
import { idempotencyKey } from '@/lib/idempotency';
import { getGroupOrdersRepository } from '@/repos';
import { cartItemKey, groupSubtotal, useCartStore } from '@/store/cart';
import { useSessionStore } from '@/store/session';
import { toast } from '@/store/ui';
import type { CartGroup } from '@/store/cart';

export default function CartScreen() {
  const router = useRouter();
  const groups = useCartStore((s) => s.groups);
  const updateQuantity = useCartStore((s) => s.updateQuantity);
  const removeItem = useCartStore((s) => s.removeItem);
  const clearGroup = useCartStore((s) => s.clearGroup);
  const [startingGroup, setStartingGroup] = useState<string | null>(null);

  // Meituan 拼单 parity (docs/CONTRACT-ADDITIONS.md #11, mock-only until the
  // contract ships a shared-cart resource): start a group order from this
  // cart group — create the shared session, copy the cart lines in as the
  // local member's items, then open the session screen.
  const startGroupOrder = async (group: CartGroup) => {
    const user = useSessionStore.getState().user;
    if (!user || !user.fullName) {
      toast(t('common.error'), 'error');
      return;
    }
    setStartingGroup(group.merchantId);
    try {
      const repo = getGroupOrdersRepository();
      const session = await repo.create(
        { merchantId: group.merchantId, title: group.merchantName },
        idempotencyKey(user.id, 'group-order'),
      );
      for (const line of group.items) {
        await repo.addItem(
          session.id,
          user.fullName,
          {
            catalogueItemId: line.catalogueItemId,
            quantity: line.quantity,
            // BASE price only — the server re-validates against the catalogue
            // (same rule as checkout) and prices options itself.
            unitPriceTZS: line.unitPriceTZS,
            options: [...(line.options ?? []).map((o) => o.choice).filter((c): c is string => !!c), ...(line.addons ?? [])],
          },
          idempotencyKey(user.id, 'group-order-item'),
        );
      }
      track({ name: 'group_order_started', merchantId: group.merchantId, groupOrderId: session.id });
      router.push(`/group-order/${session.id}`);
    } catch (e) {
      if (e instanceof ApiError) {
        switch (e.code) {
          case 'ORDER_ITEM_UNAVAILABLE':
            toast(t('cart.unavailable'), 'error');
            break;
          case 'ORDER_PRICE_CHANGED':
            toast(t('cart.priceChanged'), 'error');
            break;
          case 'ORDER_MERCHANT_CLOSED':
            toast(t('merchant.closed'), 'error');
            break;
          default:
            toast(e.message, 'error');
        }
      } else {
        toast(t('common.error'), 'error');
      }
    } finally {
      setStartingGroup(null);
    }
  };

  const renderGroup = ({ item }: { item: CartGroup }) => {
    const subtotal = groupSubtotal(item);
    return (
      <Card style={styles.group}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.groupName}>{item.merchantName}</Text>
          <Pressable onPress={() => clearGroup(item.merchantId)} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.close')}>
            <Icon name="close" size={18} color={Colors.textTertiary} />
          </Pressable>
        </Row>
        <Divider style={{ marginVertical: Spacing.md }} />
        {item.items.map((line) => {
          // Line identity mirrors the cart store cartItemKey so the stepper/
          // remove actions below target THIS variant line only (same item with
          // different options/addons is a separate line).
          const lineKey = cartItemKey(line);
          return (
          <Row key={lineKey} style={{ justifyContent: 'space-between', marginBottom: Spacing.md, alignItems: 'center' }}>
            <View style={{ flex: 1, paddingRight: Spacing.sm }}>
              <Text style={styles.itemName} numberOfLines={1}>{line.name}</Text>
              {line.options && line.options.length > 0 ? (
                <Text style={styles.itemMeta}>{line.options.map((o) => o.choice).join(' · ')}</Text>
              ) : null}
              {line.addons && line.addons.length > 0 ? (
                <Text style={styles.itemMeta}>{line.addons.join(' · ')}</Text>
              ) : null}
              {line.note ? <Text style={styles.itemMeta} numberOfLines={2}>{line.note}</Text> : null}
              <Text style={styles.itemMeta}>{formatTZS(line.unitPriceTZS + (line.optionsPriceTZS ?? 0))}</Text>
            </View>
            <Row gap={Spacing.sm} style={{ flexShrink: 0 }}>
              <Pressable
                onPress={() => updateQuantity(item.merchantId, lineKey, -1)}
                disabled={line.quantity <= 1}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`${line.name} decrease quantity`}
                accessibilityState={{ disabled: line.quantity <= 1 }}
                style={[styles.stepBtn, line.quantity <= 1 && { opacity: 0.4 }]}>
                <Icon name="remove" size={16} color={Colors.text} />
              </Pressable>
              <Text style={styles.qty} accessibilityLabel={`${line.quantity} items`}>{line.quantity}</Text>
              <Pressable
                onPress={() => updateQuantity(item.merchantId, lineKey, 1)}
                disabled={line.quantity >= 99}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`${line.name} increase quantity`}
                accessibilityState={{ disabled: line.quantity >= 99 }}
                style={[styles.stepBtn, line.quantity >= 99 && { opacity: 0.4 }]}>
                <Icon name="add" size={16} color={Colors.text} />
              </Pressable>
              <Pressable
                onPress={() => removeItem(item.merchantId, lineKey)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`${line.name} remove from cart`}
                style={[styles.stepBtn, { backgroundColor: Colors.dangerSoft, borderWidth: 1, borderColor: Colors.dangerSoft }]}>
                <Icon name="trash-outline" size={16} color={Colors.danger} />
              </Pressable>
            </Row>
          </Row>
        );})}
        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Text style={styles.groupName}>{t('cart.subtotal')}</Text>
          <MoneyText amountTZS={subtotal} size={FontSize.md} bold />
        </Row>
        {/* Checkout is per merchant: each group becomes its own order, and
            groups not being checked out stay in the cart. Group ordering
            (拼单) shares this cart with invited members instead. */}
        <Row gap={Spacing.md}>
          <Btn label={t('groupOrder.start')} onPress={() => startGroupOrder(item)} size="md" variant="outline" loading={startingGroup === item.merchantId} style={{ flex: 1 }} />
          <Btn label={t('cart.checkout')} onPress={() => router.push(`/checkout?merchantId=${item.merchantId}`)} size="md" style={{ flex: 1 }} />
        </Row>
      </Card>
    );
  };

  if (groups.length === 0) {
    return (
      <Screen>
        <EmptyState
          icon="cart-outline"
          title={t('cart.empty')}
          actionLabel={t('cart.browse')}
          onAction={() => router.replace('/home')}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg }}>
        <Text style={styles.title}>{t('cart.title')}</Text>
      </View>
      <FlatList
        data={groups}
        keyExtractor={(g) => g.merchantId}
        renderItem={renderGroup}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text, marginBottom: Spacing.md },
  group: { marginBottom: Spacing.md },
  groupName: { fontSize: FontSize.md, fontFamily: Fonts.sansBold, color: Colors.text },
  itemName: { fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, color: Colors.text },
  itemMeta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans },
  qty: { fontSize: FontSize.md, fontFamily: Fonts.sansBold, color: Colors.text, minWidth: 24, textAlign: 'center' },
  stepBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
});
