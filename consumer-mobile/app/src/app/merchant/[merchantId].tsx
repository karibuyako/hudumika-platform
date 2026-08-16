import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  Btn,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  MoneyText,
  Pill,
  Rating,
  Row,
  Screen,
  SkeletonCard,
} from '@/components/ui';
import { DishSheet } from '@/components/DishSheet';
import { CartBar } from '@/components/CartBar';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { ApiError } from '@/api/client';
import { getConversationsRepository, getCouponsRepository, getFavoritesRepository, getMerchantsRepository } from '@/repos';
import { useCartStore, type CartItem } from '@/store/cart';
import { toast } from '@/store/ui';
import { useSessionStore } from '@/store/session';
import { idempotencyKey } from '@/lib/idempotency';
import { track } from '@/lib/analytics';
import type { Catalogue, CatalogueItem, MerchantPublic, Promotion } from '@hudumika/contract';
import { PromotionType } from '@hudumika/contract';

export default function MerchantScreen() {
  const router = useRouter();
  const { merchantId } = useLocalSearchParams<{ merchantId: string }>();
  const user = useSessionStore((s) => s.user);
  const [merchant, setMerchant] = useState<MerchantPublic | null>(null);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [favorited, setFavorited] = useState(false);
  const [sheetItem, setSheetItem] = useState<CatalogueItem | null>(null);
  const [error, setError] = useState('');
  const [claiming, setClaiming] = useState<Set<string>>(new Set());
  const [claimedPromos, setClaimedPromos] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setError('');
    try {
      const [m, c, p, favs] = await Promise.all([
        getMerchantsRepository().get(merchantId),
        getMerchantsRepository().getCatalogue(merchantId),
        getMerchantsRepository().getPromotions(merchantId),
        getFavoritesRepository().list(),
      ]);
      setMerchant(m);
      setCatalogue(c);
      setPromotions(p);
      setFavorited(favs.some((f) => f.id === merchantId));
    } catch {
      setError(t('common.error'));
    }
  }, [merchantId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    track({ name: 'merchant_viewed', merchantId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleFavorite = async () => {
    const next = !favorited;
    setFavorited(next);
    try {
      if (next) await getFavoritesRepository().add(merchantId, `fav-${merchantId}-${Date.now()}`);
      else await getFavoritesRepository().remove(merchantId, `fav-${merchantId}-${Date.now()}`);
    } catch {
      setFavorited(!next); // rollback
    }
  };

  const openItem = (item: CatalogueItem) => {
    if (!merchant?.isOpen) return;
    setSheetItem(item);
  };

  const claimPromotion = async (promotion: Promotion) => {
    const promoId = promotion.id ?? '';
    if (!promoId || claiming.has(promoId)) return;
    setClaiming((prev) => new Set(prev).add(promoId));
    try {
      await getCouponsRepository().claim(promoId, idempotencyKey(user?.id ?? 'customer', 'promo-claim'));
      setClaimedPromos((prev) => new Set(prev).add(promoId));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      toast(t('merchant.claimed'));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'COUPON_ALREADY_CLAIMED') {
        setClaimedPromos((prev) => new Set(prev).add(promoId));
        toast(t('coupons.alreadyClaimed'), 'info');
      } else if (e instanceof ApiError && e.code === 'COUPON_EXPIRED') {
        toast(t('coupons.expired'), 'error');
      } else {
        toast(t('common.error'), 'error');
      }
      load();
    } finally {
      setClaiming((prev) => {
        const next = new Set(prev);
        next.delete(promoId);
        return next;
      });
    }
  };

  const addToCart = (cartItem: CartItem) => {
    if (!merchant || !sheetItem) return;
    useCartStore.getState().addItem({ merchantId: merchant.id, merchantName: merchant.businessName }, cartItem);
    track({ name: 'cart_item_added', merchantId: merchant.id, catalogueItemId: cartItem.catalogueItemId, quantity: cartItem.quantity });
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setSheetItem(null);
  };

  const openChat = async () => {
    if (!merchant) return;
    try {
      // Reuse an existing open conversation with this merchant when present.
      const existing = await getConversationsRepository().list('open');
      const conversation = existing.find((c) => c.merchantId === merchant.id)
        ?? await getConversationsRepository().create(
          { merchantId: merchant.id, subject: t('merchant.chat'), initialMessage: t('merchant.chatIntro') },
          idempotencyKey(user?.id ?? 'customer', 'conv'),
        );
      router.push(`/messages/${conversation.id}`);
    } catch {
      toast(t('common.error'), 'error');
    }
  };

  const sections = catalogue ? groupCatalogue(catalogue) : [];

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (!merchant || !catalogue) {
    return (
      <Screen>
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={2} />
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <FlatList
        data={sections}
        keyExtractor={(s) => s.name}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 168 }}
        renderItem={({ item: section }) => (
          <View style={{ marginBottom: Spacing.lg }}>
            <Text style={styles.section}>{section.name}</Text>
            {section.items.map((item) => (
              <Pressable
                key={item.id ?? item.name}
                onPress={() => openItem(item)}
                disabled={item.available === false || !merchant.isOpen}
                accessibilityRole="button"
                style={({ pressed }) => [styles.itemRow, pressed && { opacity: 0.8 }, (item.available === false || !merchant.isOpen) && { opacity: 0.55 }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.itemName, (item.available === false || !merchant.isOpen) && { color: Colors.textFaint }]}>{item.name}</Text>
                  {item.description ? <Text style={styles.itemDesc} numberOfLines={2}>{item.description}</Text> : null}
                  <Row gap={Spacing.sm} style={{ marginTop: 4 }}>
                    <MoneyText amountTZS={item.priceTZS} size={FontSize.sm} />
                    {item.available === false || !merchant.isOpen ? <Pill label={t('merchant.closed')} tone="neutral" /> : null}
                    {(item.options ?? []).length > 0 || (item.addons ?? []).length > 0 ? (
                      <Text style={styles.customize}>+ {t('common.view')}</Text>
                    ) : null}
                  </Row>
                </View>
                {item.available !== false && merchant.isOpen ? (
                  <View style={styles.addCircle}>
                    <Icon name="add" size={18} color={Colors.white} />
                  </View>
                ) : null}
              </Pressable>
            ))}
          </View>
        )}
        ListHeaderComponent={
          <View>
            <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
              <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
              <Pressable onPress={toggleFavorite} hitSlop={8} accessibilityRole="button" accessibilityLabel={favorited ? t('merchant.unfavorite') : t('merchant.favorite')}>
                <Icon name={favorited ? 'heart' : 'heart-outline'} size={24} color={favorited ? Colors.danger : Colors.text} />
              </Pressable>
            </Row>
            <Card>
              <Text style={styles.name}>{merchant.businessName}</Text>
              <Row gap={Spacing.md} style={{ marginTop: Spacing.sm }}>
                <Rating rating={merchant.rating} reviewCount={merchant.reviewCount} />
                <Pill label={merchant.isOpen ? t('merchant.open') : t('merchant.closed')} tone={merchant.isOpen ? 'success' : 'danger'} />
              </Row>
              <Row gap={Spacing.md} style={{ marginTop: Spacing.sm }}>
                <Text style={styles.meta}>{merchant.city}</Text>
                {merchant.deliveryMinutes ? <Text style={styles.meta}>{t('order.estimated', { m: merchant.deliveryMinutes })}</Text> : null}
              </Row>
              <Row gap={Spacing.sm} style={{ marginTop: Spacing.sm }}>
                {(merchant.categories ?? []).map((c) => (
                  <Pill key={c} label={c} tone="info" />
                ))}
              </Row>
            </Card>

            {promotions.length > 0 ? (
              <View style={{ marginTop: Spacing.lg }}>
                <Text style={styles.section}>{t('merchant.promotions')}</Text>
                {promotions.map((p) => {
                  const promoId = p.id ?? '';
                  const claimed = claimedPromos.has(promoId);
                  return (
                    <Card key={promoId || p.title} style={[styles.promo, { backgroundColor: Colors.primarySoft }]}>
                      <Row gap={Spacing.md}>
                        <Icon name="pricetag" size={16} color={Colors.primaryDeep} />
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: Colors.primaryDeep, fontSize: FontSize.md, fontFamily: Fonts.sansBold }}>{p.title}</Text>
                          <Text style={{ color: Colors.primaryDeep, fontSize: FontSize.xs, fontFamily: Fonts.sans }}>{p.description}</Text>
                        </View>
                        {p.type === PromotionType.coupon ? (
                          claimed ? (
                            <Pill label={t('merchant.claimed')} tone="success" />
                          ) : (
                            <Btn label={t('merchant.claim')} onPress={() => claimPromotion(p)} size="sm" loading={claiming.has(promoId)} />
                          )
                        ) : null}
                      </Row>
                    </Card>
                  );
                })}
              </View>
            ) : null}

            {!merchant.isOpen ? (
              <Card style={[styles.promo, { backgroundColor: Colors.dangerSoft, marginTop: Spacing.lg }]}>
                <Row gap={Spacing.md}>
                  <Icon name="lock-closed" size={16} color={Colors.danger} />
                  <Text style={{ color: Colors.danger, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, flex: 1 }}>
                    {t('merchant.closed')} — {t('cart.unavailable')}
                  </Text>
                </Row>
                <Row gap={Spacing.sm} style={{ marginTop: Spacing.md }}>
                  <Btn label={t('merchant.chat')} onPress={openChat} variant="outline" size="sm" icon="chatbubble-outline" style={{ flex: 1 }} />
                  <Btn label={t('merchant.reserveTable')} onPress={() => router.push(`/reservations?merchantId=${merchant.id}`)} variant="outline" size="sm" icon="calendar-outline" style={{ flex: 1 }} />
                </Row>
              </Card>
            ) : null}

            <Text style={styles.section}>{t('merchant.menu')}</Text>
          </View>
        }
        ListEmptyComponent={<EmptyState icon="fast-food-outline" title={t('home.emptyNearby')} />}
      />

      {sheetItem ? (
        <DishSheet
          item={sheetItem}
          merchant={{ id: merchant.id, businessName: merchant.businessName, isOpen: merchant.isOpen }}
          visible
          onClose={() => setSheetItem(null)}
          onAdd={addToCart}
          onViewDetails={() => {
            const itemId = sheetItem.id ?? sheetItem.name;
            setSheetItem(null);
            router.push(`/product/${merchant.id}/${itemId}`);
          }}
        />
      ) : null}

      <CartBar merchantId={merchant.id} />
    </Screen>
  );
}

function groupCatalogue(catalogue: Catalogue): { name: string; items: CatalogueItem[] }[] {
  const groups = new Map<string, CatalogueItem[]>();
  for (const item of catalogue.items) {
    const key = item.category || 'Other';
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.entries()].map(([name, items]) => ({ name, items }));
}

const styles = StyleSheet.create({
  name: { fontSize: FontSize.xl, fontFamily: Fonts.sansExtraBold, color: Colors.text },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans },
  section: { fontSize: FontSize.lg, fontFamily: Fonts.sansExtraBold, color: Colors.text, marginBottom: Spacing.sm, marginTop: Spacing.md },
  promo: { marginBottom: Spacing.sm },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.md },
  itemName: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text },
  itemDesc: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  customize: { fontSize: FontSize.xs, color: Colors.primaryDeep, fontFamily: Fonts.sansSemibold },
  addCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
