/* Shared dish/product configurator — extracted from the merchant dish sheet
 * (src/app/merchant/[merchantId].tsx) so the merchant screen and the product
 * route (/product/[merchantId]/[catalogueItemId]) render the SAME option and
 * addon flow (MASTER-BLUEPRINT §7 dish sheet / §8 product detail).
 *
 * Required single-select: size/crust (and by extension every option group)
 * must be chosen before Add is enabled — the sheet starts with NO selection so
 * the requirement is visible. Multi-addon: every addon is an independent toggle
 * whose price delta is summed into the live preview. Matrix validation checks
 * that every selected choice / addon maps to the catalogue and that the
 * combination is allowed (future matrix data will surface here). Money is
 * integer TZS end-to-end — every price delta and preview is Math.round'd.
 *
 * The cart stores the BASE price only; option/addon prices are resolved
 * server-side from the option keys (order line = base + option prices).
 * This component never touches the cart store — it builds a CartItem and
 * hands it to onAdd, so every caller owns its store/analytics side effects.
 */
import { useEffect, useMemo, useState } from 'react';
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

// Groups that are always single-select + required when present. The catalogue
// has no required flag, so size/crust are the canonical required groups;
// when neither exists every option group is treated as required (keeps the
// configurator honest for dishes that only have a Size group).
const REQUIRED_SINGLE = new Set(['size', 'crust']);

function requiredOptionsFor(item: CatalogueItem) {
  const opts = item.options ?? [];
  const explicit = opts.filter((o) => REQUIRED_SINGLE.has(o.name.toLowerCase()));
  return explicit.length > 0 ? explicit : opts;
}

/** Matrix validation — single-select groups must map to a real catalogue choice,
 * addons must map to a real addon, prices must be integer TZS, and the
 * combination must be allowed. The catalogue carries no explicit matrix today,
 * so the only invalid combos are unknown keys; future matrix data (allowed
 * size × crust pairs) will be checked here and will surface as a user-facing
 * error that disables Add.
 */
function validateMatrix(
  item: CatalogueItem,
  selections: Record<string, Selection>,
  addons: Record<string, boolean>,
): string | null {
  for (const sel of Object.values(selections)) {
    const opt = (item.options ?? []).find((o) => o.name === sel.group);
    if (!opt) return `Unknown option group ${sel.group}`;
    const choice = opt.choices.find((c) => c.label === sel.choice);
    if (!choice) return `Unknown choice ${sel.choice} for ${sel.group}`;
    if (!Number.isInteger(choice.priceTZS)) return `Invalid price for ${sel.choice}`;
  }
  for (const [name, on] of Object.entries(addons)) {
    if (!on) continue;
    const ad = (item.addons ?? []).find((a) => a.name === name);
    if (!ad) return `Unknown addon ${name}`;
    if (!Number.isInteger(ad.priceTZS)) return `Invalid addon price for ${name}`;
  }
  return null;
}

