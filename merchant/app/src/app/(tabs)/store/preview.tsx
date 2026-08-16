import { Stack, router } from 'expo-router';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card, Empty, Icon, Pill, Row, Screen, SectionTitle } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';
import { api, ApiError } from '@/api/client';
import type { CategoryRow, ProductRow, StoreListItem, StoreServer } from '@/api/types';
import { tzs } from '@/lib/format';

export default function StorefrontPreviewScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const [stores, setStores] = useState<StoreListItem[]>([]);
  const [storeId, setStoreId] = useState('s_demo');
  const [store, setStore] = useState<StoreServer | null>(null);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get<{ stores: StoreListItem[] }>('/stores', { retries: 1 })
      .then((r) => setStores(r.stores))
      .catch(() => undefined);
  }, []);

  const load = useCallback(async (id: string) => {
    setStore(null);
    setProducts([]);
    setCategories([]);
    setError('');
    try {
      const [s, m, c] = await Promise.all([
        api.get<{ store: StoreServer }>(`/stores/${id}`, { retries: 1 }),
        api.get<{ products: ProductRow[] }>(`/stores/${id}/menu`, { retries: 1 }),
        api.get<{ categories: CategoryRow[] }>(`/categories?storeId=${id}`, { retries: 1 }),
      ]);
      setStore(s.store);
      setProducts(m.products);
      setCategories(c.categories.filter((x) => x.visible));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('prev.err'));
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => load(storeId), 0);
    return () => clearTimeout(t);
  }, [storeId, load]);

  const featured = store ? products.filter((p) => store.featuredProductIds.includes(p.id)) : [];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('prev.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <Row gap={6} style={{ flexWrap: 'wrap', marginBottom: Spacing.sm }}>
          {stores.map((st) => (
            <Pressable
              key={st.id}
              onPress={() => setStoreId(st.id)}
              style={[styles.storeChip, storeId === st.id && styles.storeChipActive]}>
              <View style={[styles.storeDot, { backgroundColor: st.open ? Colors.success : Colors.textTertiary }]} />
              <Text style={[styles.storeChipText, storeId === st.id && { color: Colors.text, fontWeight: '700' }]} numberOfLines={1}>
                {st.name.replace('Skewer House BBQ · ', '')}
              </Text>
            </Pressable>
          ))}
        </Row>

        <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginBottom: Spacing.md }}>
          {t('prev.customerView')}
        </Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {store ? (
          <View style={{ gap: Spacing.md }}>
            <View style={[styles.banner, { backgroundColor: store.bannerColor }]}>
              <Text style={styles.bannerText}>{store.coverImage ? `${store.coverImage}  ` : ''}{store.name}</Text>
              <Text style={styles.bannerSub}>{store.announcement || store.description}</Text>
            </View>

            {featured.length > 0 ? (
              <View>
                <SectionTitle title={t('prev.recommended')} icon="star" />
                <Card style={{ paddingVertical: 0, overflow: 'hidden' }}>
                  {featured.map((p, i) => (
                    <View key={p.id}>
                      {i > 0 ? <View style={styles.divider} /> : null}
                      <Row style={styles.productRow}>
                        <Text style={{ fontSize: 18 }}>{p.emoji}</Text>
                        <Text style={styles.productName} numberOfLines={1}>{p.name}</Text>
                        <Text style={styles.price}>{tzs(p.price)}</Text>
                      </Row>
                    </View>
                  ))}
                </Card>
              </View>
            ) : null}

            {products.length === 0 ? (
              <Empty icon="restaurant-outline" title={t('prev.empty')} sub={t('prev.emptySub')} />
            ) : (
              categories.map((cat) => {
                const items = products.filter((p) => p.categoryId === cat.id);
                if (items.length === 0) return null;
                return (
                  <View key={cat.id}>
                    <Text style={styles.catTitle}>{cat.name}</Text>
                    <Card style={{ paddingVertical: 0, overflow: 'hidden' }}>
                      {items.map((p, i) => (
                        <View key={p.id}>
                          {i > 0 ? <View style={styles.divider} /> : null}
                          <Row style={styles.productRow}>
                            <Text style={{ fontSize: 18 }}>{p.emoji}</Text>
                            <Text style={styles.productName} numberOfLines={1}>{p.name}</Text>
                            {p.stock === 0 ? <Pill label={t('prev.soldOut')} tone="neutral" /> : null}
                            <Text style={styles.price}>{tzs(p.price)}</Text>
                          </Row>
                        </View>
                      ))}
                    </Card>
                  </View>
                );
              })
            )}
          </View>
        ) : null}
      </Screen>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    backgroundColor: Colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  topTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  storeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
  },
  storeChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primaryDark },
  storeChipText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  storeDot: { width: 7, height: 7, borderRadius: 3.5 },
  banner: {
    borderRadius: Radius.lg,
    paddingVertical: 26,
    paddingHorizontal: Spacing.lg,
    gap: 4,
  },
  bannerText: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.white },
  bannerSub: { fontSize: FontSize.sm, color: 'rgba(255,255,255,0.85)' },
  catTitle: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text, marginBottom: Spacing.sm, marginTop: Spacing.lg },
  productRow: {
    justifyContent: 'space-between',
    gap: 10,
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.lg,
  },
  productName: { flex: 1, fontSize: FontSize.sm, color: Colors.text },
  price: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '700' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border },
  error: { color: Colors.danger, fontSize: FontSize.xs },
});
