import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { FlatList, RefreshControl, ScrollView, Text, View } from 'react-native';

import { api } from '@/api/client';
import type { BarcodeHistoryEntry, BarcodeFormatCode } from '@/api/types';
import { Btn, Card, Chip, Empty, Field, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';
import { fullTime } from '@/lib/format';
import { useCatalogueExtStore } from '@/store/catalogue-ext';
import { useCatalogStore } from '@/store/catalog';

type Sheet = null | 'batch' | 'history' | 'generate';

export default function BarcodesScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const formats = useCatalogueExtStore((s) => s.formats);
  const barcodesByItem = useCatalogueExtStore((s) => s.barcodesByItem);
  const hydrate = useCatalogueExtStore((s) => s.hydrate);
  const listItemBarcodes = useCatalogueExtStore((s) => s.listItemBarcodes);
  const generateBarcode = useCatalogueExtStore((s) => s.generateBarcode);
  const deleteBarcode = useCatalogueExtStore((s) => s.deleteBarcode);
  const batchBarcodes = useCatalogueExtStore((s) => s.batchBarcodes);
  const products = useCatalogStore((s) => s.products);
  const hydrateProducts = useCatalogStore((s) => s.hydrate);

  const [itemId, setItemId] = useState('p1');
  const [refreshing, setRefreshing] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [batchText, setBatchText] = useState('');
  const [batchResult, setBatchResult] = useState<{ accepted: number; rejected: number } | null>(null);
  const [historyCode, setHistoryCode] = useState('');
  const [history, setHistory] = useState<BarcodeHistoryEntry[] | null>(null);
  const [historyErr, setHistoryErr] = useState('');
  const [genFormat, setGenFormat] = useState<BarcodeFormatCode>('ean13');

  useEffect(() => {
    hydrate();
    hydrateProducts();
  }, [hydrate, hydrateProducts]);

  const loadBarcodes = useCallback(
    async (id: string) => {
      await listItemBarcodes(id);
    },
    [listItemBarcodes],
  );

  useEffect(() => {
    loadBarcodes(itemId);
  }, [itemId, loadBarcodes]);

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([hydrate(), loadBarcodes(itemId)]);
    setRefreshing(false);
  };

  const item = products.find((p) => p.id === itemId);
  const itemBarcodes = barcodesByItem[itemId] ?? [];

  const pickable = products.filter((p) => !p.deleted && p.visible).sort((a, b) => a.sort - b.sort);

  const doGenerate = async () => {
    const created = await generateBarcode(itemId, genFormat);
    if (created) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSheet(null);
    }
  };

  const doBatch = async () => {
    const lines = batchText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return;
    const entries = lines.map((code) => ({ code, catalogueItemId: itemId }));
    const result = await batchBarcodes(entries);
    if (result) {
      setBatchResult({ accepted: result.accepted, rejected: result.rejected });
      Haptics.notificationAsync(
        result.rejected > 0 ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Success,
      );
      await loadBarcodes(itemId);
    }
  };

  const doLookup = async () => {
    const code = historyCode.trim();
    if (!code) return;
    setHistoryErr('');
    try {
      const rows = await api.get<BarcodeHistoryEntry[]>(`/barcodes/${encodeURIComponent(code)}/history`, { retries: 1 });
      setHistory(rows);
    } catch (e) {
      setHistory(null);
      setHistoryErr(e instanceof Error ? e.message : t('ce.historyErr'));
    }
  };

  const doDelete = async (code: string) => {
    const ok = await deleteBarcode(itemId, code);
    if (ok) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  return (
    <Screen>
      <FlatList
        data={itemBarcodes}
        keyExtractor={(b) => b.id}
        contentContainerStyle={{ padding: Spacing.md, gap: 10, paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        ListHeaderComponent={
          <View style={{ gap: Spacing.md }}>
            <Card>
              <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '700', marginBottom: 8 }}>
                {t('ce.formats')}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {formats.map((f) => (
                  <Pill key={f.code} label={f.label} tone="neutral" />
                ))}
              </View>
            </Card>
            <View>
              <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '700', marginBottom: 6 }}>
                {t('ce.barcodeItem')}
              </Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                {pickable.map((p) => (
                  <Chip key={p.id} label={p.name} selected={p.id === itemId} onPress={() => setItemId(p.id)} />
                ))}
              </ScrollView>
            </View>
            <Row gap={Spacing.sm}>
              <Btn label={t('ce.generate')} size="sm" icon="qr-code-outline" style={{ flex: 1 }} onPress={() => setSheet('generate')} />
              <Btn label={t('ce.batch')} size="sm" variant="subtle" icon="file-tray-outline" style={{ flex: 1 }} onPress={() => { setBatchText(''); setBatchResult(null); setSheet('batch'); }} />
              <Btn label={t('ce.history')} size="sm" variant="subtle" icon="time-outline" style={{ flex: 1 }} onPress={() => { setHistoryCode(''); setHistory(null); setHistoryErr(''); setSheet('history'); }} />
            </Row>
          </View>
        }
        ListEmptyComponent={
          <Empty icon="barcode-outline" title={t('ce.barcodesEmpty')} sub={t('ce.barcodesEmptySub')} />
        }
        renderItem={({ item: barcode }) => (
          <Card>
            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: FontSize.md, fontFamily: 'monospace', color: Colors.text }}>{barcode.code}</Text>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 }}>
                  {barcode.format.toUpperCase()} · {fullTime(barcode.createdAt)}
                </Text>
              </View>
              <Btn label={t('common.delete')} size="sm" variant="danger" onPress={() => doDelete(barcode.code)} />
            </Row>
          </Card>
        )}
      />

      <SheetModal visible={sheet === 'generate'} onClose={() => setSheet(null)} title={t('ce.generate')}>
        <View style={{ gap: Spacing.md }}>
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>{t('ce.generateFor', { item: item?.name ?? itemId })}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {formats.map((f) => (
              <Chip key={f.code} label={f.code.toUpperCase()} selected={genFormat === f.code} onPress={() => setGenFormat(f.code)} />
            ))}
          </View>
          <Row gap={Spacing.md}>
            <Btn label={t('common.cancel')} size="lg" variant="subtle" style={{ flex: 1 }} onPress={() => setSheet(null)} />
            <Btn label={t('ce.generate')} size="lg" style={{ flex: 1 }} onPress={doGenerate} />
          </Row>
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'batch'} onClose={() => setSheet(null)} title={t('ce.batch')}>
        <View style={{ gap: Spacing.md }}>
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>
            {t('ce.batchFor', { item: item?.name ?? itemId })}
          </Text>
          <Field
            label={t('ce.batchCodes')}
            value={batchText}
            onChangeText={setBatchText}
            placeholder={t('ce.batchPh')}
            multiline
          />
          {batchResult ? (
            <Text style={{ fontSize: FontSize.sm, color: batchResult.rejected ? Colors.warning : Colors.success }}>
              {t('ce.batchResult', { a: batchResult.accepted, r: batchResult.rejected })}
            </Text>
          ) : null}
          <Row gap={Spacing.md}>
            <Btn label={t('common.cancel')} size="lg" variant="subtle" style={{ flex: 1 }} onPress={() => setSheet(null)} />
            <Btn label={t('ce.import')} size="lg" style={{ flex: 1 }} onPress={doBatch} />
          </Row>
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'history'} onClose={() => setSheet(null)} title={t('ce.history')}>
        <View style={{ gap: Spacing.md }}>
          <Field label={t('ce.historyCode')} value={historyCode} onChangeText={setHistoryCode} placeholder={t('ce.historyCodePh')} />
          <Btn label={t('ce.lookup')} size="md" onPress={doLookup} />
          {historyErr ? <Text style={{ fontSize: FontSize.sm, color: Colors.danger }}>{historyErr}</Text> : null}
          {history ? (
            history.length === 0 ? (
              <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary }}>{t('ce.historyEmpty')}</Text>
            ) : (
              history.map((h, i) => (
                <Row key={i} style={{ justifyContent: 'space-between' }}>
                  <Pill label={h.action} tone={h.action === 'scanned' ? 'info' : 'neutral'} />
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{fullTime(h.at)}</Text>
                </Row>
              ))
            )
          ) : null}
          <Btn label={t('common.close')} size="lg" variant="subtle" onPress={() => setSheet(null)} />
        </View>
      </SheetModal>
    </Screen>
  );
}
