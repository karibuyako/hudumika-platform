import { Stack, router } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card, Empty, Icon, IconName, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';
import { api, ApiError } from '@/api/client';
import type { ProductLog } from '@/api/types';
import { timeAgo } from '@/lib/format';
import { useCatalogStore } from '@/store/catalog';

function actionMeta(action: string): { icon: IconName; color: string } {
  if (action.includes('assistant')) return { icon: 'sparkles', color: 'Colors.violet' };
  if (action.includes('stock')) return { icon: 'swap-horizontal', color: Colors.warning };
  if (action.includes('delete')) return { icon: 'trash', color: Colors.danger };
  if (action.includes('create')) return { icon: 'add-circle', color: Colors.success };
  if (action.includes('update')) return { icon: 'create-outline', color: Colors.info };
  return { icon: 'folder', color: Colors.textSecondary };
}

export default function LogsScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const products = useCatalogStore((s) => s.products);
  const [logs, setLogs] = useState<ProductLog[]>([]);
  const [actionQuery, setActionQuery] = useState('');
  const [productId, setProductId] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    /* Item-scoped logs use the contract path; the unfiltered list has no
     * contract equivalent (GET /catalogue-items/{itemId}/logs is per-item). */
    const path = productId
      ? `/catalogue-items/${encodeURIComponent(productId)}/logs?limit=300`
      : '/products/logs?limit=300';
    api
      .get<{ logs: ProductLog[] }>(path, { retries: 1 })
      .then((r) => setLogs(r.logs))
      .catch((e) => setError(e instanceof ApiError ? e.message : t('prdl.err')));
  }, [productId]);

  const filtered = actionQuery.trim()
    ? logs.filter((l) => l.action.toLowerCase().includes(actionQuery.trim().toLowerCase()))
    : logs;

  const nameFor = (l: ProductLog) => (l.productId ? products.find((p) => p.id === l.productId)?.name : undefined);

  const diffFor = (l: ProductLog) => {
    if (l.before === undefined && l.after === undefined) return '';
    const b = l.before === undefined ? '' : JSON.stringify(l.before);
    const a = l.after === undefined ? '' : JSON.stringify(l.after);
    const s = `${b}${b && a ? ' → ' : ''}${a}`;
    return s.length > 80 ? `${s.slice(0, 79)}…` : s;
  };

  const selectedProduct = products.find((p) => p.id === productId) ?? null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('prdl.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Card style={{ gap: Spacing.sm }}>
          <View style={styles.searchBox}>
            <Icon name="search" size={15} color={Colors.textTertiary} />
            <TextInput
              value={actionQuery}
              onChangeText={setActionQuery}
              placeholder={t('prdl.filterPh')}
              placeholderTextColor={Colors.textTertiary}
              style={styles.searchInput}
            />
            {actionQuery ? (
              <Pressable onPress={() => setActionQuery('')} hitSlop={8}>
                <Icon name="close-circle" size={15} color={Colors.textTertiary} />
              </Pressable>
            ) : null}
          </View>
          <Pressable onPress={() => setPickerOpen(true)} style={styles.pickBtn}>
            <Icon name="restaurant-outline" size={16} color={Colors.textTertiary} />
            <Text style={{ flex: 1, fontSize: FontSize.sm, color: selectedProduct ? Colors.text : Colors.textTertiary }} numberOfLines={1}>
              {selectedProduct ? `${selectedProduct.emoji} ${selectedProduct.name}` : t('prdl.allProducts')}
            </Text>
            <Icon name="chevron-down" size={14} color={Colors.textTertiary} />
          </Pressable>
        </Card>

        <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
          {filtered.length === 0 ? <Empty icon="document-text-outline" title={t('prdl.empty')} sub={t('prdl.emptySub')} /> : null}
          {filtered.map((l) => {
            const meta = actionMeta(l.action);
            const name = nameFor(l);
            const diff = diffFor(l);
            return (
              <Card key={l.id} style={{ gap: Spacing.sm }}>
                <Row gap={10}>
                  <View style={[styles.iconWrap, { backgroundColor: `${meta.color}1A` }]}>
                    <Icon name={meta.icon} size={16} color={meta.color} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text }} numberOfLines={1}>
                      {l.action}
                      {l.field ? ` · ${l.field}` : ''}
                      {name ? ` — ${name}` : ''}
                    </Text>
                    {diff ? (
                      <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary }} numberOfLines={2}>
                        {diff}
                      </Text>
                    ) : null}
                    <Text style={{ fontSize: 10, color: Colors.textTertiary }}>{l.role} · {timeAgo(l.ts)}</Text>
                  </View>
                </Row>
              </Card>
            );
          })}
        </View>
      </Screen>

      <SheetModal visible={pickerOpen} onClose={() => setPickerOpen(false)} title={t('prdl.filterTitle')}>
        <ScrollView style={{ maxHeight: 420 }}>
          <Pressable
            onPress={() => { setProductId(''); setPickerOpen(false); }}
            style={({ pressed }) => [styles.pickRow, !productId && styles.pickRowActive, pressed && { opacity: 0.7 }]}>
            <Text style={{ flex: 1, fontSize: FontSize.sm, fontWeight: '600', color: Colors.text }}>{t('prdl.allProducts')}</Text>
            {!productId ? <Icon name="checkmark" size={16} color={Colors.success} /> : null}
          </Pressable>
          {products.map((p) => (
            <Pressable
              key={p.id}
              onPress={() => { setProductId(p.id); setPickerOpen(false); }}
              style={({ pressed }) => [styles.pickRow, productId === p.id && styles.pickRowActive, pressed && { opacity: 0.7 }]}>
              <Text style={{ fontSize: 18 }}>{p.emoji}</Text>
              <View style={{ flex: 1, paddingHorizontal: Spacing.sm }}>
                <Text style={{ fontSize: FontSize.sm, fontWeight: '600', color: Colors.text }} numberOfLines={1}>{p.name}</Text>
              </View>
              {productId === p.id ? <Icon name="checkmark" size={16} color={Colors.success} /> : null}
            </Pressable>
          ))}
        </ScrollView>
      </SheetModal>
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
  error: { color: Colors.danger, fontSize: FontSize.xs, marginBottom: Spacing.sm },
  searchBox: {
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
  pickBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    backgroundColor: Colors.card,
  },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: Spacing.sm,
    borderRadius: Radius.sm,
  },
  pickRowActive: { backgroundColor: Colors.primarySoft },
});
