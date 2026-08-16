/* Shared dish/product configurator — extracted from the merchant dish sheet
 * (src/app/merchant/[merchantId].tsx) so the merchant screen and the product
 * route (/product/[merchantId]/[catalogueItemId]) render the SAME option and
 * addon flow (MASTER-BLUEPRINT §7 dish sheet / §8 product detail).
 *
 * The cart stores the BASE price only; option/addon prices are resolved
 * server-side from the option keys (order line = base + option prices).
 * This component never touches the cart store — it builds a CartItem and
 * hands it to onAdd, so every caller owns its store/analytics side effects.
 */
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Btn, Divider, Icon, MoneyText, Row, SheetModal } from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import type { CartItem } from '@/store/cart';
import type { CatalogueItem } from '@hudumika/contract';

interface Selection {
  group: string;
  choice: string;
}

/** Minimal merchant context the configurator needs to build cart items and
 * gate the Add button — the full MerchantPublic is not required. */
export interface DishMerchantCtx {
  id: string;
  businessName: string;
  isOpen: boolean;
}

export interface DishConfiguratorProps {
  item: CatalogueItem;
  merchant: DishMerchantCtx;
  /** Renders the quantity stepper (full product screen); the sheet keeps 1. */
  showQuantity?: boolean;
  onAdd?: (cartItem: CartItem) => void;
}

const clampQty = (q: number) => Math.min(99, Math.max(1, Math.round(q)));

export function DishConfigurator({ item, merchant, showQuantity = false, onAdd }: DishConfiguratorProps) {
  const [quantity, setQuantity] = useState(1);
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const [addons, setAddons] = useState<Record<string, boolean>>({});

  // Fresh config per item — the same reset the merchant sheet did on open.
  // Deps are the item's stable identity only: the options/addons arrays are
  // re-cloned on every catalogue refetch, so including them would wipe the
  // user's selections mid-configuration.
  useEffect(() => {
    const initial: Record<string, Selection> = {};
    for (const opt of item.options ?? []) {
      const first = opt.choices[0];
      if (first) initial[opt.name] = { group: opt.name, choice: first.label };
    }
    setSelections(initial);
    setAddons({});
    setQuantity(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, item.name]);

  const addToCart = () => {
    const choices = Object.values(selections).map((s) => ({ group: s.group, choice: s.choice }));
    const addonNames = Object.entries(addons)
      .filter(([, on]) => on)
      .map(([name]) => name);
    const optionsPriceTZS =
      choices.reduce((acc, s) => {
        const opt = (item.options ?? []).find((o) => o.name === s.group);
        return acc + (opt?.choices.find((c) => c.label === s.choice)?.priceTZS ?? 0);
      }, 0) +
      addonNames.reduce((acc, name) => acc + ((item.addons ?? []).find((a) => a.name === name)?.priceTZS ?? 0), 0);
    onAdd?.({
      catalogueItemId: item.id ?? item.name,
      name: item.name,
      unitPriceTZS: item.priceTZS,
      quantity: showQuantity ? clampQty(quantity) : 1,
      options: choices,
      addons: addonNames.length > 0 ? addonNames : undefined,
      optionsPriceTZS,
    });
  };

  return (
    <View style={{ gap: Spacing.md }}>
      {(item.options ?? []).map((opt) => (
        <View key={opt.name}>
          <Text style={styles.optionLabel}>{opt.name}</Text>
          <View style={{ gap: Spacing.sm }}>
            {opt.choices.map((choice) => {
              const selected = selections[opt.name]?.choice === choice.label;
              return (
                <Pressable
                  key={choice.label}
                  onPress={() => setSelections((s) => ({ ...s, [opt.name]: { group: opt.name, choice: choice.label } }))}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  style={[styles.choiceRow, selected && styles.choiceSelected]}>
                  <Text style={[styles.choiceText, selected && { color: Colors.primaryDeep, fontFamily: Fonts.sansBold }]}>{choice.label}</Text>
                  {choice.priceTZS > 0 ? <MoneyText amountTZS={choice.priceTZS} size={FontSize.xs} /> : null}
                  <Icon name={selected ? 'radio-button-on' : 'radio-button-off'} size={18} color={selected ? Colors.primary : Colors.borderStrong} />
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
      {(item.addons ?? []).length > 0 ? (
        <View>
          <Text style={styles.optionLabel}>{t('cart.extras')}</Text>
          <View style={{ gap: Spacing.sm }}>
            {item.addons!.map((addon) => (
              <Pressable
                key={addon.name}
                onPress={() => setAddons((a) => ({ ...a, [addon.name]: !a[addon.name] }))}
                accessibilityRole="button"
                accessibilityState={{ checked: !!addons[addon.name] }}
                style={styles.choiceRow}>
                <Text style={styles.choiceText}>{addon.name}</Text>
                <MoneyText amountTZS={addon.priceTZS} size={FontSize.xs} />
                <Icon name={addons[addon.name] ? 'checkbox' : 'square-outline'} size={18} color={addons[addon.name] ? Colors.primary : Colors.borderStrong} />
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
      {showQuantity ? (
        <View>
          <Text style={styles.optionLabel}>{t('product.quantity')}</Text>
          <Row gap={Spacing.md} style={{ justifyContent: 'space-between' }}>
            <Pressable
              onPress={() => setQuantity((q) => clampQty(q - 1))}
              accessibilityRole="button"
              accessibilityLabel={t('common.back')}
              style={styles.qtyBtn}>
              <Icon name="remove" size={18} color={Colors.text} />
            </Pressable>
            <Text style={styles.qty}>{quantity}</Text>
            <Pressable
              onPress={() => setQuantity((q) => clampQty(q + 1))}
              accessibilityRole="button"
              accessibilityLabel={t('common.next')}
              style={styles.qtyBtn}>
              <Icon name="add" size={18} color={Colors.text} />
            </Pressable>
          </Row>
        </View>
      ) : null}
      <Divider />
      <Btn
        label={showQuantity ? t('product.addToCart') : t('cart.title')}
        onPress={addToCart}
        icon="cart"
        size="lg"
        disabled={!merchant.isOpen}
      />
    </View>
  );
}

/** Bottom-sheet variant used by the merchant screen — price header + the
 * shared configurator, with an optional "View details" link into the full
 * product route. Behavior matches the pre-refactor merchant dish sheet. */
export function DishSheet({
  item,
  merchant,
  visible,
  onClose,
  onAdd,
  onViewDetails,
}: {
  item: CatalogueItem;
  merchant: DishMerchantCtx;
  visible: boolean;
  onClose: () => void;
  onAdd?: (cartItem: CartItem) => void;
  onViewDetails?: () => void;
}) {
  return (
    <SheetModal visible={visible} onClose={onClose} title={item.name}>
      <View style={{ gap: Spacing.md }}>
        <MoneyText amountTZS={item.priceTZS} size={FontSize.lg} bold />
        <DishConfigurator item={item} merchant={merchant} onAdd={onAdd} />
        {onViewDetails ? (
          <Btn
            label={t('product.viewDetails')}
            onPress={onViewDetails}
            variant="ghost"
            size="sm"
            icon="arrow-forward"
            style={{ alignSelf: 'center' }}
          />
        ) : null}
      </View>
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  optionLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sansSemibold, marginBottom: Spacing.sm },
  choiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
  },
  choiceSelected: { borderColor: Colors.primary, backgroundColor: Colors.primarySoft },
  choiceText: { flex: 1, fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansMedium },
  qtyBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qty: { fontSize: FontSize.xl, fontFamily: Fonts.sansBold, color: Colors.text, fontVariant: ['tabular-nums'] },
});
