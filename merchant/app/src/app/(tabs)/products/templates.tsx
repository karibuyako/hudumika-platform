import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Empty, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';
import { api, ApiError, getToken } from '@/api/client';
import type { ApiErrorBody, StoreListItem, TemplateRow } from '@/api/types';
import { timeAgo, tzs } from '@/lib/format';
import { useCatalogStore } from '@/store/catalog';

async function del(path: string): Promise<unknown> {
  const res = await fetch(`/api${path}`, {
    method: 'DELETE',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${getToken() ?? ''}`,
    },
  });
  if (res.status === 204) return undefined;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? `Request failed (${res.status})`);
  }
  return data;
}

interface ApplyResult {
  created: { storeId: string; productId: string }[];
  failed: { storeId: string; reason: string }[];
}

export default function TemplatesScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const products = useCatalogStore((s) => s.products);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [stores, setStores] = useState<StoreListItem[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createProductId, setCreateProductId] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [applyTpl, setApplyTpl] = useState<TemplateRow | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [confirmDel, setConfirmDel] = useState<TemplateRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = async () => {
    try {
      const r = await api.get<{ templates: TemplateRow[] }>('/product-templates', { retries: 1 });
      setTemplates(r.templates);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('prdt.errLoad'));
    }
  };

  useEffect(() => {
    api
      .get<{ templates: TemplateRow[] }>('/product-templates', { retries: 1 })
      .then((r) => setTemplates(r.templates))
      .catch((e) => setError(e instanceof ApiError ? e.message : t('prdt.errLoad')));
  }, []);

  const create = async () => {
    if (!createName.trim() || !createProductId) return;
    setBusy(true);
    setError('');
    try {
      await api.post('/product-templates', { name: createName.trim(), productId: createProductId });
      setCreateOpen(false);
      setCreateName('');
      setCreateProductId('');
      await refresh();
      await useCatalogStore.getState().hydrate();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('prdt.errCreate'));
    } finally {
      setBusy(false);
    }
  };

  const openApply = async (tpl: TemplateRow) => {
    setApplyTpl(tpl);
    setApplyResult(null);
    setChecked({});
    setError('');
    try {
      const r = await api.get<{ stores: StoreListItem[] }>('/merchants/me/stores', { retries: 1 });
      setStores(r.stores);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('prdt.errStores'));
    }
  };

  const apply = async () => {
    if (!applyTpl) return;
    const storeIds = Object.keys(checked).filter((id) => checked[id]);
    if (storeIds.length === 0) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.post<ApplyResult>(`/product-templates/${applyTpl.id}/apply`, { storeIds });
      setApplyResult(r);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await useCatalogStore.getState().hydrate();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('prdt.errApply'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirmDel) return;
    setBusy(true);
    setError('');
    try {
      await del(`/product-templates/${confirmDel.id}`);
      setConfirmDel(null);
      await refresh();
      await useCatalogStore.getState().hydrate();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('prdt.errDelete'));
    } finally {
      setBusy(false);
    }
  };

  const selectedProduct = products.find((p) => p.id === createProductId) ?? null;
  const checkedCount = Object.keys(checked).filter((id) => checked[id]).length;
  const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? id;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('common.back')}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('prdt.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Btn label={t('prdt.createFrom')} icon="add" size="sm" onPress={() => setCreateOpen(true)} />

        <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
          {templates.length === 0 ? <Empty icon="layers-outline" title={t('prdt.empty')} sub={t('prdt.emptySub')} /> : null}
          {templates.map((tb) => (
            <Card key={tb.id} style={{ gap: Spacing.sm }}>
              <View style={{ gap: 2 }}>
                <Row gap={8}>
                  <Icon name="layers-outline" size={15} color={Colors.textSecondary} />
                  <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flexShrink: 1 }} numberOfLines={1}>{tb.name}</Text>
                </Row>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('prdt.created', { time: timeAgo(tb.createdAt) })}</Text>
                <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }} numberOfLines={1}>
                  {t('prdt.draft', { name: String(tb.draft.name ?? t('prdt.unnamed')), price: tzs(Number(tb.draft.price ?? 0)) })}
                </Text>
              </View>
              <Row gap={Spacing.sm}>
                <Btn label={t('prdt.apply')} icon="copy-outline" size="sm" style={{ flex: 1 }} onPress={() => openApply(tb)} />
                <Btn label={t('prdt.delete')} variant="danger" size="sm" style={{ flex: 1 }} onPress={() => setConfirmDel(tb)} />
              </Row>
            </Card>
          ))}
        </View>
      </Screen>

      <SheetModal visible={createOpen} onClose={() => setCreateOpen(false)} title={t('prdt.createTitle')}>
        <View style={{ gap: Spacing.md }}>
          <TextInput
            value={createName}
            onChangeText={setCreateName}
            placeholder={t('prdt.namePh')}
            placeholderTextColor={Colors.textTertiary}
            style={styles.input}
            maxLength={30}
          />
          <Pressable onPress={() => setPickerOpen(true)} accessibilityRole="button" accessibilityLabel={selectedProduct ? `${selectedProduct.emoji} ${selectedProduct.name}` : t('prdt.chooseSource')} style={styles.pickBtn}>
            <Icon name="restaurant-outline" size={16} color={Colors.textTertiary} />
            <Text style={{ flex: 1, fontSize: FontSize.sm, color: selectedProduct ? Colors.text : Colors.textTertiary }} numberOfLines={1}>
              {selectedProduct ? `${selectedProduct.emoji} ${selectedProduct.name}` : t('prdt.chooseSource')}
            </Text>
            <Icon name="chevron-down" size={14} color={Colors.textTertiary} />
          </Pressable>
          <Btn label={t('prdt.createBtn')} size="lg" loading={busy} disabled={!createName.trim() || !createProductId} onPress={create} />
        </View>
      </SheetModal>

      <SheetModal visible={applyTpl !== null} onClose={() => setApplyTpl(null)} title={t('prdt.applyTitle')}>
        {applyResult ? (
          <View style={{ gap: Spacing.sm }}>
            <Row gap={6}>
              <Icon name="checkmark-circle" size={16} color={Colors.success} />
              <Text style={{ fontSize: FontSize.sm, color: Colors.text, fontWeight: '600' }}>
                {t('prdt.createdIn', { n: applyResult.created.length })}
              </Text>
            </Row>
            {applyResult.failed.length > 0 ? (
              <View style={{ gap: Spacing.xs }}>
                {applyResult.failed.map((f) => (
                  <Text key={f.storeId} style={{ fontSize: FontSize.xs, color: Colors.danger }}>
                    {storeName(f.storeId)}: {f.reason}
                  </Text>
                ))}
              </View>
            ) : null}
            <Btn label={t('prdt.done')} size="lg" onPress={() => setApplyTpl(null)} />
          </View>
        ) : (
          <View style={{ gap: Spacing.sm }}>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
              {t('prdt.pickStores', { name: applyTpl?.name ?? '', n: checkedCount })}
            </Text>
            {stores.length === 0 ? <Empty icon="storefront-outline" title={t('prdt.noStores')} sub={t('prdt.noStoresSub')} /> : null}
            {stores.map((s) => (
              <Pressable
                key={s.id}
                onPress={() => setChecked((c) => ({ ...c, [s.id]: !c[s.id] }))}
                accessibilityRole="button"
                accessibilityLabel={s.name}
                accessibilityState={{ selected: checked[s.id] }}
                style={({ pressed }) => [styles.storeRow, checked[s.id] && styles.storeRowActive, pressed && { opacity: 0.75 }]}>
                <Icon name={checked[s.id] ? 'checkbox' : 'square-outline'} size={20} color={checked[s.id] ? Colors.success : Colors.textTertiary} />
                <View style={{ flex: 1, gap: 1 }}>
                  <Text style={{ fontSize: FontSize.sm, fontWeight: '600', color: Colors.text }} numberOfLines={1}>{s.name}</Text>
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }} numberOfLines={1}>{s.address}</Text>
                </View>
                <Pill label={s.open ? t('header.open') : t('header.closed')} tone={s.open ? 'success' : 'neutral'} />
              </Pressable>
            ))}
            <Btn label={t('prdt.apply')} size="lg" loading={busy} disabled={checkedCount === 0} onPress={apply} />
          </View>
        )}
      </SheetModal>

      <SheetModal visible={pickerOpen} onClose={() => setPickerOpen(false)} title={t('prdt.chooseSource')}>
        <ScrollView style={{ maxHeight: 420 }}>
          {products.map((p) => (
            <Pressable
              key={p.id}
              onPress={() => { setCreateProductId(p.id); setPickerOpen(false); }}
              accessibilityRole="button"
              accessibilityLabel={`${p.emoji} ${p.name}`}
              accessibilityState={{ selected: createProductId === p.id }}
              style={({ pressed }) => [styles.pickRow, createProductId === p.id && styles.pickRowActive, pressed && { opacity: 0.7 }]}>
              <Text style={{ fontSize: 18 }}>{p.emoji}</Text>
              <View style={{ flex: 1, paddingHorizontal: Spacing.sm }}>
                <Text style={{ fontSize: FontSize.sm, fontWeight: '600', color: Colors.text }} numberOfLines={1}>{p.name}</Text>
              </View>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{tzs(p.price)}</Text>
              {createProductId === p.id ? <Icon name="checkmark" size={16} color={Colors.success} /> : null}
            </Pressable>
          ))}
        </ScrollView>
      </SheetModal>

      <SheetModal visible={confirmDel !== null} onClose={() => setConfirmDel(null)} title={t('prdt.deleteTitle')}>
        <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 19 }}>
          {t('prdt.deleteBody', { name: confirmDel?.name ?? '' })}
        </Text>
        <Row gap={Spacing.sm}>
          <Btn label={t('prdt.cancel')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => setConfirmDel(null)} />
          <Btn label={t('prdt.delete')} variant="danger" size="sm" style={{ flex: 1 }} loading={busy} onPress={remove} />
        </Row>
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
  input: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    fontSize: FontSize.sm,
    color: Colors.text,
    backgroundColor: Colors.card,
  },
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
  storeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: 10,
    paddingHorizontal: Spacing.sm,
    borderRadius: Radius.sm,
  },
  storeRowActive: { backgroundColor: Colors.primarySoft },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: Spacing.sm,
    borderRadius: Radius.sm,
  },
  pickRowActive: { backgroundColor: Colors.primarySoft },
});
