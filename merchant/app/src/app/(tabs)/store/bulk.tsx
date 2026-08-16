import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import type { BulkOperation } from '@/api/types';
import { Btn, Card, Empty, Field, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';
import { fullTime } from '@/lib/format';
import { useCatalogueExtStore, type BulkOperationInput } from '@/store/catalogue-ext';

const STORES = [
  { id: 's_demo', name: 'Skewer House BBQ · Kariakoo' },
  { id: 's_demo_2', name: 'Skewer House BBQ · Guomao' },
];

const TYPES = ['price_update', 'availability', 'promotion_apply', 'catalogue_sync'] as const;

const STATUS_TONE: Record<BulkOperation['status'], 'neutral' | 'success' | 'info' | 'danger' | 'warning'> = {
  queued: 'neutral',
  processing: 'info',
  completed: 'success',
  partial: 'warning',
  failed: 'danger',
};

export default function BulkScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const operations = useCatalogueExtStore((s) => s.bulkOperations);
  const hydrate = useCatalogueExtStore((s) => s.hydrate);
  const createBulkOperation = useCatalogueExtStore((s) => s.createBulkOperation);
  const fetchBulkOperation = useCatalogueExtStore((s) => s.fetchBulkOperation);

  const [sheet, setSheet] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [type, setType] = useState<BulkOperation['type']>('price_update');
  const [storeIds, setStoreIds] = useState<string[]>([STORES[0].id]);
  const [payload, setPayload] = useState('{}');
  const [err, setErr] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    hydrate();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [hydrate]);

  const onRefresh = async () => {
    setRefreshing(true);
    await hydrate();
    setRefreshing(false);
  };

  const toggleStore = (id: string) => {
    setStoreIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const create = async () => {
    if (storeIds.length === 0) {
      setErr(t('bulk.errStores'));
      return;
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = payload.trim() ? JSON.parse(payload) : {};
    } catch {
      setErr(t('bulk.errPayload'));
      return;
    }
    const input: BulkOperationInput = { type, storeIds, payload: parsed };
    const created = await createBulkOperation(input);
    if (!created) {
      setErr(t('bulk.errCreate'));
      return;
    }
    setSheet(false);
    setErr('');
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    pollRef.current = setInterval(async () => {
      const current = await fetchBulkOperation(created.id);
      if (current && (current.status === 'completed' || current.status === 'partial' || current.status === 'failed')) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    }, 2000);
  };

  const resultSummary = (op: BulkOperation) => {
    if (op.results.length === 0) return '';
    const ok = op.results.filter((r) => r.ok).length;
    return `${ok}/${op.results.length} ${t('bulk.okStores')}`;
  };

  return (
    <Screen>
      <FlatList
        data={operations}
        keyExtractor={(o) => o.id}
        contentContainerStyle={{ padding: Spacing.md, gap: 10, paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        ListEmptyComponent={<Empty icon="file-tray-outline" title={t('bulk.empty')} sub={t('bulk.emptySub')} />}
        renderItem={({ item }) => (
          <Card>
            <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <View style={{ flex: 1 }}>
                <Row gap={6}>
                  <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.text }}>{t(`bulk.type.${item.type}`)}</Text>
                  {item.requiresApproval ? <Pill label={t('bulk.approval')} tone="warning" /> : null}
                </Row>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 4 }}>
                  {t('bulk.stores', { n: item.storeIds.length })} · {fullTime(item.createdAt)}
                </Text>
                {item.payload && Object.keys(item.payload).length > 0 ? (
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 4 }} numberOfLines={2}>
                    {JSON.stringify(item.payload)}
                  </Text>
                ) : null}
                {resultSummary(item) ? (
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 4 }}>{resultSummary(item)}</Text>
                ) : null}
              </View>
              <Pill label={t(`bulk.status.${item.status}`)} tone={STATUS_TONE[item.status]} />
            </Row>
          </Card>
        )}
      />

      <View style={styles.footer}>
        <Btn label={t('bulk.create')} size="lg" icon="add" onPress={() => { setType('price_update'); setStoreIds([STORES[0].id]); setPayload('{}'); setErr(''); setSheet(true); }} />
      </View>

      <SheetModal visible={sheet} onClose={() => setSheet(false)} title={t('bulk.create')}>
        <View style={{ gap: Spacing.md }}>
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('bulk.typeLabel')}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {TYPES.map((ty) => (
              <Pressable
                key={ty}
                onPress={() => setType(ty)}
                accessibilityRole="button"
                accessibilityLabel={t(`bulk.type.${ty}`)}
                style={[styles.typeChip, type === ty && { borderColor: Colors.primary, backgroundColor: Colors.primarySoft }]}>
                <Text style={{ fontSize: FontSize.xs, color: type === ty ? Colors.primaryDeep : Colors.textSecondary, fontWeight: '700' }}>
                  {t(`bulk.type.${ty}`)}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('bulk.storesLabel')}</Text>
          {STORES.map((s) => {
            const selected = storeIds.includes(s.id);
            return (
              <Pressable
                key={s.id}
                onPress={() => toggleStore(s.id)}
                accessibilityRole="button"
                accessibilityLabel={s.name}
                accessibilityState={{ selected }}
                style={({ pressed }) => [styles.storeRow, selected && { borderColor: Colors.primary }, pressed && { opacity: 0.8 }]}>
                <Text style={{ flex: 1, fontSize: FontSize.sm, color: Colors.text, fontWeight: selected ? '700' : '500' }} numberOfLines={1}>
                  {s.name}
                </Text>
                {selected ? <Text style={{ color: Colors.primaryDeep, fontWeight: '800' }}>✓</Text> : null}
              </Pressable>
            );
          })}
          <Field label={t('bulk.payload')} value={payload} onChangeText={setPayload} placeholder={t('bulk.payloadPh')} multiline />
          {err ? <Text style={{ fontSize: FontSize.sm, color: Colors.danger }}>{err}</Text> : null}
          <Row gap={Spacing.md}>
            <Btn label={t('common.cancel')} size="lg" variant="subtle" style={{ flex: 1 }} onPress={() => setSheet(false)} />
            <Btn label={t('bulk.run')} size="lg" style={{ flex: 1 }} onPress={create} />
          </Row>
        </View>
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  typeChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
  },
  storeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 10,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
    gap: Spacing.sm,
  },
  footer: {
    padding: Spacing.lg,
    paddingBottom: 28,
    backgroundColor: Colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
});
