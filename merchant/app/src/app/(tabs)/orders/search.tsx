import { router } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { FlatList, StyleSheet, Text, TextInput, View } from 'react-native';

import { Btn, Card, Chip, Empty, Icon, Pill, Row, Screen } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { clock, tzs } from '@/lib/format';
import { ApiError } from '@/api/client';
import type { OrderDto } from '@/api/types';
import { useOrderStore } from '@/store/orders';

const STATUS_FILTERS: { key: string; label: I18nKey }[] = [
  { key: 'all', label: 'sr.allStatuses' },
  { key: 'new', label: 'orders.tabAccept' },
  { key: 'preparing', label: 'orders.tabPreparing' },
  { key: 'ready', label: 'orders.tabReady' },
  { key: 'completed', label: 'orders.tabCompleted' },
  { key: 'cancelled', label: 'orders.tabCancelled' },
];

export default function OrderSearchScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const results = useOrderStore((s) => s.searchResults);
  const searchLoaded = useOrderStore((s) => s.searchLoaded);
  const searchOrders = useOrderStore((s) => s.searchOrders);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    if (!query && status === 'all' && !from && !to) {
      searchOrders({}).then(() => setSearched(true));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runSearch = async () => {
    setBusy(true);
    setError(null);
    try {
      await searchOrders({ q: query.trim() || undefined, status, from: from.trim() || undefined, to: to.trim() || undefined });
      setSearched(true);
    } catch (e) {
      if (e instanceof ApiError) setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={styles.box}>
        <Icon name="search" size={16} color={Colors.textTertiary} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t('sr.ph')}
          placeholderTextColor={Colors.textTertiary}
          maxLength={120}
          onSubmitEditing={runSearch}
          returnKeyType="search"
          style={styles.input}
        />
        {query ? (
          <Btn label={t('sr.search')} size="sm" onPress={runSearch} loading={busy} />
        ) : null}
      </View>

      <View style={styles.filters}>
        <Text style={styles.label}>{t('sr.allStatuses')}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm }}>
          {STATUS_FILTERS.map((f) => (
            <Chip key={f.key} label={t(f.label)} selected={status === f.key} onPress={() => setStatus(f.key)} />
          ))}
        </View>
        <Row gap={Spacing.sm} style={{ marginTop: Spacing.md }}>
          <View style={styles.dateField}>
            <Text style={styles.dateLabel}>{t('sr.from')}</Text>
            <TextInput value={from} onChangeText={setFrom} placeholder={t('sr.datePh')} placeholderTextColor={Colors.textTertiary} style={styles.dateInput} />
          </View>
          <View style={styles.dateField}>
            <Text style={styles.dateLabel}>{t('sr.to')}</Text>
            <TextInput value={to} onChangeText={setTo} placeholder={t('sr.datePh')} placeholderTextColor={Colors.textTertiary} style={styles.dateInput} />
          </View>
        </Row>
        <Btn label={t('sr.search')} onPress={runSearch} loading={busy} style={{ marginTop: Spacing.md }} />
      </View>

      {error ? (
        <View style={styles.errorBanner}>
          <Icon name="alert-circle-outline" size={16} color={Colors.danger} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {searched && !error ? (
        <Text style={styles.count}>{t('sr.results', { n: results.length })}</Text>
      ) : null}

      <FlatList
        data={results}
        keyExtractor={(o) => o.id}
        contentContainerStyle={{ padding: Spacing.lg, paddingTop: 4, paddingBottom: 120, gap: Spacing.md }}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          !searchLoaded ? null : <Empty icon="search-outline" title={t('sr.empty')} />
        }
        renderItem={({ item }: { item: OrderDto }) => (
          <Card style={styles.row} onPress={() => router.push(`/orders/${item.id}`)}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.no}>{item.no}</Text>
              <Row gap={8}>
                {item.scheduledAt ? <Pill label={t('orders.preorder')} tone="warning" /> : null}
                <Pill label={item.status.toUpperCase()} tone="info" />
              </Row>
            </Row>
            <View style={{ gap: 2 }}>
              {item.items.slice(0, 2).map((it, i) => (
                <Text key={i} style={styles.item} numberOfLines={1}>
                  {it.name} ×{it.qty}
                </Text>
              ))}
            </View>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.meta}>
                {item.customer.name} · {clock(item.createdAt)}
              </Text>
              <Text style={styles.total}>{tzs(item.total)}</Text>
            </Row>
          </Card>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.md,
    backgroundColor: Colors.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    paddingHorizontal: Spacing.md,
    height: 44,
  },
  input: { flex: 1, fontSize: FontSize.sm, color: Colors.text, paddingVertical: 0 },
  filters: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.md, gap: Spacing.sm },
  label: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  dateField: { flex: 1, gap: 4 },
  dateLabel: { fontSize: FontSize.xs, color: Colors.textTertiary },
  dateInput: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    fontSize: FontSize.sm,
    color: Colors.text,
  },
  errorBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: Spacing.lg, marginTop: Spacing.md, padding: 10, borderRadius: Radius.md, backgroundColor: `${Colors.danger}14`, borderWidth: 1, borderColor: `${Colors.danger}40` },
  errorText: { flex: 1, fontSize: FontSize.xs, color: Colors.danger, fontWeight: '600' },
  count: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.md, fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '700' },
  row: { gap: 8, paddingVertical: 14 },
  no: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text },
  item: { fontSize: FontSize.sm, color: Colors.textSecondary },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary },
  total: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text },
});
