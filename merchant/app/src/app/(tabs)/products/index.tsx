import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { FlatList, Linking, Pressable, RefreshControl, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import type { CatalogueBulkResult, CatalogueExportResult, CatalogueImportResult, ProductRow } from '@/api/types';
import { Btn, Card, Chip, Empty, Icon, IconName, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { tzs } from '@/lib/format';
import { useCatalogStore } from '@/store/catalog';
import { useCataloguesStore, type PublishOutcome } from '@/store/catalogues';

const LOW_STOCK = 10;

interface BulkFailure {
  index: number;
  reason: string;
}

type BulkResult = CatalogueBulkResult & { failures?: BulkFailure[] };

const QUICK_LINKS: { label: I18nKey; icon: IconName; href: string }[] = [
  { label: 'prd.qlCategories', icon: 'grid-outline', href: '/products/categories' },
  { label: 'prd.qlAssistant', icon: 'sparkles-outline', href: '/products/assistant' },
  { label: 'prd.qlTemplates', icon: 'copy-outline', href: '/products/templates' },
  { label: 'prd.qlStores', icon: 'storefront-outline', href: '/products/stores' },
  { label: 'prd.qlLogs', icon: 'list-outline', href: '/products/logs' },
  { label: 'prd.qlCombos', icon: 'restaurant-outline', href: '/products/combos' },
  { label: 'prd.qlMenus', icon: 'book-outline', href: '/products/menus' },
  { label: 'prd.qlBarcodes', icon: 'barcode-outline', href: '/products/barcodes' },
  { label: 'prd.qlVideos', icon: 'videocam-outline', href: '/products/videos' },
];

export default function ProductsScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const products = useCatalogStore((s) => s.products);
  const categories = useCatalogStore((s) => s.categories);
  const hydrate = useCatalogStore((s) => s.hydrate);
  const toggleVisible = useCatalogStore((s) => s.toggleVisible);
  const deleteProduct = useCatalogStore((s) => s.deleteProduct);
  const [activeCat, setActiveCat] = useState('');
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProductRow | null>(null);

  const [exportOpen, setExportOpen] = useState(false);
  const [exportResult, setExportResult] = useState<CatalogueExportResult | null>(null);
  const [exportErr, setExportErr] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState<CatalogueImportResult & { failures?: { row: number; reason: string }[] } | null>(null);
  const [importErr, setImportErr] = useState('');
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishOutcome, setPublishOutcome] = useState<PublishOutcome | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkOverwrite, setBulkOverwrite] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const [bulkErr, setBulkErr] = useState('');
  const exportCatalogue = useCataloguesStore((s) => s.exportCatalogue);
  const importRows = useCataloguesStore((s) => s.importRows);
  const catalogue = useCataloguesStore((s) => s.catalogue);
  const catalogueHydrate = useCataloguesStore((s) => s.hydrate);
  const publish = useCataloguesStore((s) => s.publish);
  const bulkUpsert = useCataloguesStore((s) => s.bulkUpsert);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!catalogue) void catalogueHydrate();
  }, [catalogue, catalogueHydrate]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products
      .filter((p) => (activeCat ? p.categoryId === activeCat : true))
      .filter((p) => (q ? p.name.toLowerCase().includes(q) : true));
  }, [products, activeCat, query]);

  const visibleCount = products.filter((p) => p.visible).length;
  const lowCount = products.filter((p) => p.visible && p.stock < LOW_STOCK).length;

  const categoryName = (id: string) => categories.find((c) => c.id === id)?.name ?? '';

  const onRefresh = async () => {
    setRefreshing(true);
    await hydrate();
    setRefreshing(false);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const ok = await deleteProduct(deleteTarget.id);
    if (ok) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setDeleteTarget(null);
  };

  const runExport = async () => {
    setExportErr('');
    setExportResult(null);
    const res = await exportCatalogue();
    if (!res) {
      setExportErr(t('prdx.exportErr'));
      return;
    }
    setExportResult(res);
    setExportOpen(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const openPublish = () => {
    setPublishOutcome(null);
    setPublishOpen(true);
  };

  const runPublish = async () => {
    if (!catalogue) return;
    setPublishBusy(true);
    const outcome = await publish(catalogue.items);
    setPublishBusy(false);
    setPublishOutcome(outcome);
    if (outcome.ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await hydrate();
    } else {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  const openBulk = () => {
    setBulkText('');
    setBulkOverwrite(false);
    setBulkResult(null);
    setBulkErr('');
    setBulkOpen(true);
  };

  const runBulk = async () => {
    const lines = bulkText.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return;
    const items: { name: string; priceTZS: number; category: string; description?: string }[] = [];
    const bad: BulkFailure[] = [];
    lines.forEach((line, i) => {
      const parts = line.split(',').map((p) => p.trim());
      if (parts.length < 3) {
        bad.push({ index: i + 1, reason: 'INVALID_FORMAT' });
        return;
      }
      const price = Number(parts[1]);
      if (!Number.isInteger(price) || price < 0) {
        bad.push({ index: i + 1, reason: 'INVALID_PRICE_TZS' });
        return;
      }
      items.push({ name: parts[0], priceTZS: price, category: parts[2], description: parts[3] || undefined });
    });
    if (items.length === 0) {
      setBulkErr(t('prdx.bulkErr'));
      return;
    }
    setBulkBusy(true);
    setBulkErr('');
    const res = await bulkUpsert(items, bulkOverwrite);
    setBulkBusy(false);
    if (!res) {
      setBulkErr(t('prdx.bulkErr'));
      return;
    }
    setBulkResult({
      ...res,
      failures: bad.length ? [...bad, ...(res.failures ?? [])] : res.failures,
    });
    await hydrate();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const openImport = () => {
    setImportText('');
    setImportResult(null);
    setImportErr('');
    setImportOpen(true);
  };

  const runImport = async () => {
    const lines = importText.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return;
    const rows: { name: string; priceTZS: number; category: string }[] = [];
    const bad: { row: number; reason: string }[] = [];
    lines.forEach((line, i) => {
      const parts = line.split(',').map((p) => p.trim());
      if (parts.length < 3) {
        bad.push({ row: i + 1, reason: 'INVALID_FORMAT' });
        return;
      }
      const price = Number(parts[1]);
      if (!Number.isInteger(price) || price < 0) {
        bad.push({ row: i + 1, reason: 'INVALID_PRICE_TZS' });
        return;
      }
      rows.push({ name: parts[0], priceTZS: price, category: parts[2] });
    });
    if (rows.length === 0) {
      setImportErr(t('prdx.importErr'));
      return;
    }
    setImportBusy(true);
    setImportErr('');
    const res = await importRows(rows);
    setImportBusy(false);
    if (!res) {
      setImportErr(t('prdx.importErr'));
      return;
    }
    const merged = { ...res, failures: bad.length ? [...bad, ...((res as { failures?: { row: number; reason: string }[] }).failures ?? [])] : (res as { failures?: { row: number; reason: string }[] }).failures };
    setImportResult(merged);
    await hydrate();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  return (
    <Screen>
      <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.md, gap: Spacing.sm }}>
        <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
          {t('prd.count', { n: products.length, m: visibleCount })}{lowCount ? t('prd.lowStock', { k: lowCount }) : ''}
        </Text>
        <Row gap={Spacing.sm} style={{ flexWrap: 'wrap' }}>
          {QUICK_LINKS.map((l) => (
            <Pressable
              key={l.href}
              onPress={() => router.push({ pathname: l.href } as never)}
              accessibilityRole="button"
              accessibilityLabel={t(l.label)}
              style={({ pressed }) => [styles.quickLink, pressed && { opacity: 0.7 }]}>
              <Icon name={l.icon} size={13} color={Colors.textSecondary} />
              <Text style={styles.quickLinkText}>{t(l.label)}</Text>
            </Pressable>
          ))}
          <Pressable onPress={openImport} accessibilityRole="button" accessibilityLabel={t('prdx.import')} style={({ pressed }) => [styles.quickLink, pressed && { opacity: 0.7 }]}>
            <Icon name="arrow-down-outline" size={13} color={Colors.primaryDark} />
            <Text style={styles.quickLinkText}>{t('prdx.import')}</Text>
          </Pressable>
          <Pressable onPress={openBulk} accessibilityRole="button" accessibilityLabel={t('prdx.bulk')} style={({ pressed }) => [styles.quickLink, pressed && { opacity: 0.7 }]}>
            <Icon name="layers-outline" size={13} color={Colors.primaryDark} />
            <Text style={styles.quickLinkText}>{t('prdx.bulk')}</Text>
          </Pressable>
          <Pressable onPress={runExport} accessibilityRole="button" accessibilityLabel={t('prdx.export')} style={({ pressed }) => [styles.quickLink, pressed && { opacity: 0.7 }]}>
            <Icon name="arrow-up-outline" size={13} color={Colors.primaryDark} />
            <Text style={styles.quickLinkText}>{t('prdx.export')}</Text>
          </Pressable>
          <Pressable onPress={openPublish} accessibilityRole="button" accessibilityLabel={t('prdx.publish')} style={({ pressed }) => [styles.quickLink, styles.publishLink, pressed && { opacity: 0.7 }]}>
            <Icon name="cloud-upload-outline" size={13} color={Colors.white} />
            <Text style={[styles.quickLinkText, { color: Colors.white }]}>{t('prdx.publish')}</Text>
          </Pressable>
        </Row>
        {catalogue?.publishedAt ? (
          <Row gap={6} style={{ flexWrap: 'wrap' }}>
            <Pill label={t('prdx.publishedOn', { at: formatPublishTime(catalogue.publishedAt) })} tone="success" />
          </Row>
        ) : (
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('prdx.publishNever')}</Text>
        )}
      </View>

      <View style={styles.searchWrap}>
        <View style={styles.searchBox}>
          <Icon name="search" size={16} color={Colors.textTertiary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t('prd.search')}
            placeholderTextColor={Colors.textTertiary}
            style={styles.searchInput}
          />
          {query ? (
            <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.close')}>
              <Icon name="close-circle" size={15} color={Colors.textTertiary} />
            </Pressable>
          ) : null}
        </View>
      </View>

      <Row gap={Spacing.sm} style={{ paddingHorizontal: Spacing.lg, paddingBottom: Spacing.md, flexWrap: 'wrap' }}>
        <Chip label={t('prd.all')} selected={activeCat === ''} onPress={() => setActiveCat('')} />
        {categories.map((c) => (
          <Chip key={c.id} label={c.name} selected={activeCat === c.id} onPress={() => setActiveCat(c.id)} />
        ))}
      </Row>

      <FlatList
        data={list}
        keyExtractor={(p) => p.id}
        contentContainerStyle={{ padding: Spacing.md, gap: 10, paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        ListEmptyComponent={
          <Empty icon="restaurant-outline" title={t('prd.empty')} sub={t('prd.emptySub')} />
        }
        renderItem={({ item }) => (
          <Card style={[styles.productCard, !item.visible && { opacity: 0.55 }]}>
            <View style={styles.emojiBox}>
              <Text style={{ fontSize: 26 }}>{item.emoji}</Text>
            </View>
            <View style={{ flex: 1, gap: 5 }}>
              <Row gap={6}>
                <Text style={{ flex: 1, fontSize: FontSize.md, fontWeight: '700', color: Colors.text }} numberOfLines={1}>
                  {item.name}
                </Text>
                {!item.visible ? <Pill label={t('prd.hidden')} tone="neutral" /> : null}
              </Row>
              {categoryName(item.categoryId) ? (
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{categoryName(item.categoryId)}</Text>
              ) : null}
              <Row gap={8}>
                <Text style={{ fontSize: FontSize.md, fontWeight: '800', color: Colors.primaryDeep }}>{tzs(item.price)}</Text>
                <StockBadge stock={item.stock} />
              </Row>
              <Row gap={6} style={{ flexWrap: 'wrap' }}>
                {item.comboItems.length > 0 ? <Pill label={t('prd.combo')} tone="info" /> : null}
                {item.videoUrl ? <Pill label={t('prd.video')} tone="warning" /> : null}
                {item.addons.length > 0 ? <Pill label={t('prd.addons')} tone="neutral" /> : null}
                {item.variants.length > 0 ? <Pill label={t('prd.specs', { n: item.variants.length })} tone="neutral" /> : null}
              </Row>
              <Row gap={8}>
                <Btn
                  label={t('prd.edit')}
                  size="sm"
                  variant="subtle"
                  style={{ flex: 1 }}
                  onPress={() => router.push({ pathname: '/products/editor', params: { id: item.id } })}
                />
                <Btn
                  label={item.visible ? t('prd.unlist') : t('prd.list')}
                  size="sm"
                  variant="subtle"
                  style={{ flex: 1 }}
                  onPress={() => toggleVisible(item.id)}
                />
                <Btn
                  label={t('prd.delete')}
                  size="sm"
                  variant="danger"
                  style={{ flex: 1 }}
                  onPress={() => setDeleteTarget(item)}
                />
              </Row>
            </View>
          </Card>
        )}
      />

      <View style={styles.footer}>
        <Btn label={t('prd.add')} size="lg" icon="add" onPress={() => router.push('/products/editor')} />
      </View>

      <SheetModal visible={!!deleteTarget} onClose={() => setDeleteTarget(null)} title={t('prd.deleteTitle')}>
        <Text style={{ fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22 }}>
          {t('prd.deleteSub')}
        </Text>
        <Row gap={Spacing.md}>
          <Btn label={t('prd.cancel')} size="lg" variant="subtle" style={{ flex: 1 }} onPress={() => setDeleteTarget(null)} />
          <Btn label={t('prd.delete')} size="lg" variant="danger" style={{ flex: 1 }} onPress={confirmDelete} />
        </Row>
      </SheetModal>

      <SheetModal visible={exportOpen} onClose={() => setExportOpen(false)} title={t('prdx.exportTitle')}>
        {exportResult ? (
          <View style={{ gap: Spacing.md }}>
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 }}>{t('prdx.exportSub')}</Text>
            <Card style={{ gap: 6, backgroundColor: Colors.primarySoft }}>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }} numberOfLines={2}>{exportResult.downloadUrl}</Text>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '600' }}>
                {t('prdx.exportExpires', { sec: exportResult.expiresInSeconds })}
              </Text>
            </Card>
            <Btn
              label={t('prdx.exportDownload')}
              size="lg"
              icon="open-outline"
              onPress={() => {
                void Linking.openURL(exportResult.downloadUrl);
                setExportOpen(false);
              }}
            />
          </View>
        ) : (
          <View style={{ gap: Spacing.md }}>
            <Btn label={t('common.retry')} size="lg" onPress={runExport} />
            {exportErr ? <Text style={{ fontSize: FontSize.xs, color: Colors.danger, textAlign: 'center' }}>{exportErr}</Text> : null}
          </View>
        )}
      </SheetModal>

      <SheetModal visible={importOpen} onClose={() => setImportOpen(false)} title={t('prdx.importTitle')}>
        {importResult ? (
          <View style={{ gap: Spacing.sm }}>
            <Text style={{ fontSize: FontSize.sm, color: Colors.text, fontWeight: '700' }}>{t('prdx.importResultTitle')}</Text>
            <Row gap={Spacing.md}>
              <Pill label={t('prdx.importAccepted', { n: importResult.failures ? linesImported(importResult.failures, importText) : 0 })} tone="success" />
              <Pill label={t('prdx.importRejected', { n: importResult.failures?.length ?? 0 })} tone="danger" />
            </Row>
            {importResult.failures && importResult.failures.length > 0 ? (
              <View style={{ gap: 4, marginTop: 4 }}>
                {importResult.failures.slice(0, 12).map((f) => (
                  <Text key={`${f.row}-${f.reason}`} style={{ fontSize: FontSize.xs, color: Colors.danger }} numberOfLines={2}>
                    {t('prdx.importRowErr', { row: f.row, reason: f.reason })}
                  </Text>
                ))}
              </View>
            ) : null}
            <Btn label={t('common.done')} size="lg" onPress={() => setImportOpen(false)} />
          </View>
        ) : (
          <View style={{ gap: Spacing.md }}>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('prdx.importSub')}</Text>
            <TextInput
              value={importText}
              onChangeText={setImportText}
              placeholder={t('prdx.importPh')}
              placeholderTextColor={Colors.textTertiary}
              style={styles.importInput}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
            />
            {importErr ? <Text style={{ fontSize: FontSize.xs, color: Colors.danger, textAlign: 'center' }}>{importErr}</Text> : null}
            <Btn label={t('prdx.importBtn')} size="lg" loading={importBusy} disabled={!importText.trim()} onPress={runImport} />
          </View>
        )}
      </SheetModal>

      <SheetModal visible={publishOpen} onClose={() => setPublishOpen(false)} title={t('prdx.publishTitle')}>
        {publishOutcome?.ok ? (
          <View style={{ gap: Spacing.md, alignItems: 'center' }}>
            <Icon name="checkmark-circle" size={48} color={Colors.success} />
            <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.text }}>{t('prdx.publishSuccess')}</Text>
            <Pill label={t('prdx.publishedOn', { at: formatPublishTime(publishOutcome.catalogue.publishedAt) })} tone="success" />
            <Btn label={t('common.done')} size="lg" style={{ alignSelf: 'stretch' }} onPress={() => setPublishOpen(false)} />
          </View>
        ) : (
          <View style={{ gap: Spacing.md }}>
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 }}>{t('prdx.publishSub')}</Text>
            <Btn label={t('prdx.publishBtn')} size="lg" loading={publishBusy} onPress={runPublish} />
            {publishOutcome && !publishOutcome.ok ? <PublishFailure outcome={publishOutcome} /> : null}
            {publishBusy ? <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'center' }}>{t('prdx.publishBusy')}</Text> : null}
          </View>
        )}
      </SheetModal>

      <SheetModal visible={bulkOpen} onClose={() => setBulkOpen(false)} title={t('prdx.bulkTitle')}>
        {bulkResult ? (
          <View style={{ gap: Spacing.sm }}>
            <Text style={{ fontSize: FontSize.sm, color: Colors.text, fontWeight: '700' }}>{t('prdx.bulkResultTitle', { id: bulkResult.jobId })}</Text>
            <Row gap={Spacing.md}>
              <Pill label={t('prdx.bulkAccepted', { n: bulkResult.accepted })} tone="success" />
              <Pill label={t('prdx.bulkRejected', { n: bulkResult.rejected })} tone="danger" />
            </Row>
            {bulkResult.failures && bulkResult.failures.length > 0 ? (
              <View style={{ gap: 4, marginTop: 4 }}>
                {bulkResult.failures.slice(0, 12).map((f) => (
                  <Text key={`${f.index}-${f.reason}`} style={{ fontSize: FontSize.xs, color: Colors.danger }} numberOfLines={2}>
                    {t('prdx.bulkRowErr', { index: f.index, reason: f.reason })}
                  </Text>
                ))}
              </View>
            ) : null}
            <Btn label={t('common.done')} size="lg" onPress={() => setBulkOpen(false)} />
          </View>
        ) : (
          <View style={{ gap: Spacing.md }}>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('prdx.bulkSub')}</Text>
            <TextInput
              value={bulkText}
              onChangeText={setBulkText}
              placeholder={t('prdx.bulkPh')}
              placeholderTextColor={Colors.textTertiary}
              style={styles.importInput}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('prdx.bulkOverwrite')}</Text>
              <Switch
                value={bulkOverwrite}
                onValueChange={setBulkOverwrite}
                trackColor={{ false: Colors.borderStrong, true: Colors.success }}
                thumbColor={Colors.white}
              />
            </Row>
            {bulkErr ? <Text style={{ fontSize: FontSize.xs, color: Colors.danger, textAlign: 'center' }}>{bulkErr}</Text> : null}
            <Btn label={t('prdx.bulkBtn')} size="lg" loading={bulkBusy} disabled={!bulkText.trim()} onPress={runBulk} />
          </View>
        )}
      </SheetModal>
    </Screen>
  );
}