export function DishConfigurator({ item, merchant, showQuantity = false, onAdd }: DishConfiguratorProps) {
  const [quantity, setQuantity] = useState(1);
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const [addons, setAddons] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setSelections({});
    setAddons({});
    setQuantity(1);
  }, [item.id, item.name]);

  const missingRequired = useMemo(() => {
    const req = requiredOptionsFor(item);
    return req.filter((opt) => !selections[opt.name]);
  }, [item, selections]);

  const addonNames = useMemo(
    () => Object.entries(addons).filter(([, on]) => on).map(([name]) => name),
    [addons],
  );

  const optionsPriceTZS = useMemo(() => {
    const choiceDelta = Object.values(selections).reduce((acc, s) => {
      const opt = (item.options ?? []).find((o) => o.name === s.group);
      const price = opt?.choices.find((c) => c.label === s.choice)?.priceTZS ?? 0;
      return acc + Math.round(price);
    }, 0);
    const addonDelta = addonNames.reduce((acc, name) => {
      const ad = (item.addons ?? []).find((a) => a.name === name);
      return acc + Math.round(ad?.priceTZS ?? 0);
    }, 0);
    return Math.round(choiceDelta + addonDelta);
  }, [item.options, item.addons, selections, addonNames]);

  const unitTotalTZS = useMemo(() => Math.round(Math.round(item.priceTZS) + optionsPriceTZS), [item.priceTZS, optionsPriceTZS]);
  const previewQty = showQuantity ? clampQty(quantity) : 1;
  const totalPreviewTZS = useMemo(() => Math.round(unitTotalTZS * previewQty), [unitTotalTZS, previewQty]);

  const matrixError = useMemo(() => validateMatrix(item, selections, addons), [item, selections, addons]);
  const canAdd = merchant.isOpen && missingRequired.length === 0 && !matrixError;

  const addToCart = () => {
    if (!canAdd) return;
    const choices = Object.values(selections).map((s) => ({ group: s.group, choice: s.choice }));
    const names = [...addonNames];
    const delta = Math.round(optionsPriceTZS);
    onAdd?.({
      catalogueItemId: item.id ?? item.name,
      name: item.name,
      unitPriceTZS: Math.round(item.priceTZS),
      quantity: previewQty,
      options: choices,
      addons: names.length > 0 ? names : undefined,
      optionsPriceTZS: delta,
    });
  };

  return (
    <View style={{ gap: Spacing.md }}>
      {(item.options ?? []).map((opt) => {
        const isRequired = requiredOptionsFor(item).some((r) => r.name === opt.name);
        const missing = !selections[opt.name] && isRequired;
        return (
          <View key={opt.name}>
            <Row gap={Spacing.sm} style={{ alignItems: 'center', marginBottom: Spacing.sm }}>
              <Text style={styles.optionLabel}>{opt.name}</Text>
              {isRequired ? <Text style={styles.requiredMark}>* {t('booking.questions.required')}</Text> : null}
            </Row>
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
                    {choice.priceTZS !== 0 ? (
                      <Text style={[styles.deltaText, selected && { color: Colors.primaryDeep }]}>
                        {choice.priceTZS > 0 ? `+${Math.round(choice.priceTZS)}` : `${Math.round(choice.priceTZS)}`} TZS
                      </Text>
                    ) : null}
                    {choice.priceTZS > 0 ? <MoneyText amountTZS={Math.round(choice.priceTZS)} size={FontSize.xs} /> : null}
                    <Icon name={selected ? 'radio-button-on' : 'radio-button-off'} size={18} color={selected ? Colors.primary : Colors.borderStrong} />
                  </Pressable>
                );
              })}
            </View>
            {missing ? <Text style={styles.validationError}>Select {opt.name} — required</Text> : null}
          </View>
        );
      })}
      {(item.addons ?? []).length > 0 ? (
        <View>
          <Text style={styles.optionLabel}>{t('cart.extras')}</Text>
          <Text style={styles.helperText}>Multi-select — price delta added before Add</Text>
          <View style={{ gap: Spacing.sm, marginTop: Spacing.sm }}>
            {item.addons!.map((addon) => (
              <Pressable
                key={addon.name}
                onPress={() => setAddons((a) => ({ ...a, [addon.name]: !a[addon.name] }))}
                accessibilityRole="button"
                accessibilityState={{ checked: !!addons[addon.name] }}
                style={[styles.choiceRow, addons[addon.name] && styles.choiceSelected]}>
                <Text style={styles.choiceText}>{addon.name}</Text>
                <Text style={[styles.deltaText, addons[addon.name] && { color: Colors.primaryDeep }]}>+{Math.round(addon.priceTZS)} TZS</Text>
                <MoneyText amountTZS={Math.round(addon.priceTZS)} size={FontSize.xs} />
                <Icon name={addons[addon.name] ? 'checkbox' : 'square-outline'} size={18} color={addons[addon.name] ? Colors.primary : Colors.borderStrong} />
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
      {showQuantity ? (
        <View>
          <Text style={styles.optionLabel}>{t('product.quantity')}</Text>
          <Row gap={Spacing.md} style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <Pressable
              onPress={() => setQuantity((q) => clampQty(q - 1))}
              accessibilityRole="button"
              accessibilityLabel={t('common.back')}
              style={styles.qtyBtn}>
              <Icon name="remove" size={18} color={Colors.text} />
            </Pressable>
            <Text style={styles.qty}>{clampQty(quantity)}</Text>
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
      <View style={styles.previewRow}>
        <Text style={styles.previewLabel}>{t('cart.subtotal')}</Text>
        <MoneyText amountTZS={totalPreviewTZS} size={FontSize.lg} bold />
      </View>
      {optionsPriceTZS > 0 ? <Text style={styles.helperText}>Includes +{optionsPriceTZS} TZS options/addons delta (integer TZS)</Text> : null}
      {missingRequired.length > 0 ? (
        <Text style={styles.validationError}>
          Select required: {missingRequired.map((o) => o.name).join(' · ')} before Add
        </Text>
      ) : null}
      {matrixError ? <Text style={styles.validationError}>{matrixError} — matrix validation failed</Text> : null}
      <Divider />
      <Btn
        label={showQuantity ? `${t('product.addToCart')} · ${totalPreviewTZS} TZS` : `${t('cart.title')} · ${totalPreviewTZS} TZS`}
        onPress={addToCart}
        icon="cart"
        size="lg"
        disabled={!canAdd}
      />
      {!merchant.isOpen ? <Text style={styles.validationError}>{t('merchant.closed')}</Text> : null}
    </View>
  );
}

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
        <MoneyText amountTZS={Math.round(item.priceTZS)} size={FontSize.lg} bold />
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
  requiredMark: { fontSize: FontSize.xs, color: Colors.danger, fontFamily: Fonts.sansBold },
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
  deltaText: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sansMedium, fontVariant: ['tabular-nums'] },
  validationError: { fontSize: FontSize.xs, color: Colors.danger, fontFamily: Fonts.sansSemibold, marginTop: Spacing.sm },
  helperText: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  previewRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: Spacing.sm },
  previewLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sansSemibold },
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
