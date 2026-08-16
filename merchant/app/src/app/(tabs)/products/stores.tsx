import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Empty, Icon, Pill, Row, Screen } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';
import { api, ApiError } from '@/api/client';
import type { ProductRow, StoreListItem } from '@/api/types';
import { tzs } from '@/lib/format';
import { useCatalogStore } from '@/store/catalog';
import type { Overview } from '@/store/analytics';

export default function StoresScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const [stores, setStores] = useState<StoreListItem[]>([]);
  const [active, setActive] = useState<StoreListItem | null>(null);
  const [menu, setMenu] = useState<ProductRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stats, setStats] = useState<Record<string, Overview | null>>({});

  useEffect(() => {
    api
      .get<{ stores: StoreListItem[] }>('/merchants/me/stores', { retries: 1 })
      .then((r) => {
        setStores(r.stores);
        r.stores.forEach((s) => {
          api
            .get<Overview>(`/analytics/overview?storeId=${s.id}`, { retries: 1 })
            .then((o) => setStats((prev) => ({ ...prev, [s.id]: o })))
            .catch(() => setStats((prev) => ({ ...prev, [s.id]: null })));
        });
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : t('prds.errLoad')));
  }, []);

  const loadMenu = async (storeId: string) => {
    try {
      const r = await api.get<{ products: ProductRow[] }>(`/stores/${storeId}/menu`, { retries: 1 });
      setMenu(r.products);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('prds.errMenu'));
    }
  };

  const openStore = async (s: StoreListItem) => {
    setActive(s);
    setError('');
    await loadMenu(s.id);
  };

  const setVisible = async (p: ProductRow, v: boolean) => {
    if (!active) return;
    setBusy(true);
    setError('');
    try {
      await api.patch(`/stores/${active.id}/menu`, { items: [{ id: p.id, visible: v }] });
      await loadMenu(active.id);
      await useCatalogStore.getState().hydrate();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('prds.errVisibility'));
    } finally {
      setBusy(false);
    }
  };

  const move = async (p: ProductRow, dir: -1 | 1) => {
    if (!active) return;
    const idx = menu.findIndex((x) => x.id === p.id);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= menu.length) return;
    const other = menu[target];
    setBusy(true);
    setError('');
    try {
      await api.patch(`/stores/${active.id}/menu`, { items: [{ id: p.id, sort: other.sort }, { id: other.id, sort: p.sort }] });
      await loadMenu(active.id);
      await useCatalogStore.getState().hydrate();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('prds.errReorder'));
    } finally {
      setBusy(false);
    }
  };

  const back = () => {
    if (active) setActive(null);
    else router.back();
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={back} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle} numberOfLines={1}>{active ? active.name : t('prds.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        {!active ? (
          <View style={{ gap: Spacing.md }}>
            {stores.length === 0 ? <Empty icon="storefront-outline" title={t('prds.empty')} sub={t('prds.emptySub')} /> : null}
            {stores.map((s) => (
              <Card key={s.id} onPress={() => openStore(s)} style={{ gap: Spacing.sm }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flex: 1 }} numberOfLines={1}>{s.name}</Text>
                  <Pill label={s.open ? t('header.open') : t('header.closed')} tone={s.open ? 'success' : 'neutral'} />
                </Row>
                <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }} numberOfLines={1}>{s.address}</Text>
                <Row style={{ gap: Spacing.md }}>
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('prds.products', { n: s.productCount })}</Text>
                  <Text style={{ fontSize: FontSize.xs, color: Colors.success, fontWeight: '700' }}>{tzs(stats[s.id]?.gmv ?? 0)} GMV</Text>
                  <Text style={{ fontSize: FontSize.xs, color: Colors.info, fontWeight: '700' }}>{t('prds.today', { n: stats[s.id]?.todayOrders ?? 0 })}</Text>
                </Row>
              </Card>
            ))}
          </View>
        ) : (
          <View style={{ gap: Spacing.md }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                {t('prds.visibleHint', { n: menu.length })}
              </Text>
              <Btn label={t('prds.refresh')} variant="subtle" size="sm" onPress={() => loadMenu(active.id)} />
            </Row>
            {menu.length === 0 ? <Empty icon="restaurant-outline" title={t('prds.emptyMenu')} sub={t('prds.emptyMenuSub')} /> : null}
            {menu.map((p, i) => (
              <Card key={p.id} style={{ gap: Spacing.sm }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <View style={styles.emojiBox}>
                    <Text style={{ fontSize: 22 }}>{p.emoji}</Text>
                  </View>
                  <View style={{ flex: 1, gap: 2, paddingHorizontal: Spacing.sm }}>
                    <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.text }} numberOfLines={1}>{p.name}</Text>
                    <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                      {tzs(p.price)} · {t('prds.soldLeft', { sold: p.sold, stock: p.stock })}
                    </Text>
                  </View>
                  <View style={{ gap: 2 }}>
                    <Pressable onPress={() => move(p, -1)} disabled={i === 0 || busy} hitSlop={6} style={[styles.arrowBtn, (i === 0 || busy) && { opacity: 0.35 }]}>
                      <Icon name="chevron-up" size={16} color={Colors.textSecondary} />
                    </Pressable>
                    <Pressable onPress={() => move(p, 1)} disabled={i === menu.length - 1 || busy} hitSlop={6} style={[styles.arrowBtn, (i === menu.length - 1 || busy) && { opacity: 0.35 }]}>
                      <Icon name="chevron-down" size={16} color={Colors.textSecondary} />
                    </Pressable>
                  </View>
                  <Switch
                    value={p.visible}
                    onValueChange={(v) => setVisible(p, v)}
                    trackColor={{ false: Colors.borderStrong, true: Colors.success }}
                    thumbColor={Colors.white}
                  />
                </Row>
              </Card>
            ))}
          </View>
        )}
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
  topTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, flex: 1, textAlign: 'center' },
  error: { color: Colors.danger, fontSize: FontSize.xs, marginBottom: Spacing.sm },
  emojiBox: {
    width: 42,
    height: 42,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowBtn: {
    width: 28,
    height: 22,
    borderRadius: Radius.sm,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