function linesImported(failures: { row: number }[], raw: string): number {
  const total = raw.split('\n').map((l) => l.trim()).filter(Boolean).length;
  return total - failures.length;
}

function formatPublishTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function PublishFailure({ outcome }: { outcome: Extract<PublishOutcome, { ok: false }> }) {
  const details = outcome.details ?? {};
  const fieldErrors = Array.isArray(details.errors) ? (details.errors as { field: string; code: string; message: string }[]) : [];
  const priceItems = Array.isArray(details.items) ? (details.items as { id: string; name: string; inFlightCount: number }[]) : [];
  const retryAfter = outcome.retryAfterSeconds ?? details.retryAfterSeconds;
  return (
    <View style={{ gap: Spacing.sm }}>
      {retryAfter ? (
        <Card style={{ gap: 4, backgroundColor: Colors.warningSoft }}>
          <Text style={{ fontSize: FontSize.sm, color: Colors.text, fontWeight: '700' }}>{t('prdx.publishRetryAfter', { sec: String(retryAfter) })}</Text>
        </Card>
      ) : null}
      {priceItems.length > 0 ? (
        <Card style={{ gap: 6, backgroundColor: Colors.dangerSoft }}>
          <Text style={{ fontSize: FontSize.sm, color: Colors.danger, fontWeight: '700' }}>{t('prdx.publishPriceChanged')}</Text>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary, lineHeight: 16 }}>{t('prdx.publishKeep')}</Text>
          {priceItems.map((it) => (
            <Text key={it.id} style={{ fontSize: FontSize.xs, color: Colors.danger }} numberOfLines={2}>
              {t('prdx.publishPriceChangedSub', { name: it.name, n: it.inFlightCount })}
            </Text>
          ))}
        </Card>
      ) : null}
      {fieldErrors.length > 0 ? (
        <Card style={{ gap: 6, backgroundColor: Colors.warningSoft }}>
          <Text style={{ fontSize: FontSize.sm, color: Colors.text, fontWeight: '700' }}>{t('prdx.publishValidation')}</Text>
          {fieldErrors.slice(0, 8).map((e, i) => (
            <Text key={`${e.field}-${i}`} style={{ fontSize: FontSize.xs, color: Colors.textSecondary }} numberOfLines={2}>
              {e.field}: {e.message}
            </Text>
          ))}
        </Card>
      ) : null}
      <Text style={{ fontSize: FontSize.xs, color: Colors.danger, textAlign: 'center' }}>{outcome.message}</Text>
    </View>
  );
}

function StockBadge({ stock }: { stock: number }) {
  if (stock === 0) return <Pill label={t('prd.soldOut')} tone="danger" />;
  if (stock < LOW_STOCK) return <Pill label={t('prd.low', { n: stock })} tone="warning" />;
  return <Pill label={t('prd.inStock', { n: stock })} tone="success" />;
}

const styles = StyleSheet.create({
  quickLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.surface,
    borderRadius: Radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  quickLinkText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '600' },
  publishLink: { backgroundColor: Colors.primaryDark },
  searchWrap: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm, paddingTop: Spacing.sm },
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
  importInput: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    minHeight: 130,
    fontSize: FontSize.sm,
    color: Colors.text,
    backgroundColor: Colors.card,
    textAlignVertical: 'top',
  },
  productCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: 12,
  },
  emojiBox: {
    width: 46,
    height: 46,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footer: {
    padding: Spacing.lg,
    paddingBottom: 28,
    backgroundColor: Colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
});
