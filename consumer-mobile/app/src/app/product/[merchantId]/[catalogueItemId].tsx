/* Product (catalogue item) detail — MASTER-BLUEPRINT §8: images, description,
 * price + compare-at, stock, options/addons (the contract's variant
 * mechanism), quantity stepper, add to cart, plus honest markers where the
 * contract lacks a surface (per-item reviews, related products, combos).
 *
 * Route is /product/[merchantId]/[catalogueItemId] (NOT the blueprint's
 * /product/:catalogueItemId) because the contract has no find-item-by-id
 * endpoint — GET /catalogues/{merchantId} is the only item surface, so the
 * item always resolves through its merchant's catalogue.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Btn, Card, EmptyState, ErrorState, Icon, MoneyText, Pill, Row, Screen, SkeletonCard } from '@/components/ui';
import { DishConfigurator, type DishMerchantCtx } from '@/components/DishSheet';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { findCatalogueItem } from '@/lib/catalogue';
import { formatTZS } from '@/lib/format';
import { track } from '@/lib/analytics';
import { toast } from '@/store/ui';
import { useCartStore, type CartItem } from '@/store/cart';
import { getMerchantsRepository } from '@/repos';
import type { CatalogueItem, MerchantPublic } from '@hudumika/contract';

export default function ProductScreen() {
  const router = useRouter();
  const { merchantId, catalogueItemId } = useLocalSearchParams<{ merchantId: string; catalogueItemId: string }>();
  const [merchant, setMerchant] = useState<MerchantPublic | null>(null);
  const [item, setItem] = useState<CatalogueItem | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    setNotFound(false);
    try {
      const [m, catalogue] = await Promise.all([
        getMerchantsRepository().get(merchantId),
        getMerchantsRepository().getCatalogue(merchantId),
      ]);
      setMerchant(m);
      const found = findCatalogueItem(merchantId, catalogueItemId, catalogue);
      if (!found) {
        setNotFound(true);
        return;
      }
      setItem(found);
    } catch {
      setError(t('common.error'));
    }
  }, [merchantId, catalogueItemId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    track({ name: 'product_viewed', merchantId, catalogueItemId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addToCart = (cartItem: CartItem) => {
    if (!merchant) return;
    useCartStore.getState().addItem({ merchantId: merchant.id, merchantName: merchant.businessName }, cartItem);
    track({ name: 'cart_item_added', merchantId: merchant.id, catalogueItemId: cartItem.catalogueItemId, quantity: cartItem.quantity });
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    toast(t('product.added'));
  };

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (notFound) {
    return (
      <Screen>
        <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
        </View>
        <EmptyState icon="cube-outline" title={t('product.notFound')} />
      </Screen>
    );
  }

  if (!merchant || !item) {
    return (
      <Screen>
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={2} />
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  const soldOut = item.available === false;
  const merchantCtx: DishMerchantCtx = { id: merchant.id, businessName: merchant.businessName, isOpen: merchant.isOpen };
  const pct =
    item.originalPriceTZS != null && item.originalPriceTZS > item.priceTZS
      ? Math.round((1 - item.priceTZS / item.originalPriceTZS) * 100)
      : 0;

  return (
    <Screen scroll>
      <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
        <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
        <Text style={styles.title}>{t('product.title')}</Text>
        <View style={{ width: 40 }} />
      </Row>

      <Card style={{ gap: Spacing.md }}>
        {/* Images: the catalogue carries a single imageUrl (null in the mock
            seed) — a placeholder renders when absent; no gallery exists. */}
        {item.imageUrl ? (
          <View style={styles.image}>
            <Icon name="image-outline" size={40} color={Colors.textFaint} />
          </View>
        ) : (
          <View style={styles.image}>
            <Icon name={item.emoji ? 'restaurant' : 'cube'} size={40} color={Colors.textFaint} />
            {item.emoji ? <Text style={styles.emoji}>{item.emoji}</Text> : null}
          </View>
        )}
        <Row gap={Spacing.sm}>
          <Pill label={soldOut ? t('product.soldOut') : t('product.inStock')} tone={soldOut ? 'danger' : 'success'} />
          <Pill label={item.category} tone="info" />
        </Row>
        <Text style={styles.name}>{item.name}</Text>
        {item.description ? <Text style={styles.desc}>{item.description}</Text> : null}
        <Row gap={Spacing.md}>
          {pct > 0 ? (
            <View style={styles.discountBadge}>
              <Text style={styles.discountText}>−{pct}%</Text>
            </View>
          ) : null}
          <View>
            {item.originalPriceTZS != null && item.originalPriceTZS > item.priceTZS ? (
              <Text style={styles.oldPrice}>{formatTZS(item.originalPriceTZS)}</Text>
            ) : null}
            <MoneyText amountTZS={item.priceTZS} size={FontSize.xxl} bold />
          </View>
        </Row>
      </Card>

      <Text style={styles.section}>{t('product.details')}</Text>
      <Card style={{ gap: Spacing.md }}>
        {item.description ? (
          <Text style={styles.desc}>{item.description}</Text>
        ) : (
          <Text style={styles.meta}>{t('product.noDescription')}</Text>
        )}
        {/* Attributes beyond description are not in the contract
            (CatalogueItem: description/category/imageUrl/videoUrl/emoji/
            options/addons/comboItems — no key/value attributes), so the
            section renders only what the catalogue actually ships. */}
      </Card>

      <Text style={styles.section}>{t('product.options')}</Text>
      <Card style={{ gap: Spacing.md }}>
        <DishConfigurator item={item} merchant={merchantCtx} showQuantity onAdd={addToCart} />
      </Card>

      {/* Per-item reviews have no consumer endpoint (GET /reviews needs a
          target type/id the catalogue item cannot provide) — honest marker. */}
      <Card style={[styles.comingSoon, { marginTop: Spacing.lg }]}>
        <Row gap={Spacing.sm}>
          <Icon name="star-outline" size={16} color={Colors.textTertiary} />
          <Text style={styles.meta}>{t('product.reviewsComingSoon')}</Text>
        </Row>
      </Card>

      {/* Related products have no endpoint — honest marker. */}
      <Card style={styles.comingSoon}>
        <Row gap={Spacing.sm}>
          <Icon name="git-compare-outline" size={16} color={Colors.textTertiary} />
          <Text style={styles.meta}>{t('product.relatedComingSoon')}</Text>
        </Row>
      </Card>

      {/* Combo items exist on the DTO but the cart carries options/addons
          only — no combo purchase surface yet. */}
      {(item.comboItems ?? []).length > 0 ? (
        <Card style={styles.comingSoon}>
          <Row gap={Spacing.sm}>
            <Icon name="layers-outline" size={16} color={Colors.textTertiary} />
            <Text style={styles.meta}>{t('product.comboComingSoon')}</Text>
          </Row>
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text, flex: 1, textAlign: 'center' },
  name: { fontSize: FontSize.xl, fontFamily: Fonts.sansExtraBold, color: Colors.text },
  desc: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sans, lineHeight: 19 },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans },
  section: { fontSize: FontSize.lg, fontFamily: Fonts.sansExtraBold, color: Colors.text, marginBottom: Spacing.sm, marginTop: Spacing.lg },
  image: {
    height: 160,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: { fontSize: 28, marginTop: 4 },
  oldPrice: { fontSize: FontSize.sm, color: Colors.textFaint, fontFamily: Fonts.sansMedium, textDecorationLine: 'line-through' },
  discountBadge: { backgroundColor: Colors.danger, borderRadius: Radius.sm, paddingHorizontal: 8, paddingVertical: 4, alignSelf: 'flex-start' },
  discountText: { color: Colors.white, fontSize: FontSize.xs, fontFamily: Fonts.sansExtraBold },
  comingSoon: { gap: Spacing.sm, marginTop: Spacing.md },
});
