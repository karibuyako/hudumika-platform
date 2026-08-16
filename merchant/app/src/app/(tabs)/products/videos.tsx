import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import type { ProductVideo } from '@/api/types';
import { Btn, Card, Empty, Field, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';
import { fullTime } from '@/lib/format';
import { useCatalogueExtStore, type VideoInput } from '@/store/catalogue-ext';
import { useCatalogStore } from '@/store/catalog';

type Sheet = null | 'add' | 'delete';

export default function VideosScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const videos = useCatalogueExtStore((s) => s.videos);
  const hydrate = useCatalogueExtStore((s) => s.hydrate);
  const createVideo = useCatalogueExtStore((s) => s.createVideo);
  const deleteVideo = useCatalogueExtStore((s) => s.deleteVideo);
  const products = useCatalogStore((s) => s.products);
  const hydrateProducts = useCatalogStore((s) => s.hydrate);

  const [sheet, setSheet] = useState<Sheet>(null);
  const [target, setTarget] = useState<ProductVideo | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [itemId, setItemId] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    hydrate();
    hydrateProducts();
  }, [hydrate, hydrateProducts]);

  const onRefresh = async () => {
    setRefreshing(true);
    await hydrate();
    setRefreshing(false);
  };

  const openAdd = () => {
    setTitle('');
    setUrl('');
    setItemId('');
    setErr('');
    setSheet('add');
  };

  const save = async () => {
    if (!title.trim()) {
      setErr(t('ce.errTitle'));
      return;
    }
    if (!/^https?:\/\/\S+$/.test(url.trim())) {
      setErr(t('ce.errUrl'));
      return;
    }
    const input: VideoInput = {
      title: title.trim(),
      url: url.trim(),
      catalogueItemId: itemId || null,
    };
    const created = await createVideo(input);
    if (created) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSheet(null);
    } else setErr(t('ce.errSave'));
  };

  const confirmDelete = async () => {
    if (!target) return;
    const ok = await deleteVideo(target.id);
    if (ok) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setSheet(null);
  };

  const productName = (id: string | null | undefined) =>
    id ? products.find((p) => p.id === id)?.name ?? id : null;

  const statusTone = (v: ProductVideo): 'success' | 'info' | 'danger' =>
    v.status === 'active' ? 'success' : v.status === 'processing' ? 'info' : 'danger';

  const pickable = products.filter((p) => !p.deleted && p.visible).sort((a, b) => a.sort - b.sort);

  return (
    <Screen>
      <FlatList
        data={videos}
        keyExtractor={(v) => v.id}
        contentContainerStyle={{ padding: Spacing.md, gap: 10, paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        ListEmptyComponent={<Empty icon="videocam-outline" title={t('ce.videosEmpty')} sub={t('ce.videosEmptySub')} />}
        renderItem={({ item }) => (
          <Card>
            <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <View style={{ flex: 1 }}>
                <Row gap={6}>
                  <Icon name="videocam-outline" size={16} color={Colors.primaryDark} />
                  <Text style={{ flex: 1, fontSize: FontSize.md, fontWeight: '700', color: Colors.text }} numberOfLines={1}>
                    {item.title}
                  </Text>
                </Row>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 4 }} numberOfLines={1}>
                  {item.url}
                </Text>
                <Row gap={6} style={{ marginTop: 6, flexWrap: 'wrap' }}>
                  <Pill label={item.status} tone={statusTone(item)} />
                  {productName(item.catalogueItemId) ? <Pill label={productName(item.catalogueItemId)!} tone="neutral" /> : null}
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                    {t('ce.views', { n: item.views })} · {fullTime(item.createdAt)}
                  </Text>
                </Row>
              </View>
              <Btn
                label={t('common.delete')}
                size="sm"
                variant="danger"
                onPress={() => { setTarget(item); setErr(''); setSheet('delete'); }}
              />
            </Row>
          </Card>
        )}
      />

      <View style={styles.footer}>
        <Btn label={t('ce.addVideo')} size="lg" icon="add" onPress={openAdd} />
      </View>

      <SheetModal visible={sheet === 'add'} onClose={() => setSheet(null)} title={t('ce.addVideo')}>
        <View style={{ gap: Spacing.md }}>
          <Field label={t('ce.videoTitle')} value={title} onChangeText={setTitle} placeholder={t('ce.videoTitlePh')} maxLength={120} />
          <Field label={t('ce.videoUrl')} value={url} onChangeText={setUrl} placeholder={t('ce.videoUrlPh')} />
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('ce.videoItem')}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <Pressable
              onPress={() => setItemId('')}
              accessibilityRole="button"
              accessibilityLabel={t('ce.none')}
              style={[styles.itemChip, itemId === '' && { borderColor: Colors.primary }]}>
              <Text style={{ fontSize: FontSize.xs, color: itemId === '' ? Colors.primaryDeep : Colors.textSecondary, fontWeight: '600' }}>
                {t('ce.none')}
              </Text>
            </Pressable>
            {pickable.map((p) => (
              <Pressable
                key={p.id}
                onPress={() => setItemId(p.id)}
                accessibilityRole="button"
                accessibilityLabel={p.name}
                style={[styles.itemChip, itemId === p.id && { borderColor: Colors.primary }]}>
                <Text style={{ fontSize: FontSize.xs, color: itemId === p.id ? Colors.primaryDeep : Colors.textSecondary, fontWeight: '600' }} numberOfLines={1}>
                  {p.emoji} {p.name}
                </Text>
              </Pressable>
            ))}
          </View>
          {err ? <Text style={{ fontSize: FontSize.sm, color: Colors.danger }}>{err}</Text> : null}
          <Row gap={Spacing.md}>
            <Btn label={t('common.cancel')} size="lg" variant="subtle" style={{ flex: 1 }} onPress={() => setSheet(null)} />
            <Btn label={t('common.add')} size="lg" style={{ flex: 1 }} onPress={save} />
          </Row>
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'delete'} onClose={() => setSheet(null)} title={t('ce.deleteVideoTitle')}>
        <Text style={{ fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22 }}>
          {t('ce.deleteVideoSub')}
        </Text>
        <Row gap={Spacing.md}>
          <Btn label={t('common.cancel')} size="lg" variant="subtle" style={{ flex: 1 }} onPress={() => setSheet(null)} />
          <Btn label={t('common.delete')} size="lg" variant="danger" style={{ flex: 1 }} onPress={confirmDelete} />
        </Row>
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  itemChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
    maxWidth: 180,
  },
  footer: {
    padding: Spacing.lg,
    paddingBottom: 28,
    backgroundColor: Colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
});
