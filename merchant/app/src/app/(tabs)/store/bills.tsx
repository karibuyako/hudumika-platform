import { Stack, router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Chip, Empty, Icon, Pill, Row, Screen } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { api } from '@/api/client';
import type { DineInOrder, StoreListItem, TableRow } from '@/api/types';
import { useDineInStore } from '@/store/dine-in';
import { fullTime, tzs } from '@/lib/format';

type Filter = 'all' | DineInOrder['status'];

const FILTERS: { key: Filter; label: I18nKey }[] = [
  { key: 'all', label: 'common.all' },
  { key: 'billing', label: 'din.billing' },
  { key: 'paid', label: 'din.paid' },
  { key: 'closed', label: 'din.closed' },
];

const STATUS_TONE: Record<DineInOrder['status'], 'danger' | 'warning' | 'info' | 'success' | 'neutral'> = {
  open: 'warning',
  billing: 'danger',
  paid: 'info',
  closed: 'neutral',
  cancelled: 'neutral',
};

const STATUS_LABEL: Record<DineInOrder['status'], I18nKey> = {
  open: 'din.open',
  billing: 'din.billing',
  paid: 'din.paid',
  closed: 'din.closed',
  cancelled: 'ui.status.cancelled',
};

export default function BillsScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const { bills, loading, error, hydrateBills } = useDineInStore();
  const [filter, setFilter] = useState<Filter>('all');
  const [tableNames, setTableNames] = useState<Record<string, string>>({});

  useEffect(() => {
    api
      .get<{ stores: StoreListItem[] }>('/stores', { retries: 1 })
      .then(async (r) => {
        const map: Record<string, string> = {};
        for (const s of r.stores) {
          try {
            const tables = await api.get<{ tables: TableRow[] }>(`/dine-in/tables?storeId=${s.id}`, { retries: 1 });
            tables.tables.forEach((tb) => {
              map[tb.id] = tb.name;
            });
          } catch {
            /* skip store */
          }
        }
        setTableNames(map);
      })
      .catch(() => undefined);
  }, []);

  const load = useCallback(() => {
    hydrateBills(filter === 'all' ? undefined : filter);
  }, [filter, hydrateBills]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => (filter === 'all' ? bills : bills.filter((b) => b.status === filter)), [bills, filter]);

  const countOf = (status: Filter) => (status === 'all' ? bills.length : bills.filter((b) => b.status === status).length);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('din.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <Row gap={6} style={{ flexWrap: 'wrap' }}>
          {FILTERS.map((f) => (
            <Chip
              key={f.key}
              label={t(f.label)}
              count={countOf(f.key)}
              selected={filter === f.key}
              onPress={() => setFilter(f.key)}
            />
          ))}
        </Row>

        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.error}>{error}</Text>
            <Btn label={t('common.retry')} variant="outline" size="sm" onPress={load} />
          </View>
        ) : null}

        {loading ? (
          <View style={{ gap: Spacing.md, marginTop: Spacing.lg }}>
            {[0, 1, 2].map((i) => (
              <View key={i} style={styles.skeleton} />
            ))}
          </View>
        ) : null}

        {!loading && !error && visible.length === 0 ? (
          <Empty icon="receipt-outline" title={t('din.empty')} sub={t('din.emptySub')} />
        ) : null}

        <View style={{ gap: Spacing.sm, marginTop: Spacing.lg }}>
          {visible.map((b) => (
            <CardRow
              key={b.id}
              bill={b}
              tableLabel={tableNames[b.tableId] ?? t('din.table')}
              onPress={() => router.push(`/store/bill/${b.id}` as never)}
            />
          ))}
        </View>
      </Screen>
    </SafeAreaView>
  );
}

function CardRow({ bill, tableLabel, onPress }: { bill: DineInOrder; tableLabel: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={tableLabel} style={({ pressed }) => [styles.row, pressed && { opacity: 0.85 }]}>
      <View style={styles.rowIcon}>
        <Icon name="restaurant-outline" size={18} color={Colors.primaryDark} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.rowTitle} numberOfLines={1}>{tableLabel}</Text>
        <Text style={styles.rowSub} numberOfLines={1}>
          {t('din.items', { n: bill.items.reduce((s, it) => s + it.quantity, 0) })} · {t('din.opened', { time: fullTime(bill.createdAt) })}
        </Text>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        <Text style={styles.rowTotal}>{tzs(bill.totals.totalTZS)}</Text>
        <Pill label={t(STATUS_LABEL[bill.status]).toUpperCase()} tone={STATUS_TONE[bill.status]} />
      </View>
    </Pressable>
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
  errorBox: { gap: Spacing.sm, marginTop: Spacing.md },
  error: { color: Colors.danger, fontSize: FontSize.sm },
  skeleton: {
    height: 72,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    opacity: 0.6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    backgroundColor: Colors.card,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    padding: Spacing.md,
  },
  rowIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: Colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  rowSub: { fontSize: FontSize.xs, color: Colors.textTertiary },
  rowTotal: { fontSize: FontSize.sm, fontWeight: '800', color: Colors.text, fontVariant: ['tabular-nums'] },
});