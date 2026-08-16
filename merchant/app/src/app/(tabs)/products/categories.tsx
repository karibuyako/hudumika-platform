import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Empty, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';
import { api, ApiError, getToken } from '@/api/client';
import type { ApiErrorBody, CategoryRow } from '@/api/types';
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

export default function CategoriesScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const products = useCatalogStore((s) => s.products);
  const [cats, setCats] = useState<CategoryRow[]>([]);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editCat, setEditCat] = useState<CategoryRow | null>(null);
  const [editName, setEditName] = useState('');
  const [confirmCat, setConfirmCat] = useState<CategoryRow | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ categories: CategoryRow[] }>('/categories', { retries: 1 });
      setCats(r.categories);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('prdc.errLoad'));
    }
  }, []);

  useEffect(() => {
    api
      .get<{ categories: CategoryRow[] }>('/categories', { retries: 1 })
      .then((r) => setCats(r.categories))
      .catch((e) => setError(e instanceof ApiError ? e.message : t('prdc.errLoad')));
  }, []);

  const add = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api.post('/categories', { name: newName.trim() });
      setNewName('');
      await refresh();
      await useCatalogStore.getState().hydrate();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('prdc.errAdd'));
    } finally {
      setBusy(false);
    }
  };

  const move = async (cat: CategoryRow, dir: -1 | 1) => {
    const idx = cats.findIndex((c) => c.id === cat.id);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= cats.length) return;
    const next = [...cats];
    const other = next[target];
    next[idx] = other;
    next[target] = cat;
    setBusy(true);
    setError('');
    try {
      await Promise.all([
        api.patch(`/categories/${cat.id}`, { sort: other.sort }),
        api.patch(`/categories/${other.id}`, { sort: cat.sort }),
      ]);
      await api.post('/categories/sort', { ids: next.map((c) => c.id) });
      await refresh();
      await useCatalogStore.getState().hydrate();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('prdc.errReorder'));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (cat: CategoryRow) => {
    setBusy(true);
    setError('');
    try {
      await api.patch(`/categories/${cat.id}`, { visible: !cat.visible });
      await refresh();
      await useCatalogStore.getState().hydrate();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('prdc.errUpdate'));
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!editCat || !editName.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api.patch(`/categories/${editCat.id}`, { name: editName.trim() });
      setEditCat(null);
      await refresh();
      await useCatalogStore.getState().hydrate();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('prdc.errRename'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirmCat) return;
    setBusy(true);
    setError('');
    try {
      await del(`/categories/${confirmCat.id}`);
      setConfirmCat(null);
      await refresh();
      await useCatalogStore.getState().hydrate();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('prdc.errDelete'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('common.back')}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('prdc.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Card style={{ gap: Spacing.sm }}>
          <Row gap={8}>
            <TextInput
              value={newName}
              onChangeText={setNewName}
              placeholder={t('prdc.newName')}
              placeholderTextColor={Colors.textTertiary}
              style={styles.input}
              maxLength={20}
            />
            <Btn label={t('prdc.add')} size="sm" loading={busy} disabled={!newName.trim()} onPress={add} />
          </Row>
        </Card>

        <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
          {cats.length === 0 ? <Empty icon="folder-open-outline" title={t('prdc.empty')} sub={t('prdc.emptySub')} /> : null}
          {cats.map((c, i) => (
            <Card key={c.id} style={{ gap: Spacing.sm }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <View style={{ flex: 1, gap: 2, paddingRight: Spacing.md }}>
                  <Row gap={8}>
                    <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flexShrink: 1 }} numberOfLines={1}>{c.name}</Text>
                    {!c.visible ? <Pill label={t('prdc.hidden')} tone="neutral" /> : null}
                  </Row>
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                    {t('prdc.products', { n: products.filter((p) => p.categoryId === c.id).length })}
                  </Text>
                </View>
                <View style={{ gap: 2 }}>
                  <Pressable onPress={() => move(c, -1)} disabled={i === 0 || busy} hitSlop={6} accessibilityRole="button" accessibilityLabel={c.name} style={[styles.arrowBtn, (i === 0 || busy) && { opacity: 0.35 }]}>
                    <Icon name="chevron-up" size={16} color={Colors.textSecondary} />
                  </Pressable>
                  <Pressable onPress={() => move(c, 1)} disabled={i === cats.length - 1 || busy} hitSlop={6} accessibilityRole="button" accessibilityLabel={c.name} style={[styles.arrowBtn, (i === cats.length - 1 || busy) && { opacity: 0.35 }]}>
                    <Icon name="chevron-down" size={16} color={Colors.textSecondary} />
                  </Pressable>
                </View>
              </Row>
              <Row style={{ justifyContent: 'space-between' }}>
                <Pressable onPress={() => { setEditCat(c); setEditName(c.name); }} style={styles.actBtn} hitSlop={4}>
                  <Icon name="pencil" size={13} color={Colors.info} />
                  <Text style={[styles.actText, { color: Colors.info }]}>{t('prdc.rename')}</Text>
                </Pressable>
                <Pressable onPress={() => toggle(c)} style={styles.actBtn} hitSlop={4} disabled={busy}>
                  <Icon name={c.visible ? 'eye-off-outline' : 'eye-outline'} size={13} color={Colors.textSecondary} />
                  <Text style={styles.actText}>{c.visible ? t('prdc.hide') : t('prdc.show')}</Text>
                </Pressable>
                <Pressable onPress={() => setConfirmCat(c)} style={styles.actBtn} hitSlop={4} disabled={busy}>
                  <Icon name="trash-outline" size={13} color={Colors.danger} />
                  <Text style={[styles.actText, { color: Colors.danger }]}>{t('prdc.delete')}</Text>
                </Pressable>
              </Row>
            </Card>
          ))}
        </View>
      </Screen>

      <SheetModal visible={editCat !== null} onClose={() => setEditCat(null)} title={t('prdc.renameTitle')}>
        <View style={{ gap: Spacing.md }}>
          <TextInput
            value={editName}
            onChangeText={setEditName}
            placeholder={t('prdc.name')}
            placeholderTextColor={Colors.textTertiary}
            style={styles.input}
            maxLength={20}
          />
          <Btn label={t('prdc.save')} onPress={saveEdit} loading={busy} disabled={!editName.trim()} size="lg" />
        </View>
      </SheetModal>

      <SheetModal visible={confirmCat !== null} onClose={() => setConfirmCat(null)} title={t('prdc.deleteTitle')}>
        <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 19 }}>
          {t('prdc.deleteBody', { name: confirmCat?.name ?? '' })}
        </Text>
        <Row gap={Spacing.sm}>
          <Btn label={t('prdc.cancel')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => setConfirmCat(null)} />
          <Btn label={t('prdc.delete')} variant="danger" size="sm" style={{ flex: 1 }} loading={busy} onPress={remove} />
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
    flex: 1,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    fontSize: FontSize.sm,
    color: Colors.text,
    backgroundColor: Colors.card,
  },
  arrowBtn: {
    width: 30,
    height: 24,
    borderRadius: Radius.sm,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 8, borderRadius: Radius.sm },
  actText: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.textSecondary },
});
