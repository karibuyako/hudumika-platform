import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, ApiError } from '@/api/client';
import type { ProductRow } from '@/api/types';
import { Btn, Card, Icon, Pill, Row, Screen } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';
import { useCatalogStore } from '@/store/catalog';

interface Suggestion {
  id: string;
  type: string;
  title: string;
  detail: string;
  value: Record<string, unknown>;
}

export default function AssistantScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const products = useCatalogStore((s) => s.products);
  const hydrate = useCatalogStore((s) => s.hydrate);

  const [productId, setProductId] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [applying, setApplying] = useState('');
  const [toast, setToast] = useState('');

  const [describeName, setDescribeName] = useState('');
  const [described, setDescribed] = useState<string | null>(null);
  const [describeBusy, setDescribeBusy] = useState(false);
  const [describeErr, setDescribeErr] = useState('');

  useEffect(() => {
    if (!products.length) void hydrate();
  }, [products.length, hydrate]);

  const loadSuggestions = async (pid: string) => {
    setProductId(pid);
    setSuggestions(null);
    setError('');
    setLoading(true);
    try {
      const res = await api.get<{ suggestions: Suggestion[] }>(`/products/assistant/suggestions?productId=${pid}`, { retries: 1 });
      setSuggestions(res.suggestions);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('prda.error'));
    } finally {
      setLoading(false);
    }
  };

  const apply = async (s: Suggestion) => {
    if (!productId) return;
    setApplying(s.id);
    setError('');
    try {
      await api.post<{ product: ProductRow; applied: string }>('/products/assistant/apply', { productId, suggestionId: s.id });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setToast(s.title);
      setTimeout(() => setToast(''), 2400);
      await hydrate();
      await loadSuggestions(productId);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('prda.applyErr'));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setApplying('');
    }
  };

  const describe = async () => {
    const name = describeName.trim();
    if (!name) return;
    setDescribeBusy(true);
    setDescribeErr('');
    setDescribed(null);
    try {
      const res = await api.post<{ description: string }>('/products/assistant/describe', { name });
      setDescribed(res.description);
    } catch (e) {
      setDescribeErr(e instanceof ApiError ? e.message : t('prda.describeErr'));
    } finally {
      setDescribeBusy(false);
    }
  };

  const useDescription = async () => {
    if (!described || !productId) return;
    setDescribeBusy(true);
    try {
      await api.patch<{ product: ProductRow }>(`/catalogue-items/${productId}`, { description: described });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setToast(t('prda.applied'));
      setTimeout(() => setToast(''), 2400);
      await hydrate();
    } catch (e) {
      setDescribeErr(e instanceof ApiError ? e.message : t('prda.describeErr'));
    } finally {
      setDescribeBusy(false);
    }
  };

  const selected = products.find((p) => p.id === productId);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('common.back')}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('prda.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <Card style={{ gap: Spacing.sm }}>
          <Text style={styles.sectionLabel}>{t('prda.pickProduct')}</Text>
          {products.length === 0 ? (
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('prd.empty')}</Text>
          ) : (
            <Row gap={6} style={{ flexWrap: 'wrap' }}>
              {products.map((p) => {
                const selectedFlag = p.id === productId;
                return (
                  <Pressable
                    key={p.id}
                    onPress={() => void loadSuggestions(p.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`${p.emoji} ${p.name}`}
                    accessibilityState={{ selected: selectedFlag }}
                    style={[styles.chip, selectedFlag && styles.chipActive]}>
                    <Text style={[styles.chipText, selectedFlag && { color: Colors.text, fontWeight: '700' }]} numberOfLines={1}>
                      {p.emoji} {p.name}
                    </Text>
                  </Pressable>
                );
              })}
            </Row>
          )}
        </Card>

        {productId ? (
          <Card style={{ marginTop: Spacing.md, gap: Spacing.sm }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.sectionLabel}>{t('prda.suggestions')}</Text>
              {selected ? <Pill label={selected.name} tone="neutral" /> : null}
            </Row>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('prda.suggestionsSub')}</Text>

            {loading ? (
              <View style={styles.centerBox}>
                <ActivityIndicator color={Colors.primary} />
                <Text style={styles.centerText}>{t('prda.loading')}</Text>
              </View>
            ) : error ? (
              <View style={styles.centerBox}>
                <Icon name="cloud-offline-outline" size={20} color={Colors.textTertiary} />
                <Text style={styles.centerText}>{error}</Text>
                <Btn label={t('prda.retry')} size="sm" variant="outline" onPress={() => void loadSuggestions(productId)} />
              </View>
            ) : suggestions && suggestions.length === 0 ? (
              <View style={styles.centerBox}>
                <Icon name="checkmark-circle-outline" size={20} color={Colors.success} />
                <Text style={styles.centerText}>{t('prda.empty')}</Text>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('prda.emptySub')}</Text>
              </View>
            ) : (
              suggestions?.map((s) => (
                <Card key={s.id} style={{ gap: 4, backgroundColor: Colors.surface }}>
                  <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: Spacing.sm }}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text }}>{s.title}</Text>
                      <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary, lineHeight: 16 }}>{s.detail}</Text>
                    </View>
                    <Btn label={t('prda.apply')} size="sm" loading={applying === s.id} disabled={applying !== ''} onPress={() => void apply(s)} />
                  </Row>
                </Card>
              ))
            )}
          </Card>
        ) : null}

        <Card style={{ marginTop: Spacing.md, gap: Spacing.sm }}>
          <Text style={styles.sectionLabel}>{t('prda.describe')}</Text>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('prda.describeHint')}</Text>
          <TextInput
            value={describeName}
            onChangeText={setDescribeName}
            placeholder={t('prda.describePh')}
            placeholderTextColor={Colors.textTertiary}
            style={styles.input}
            maxLength={160}
          />
          <Btn label={t('prda.describeBtn')} size="sm" loading={describeBusy} disabled={!describeName.trim()} onPress={describe} />
          {describeErr ? <Text style={{ fontSize: FontSize.xs, color: Colors.danger }}>{describeErr}</Text> : null}
          {described ? (
            <View style={{ gap: Spacing.sm }}>
              <Card style={{ gap: 4, backgroundColor: Colors.primarySoft }}>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600' }}>{t('prda.describeResult')}</Text>
                <Text style={{ fontSize: FontSize.sm, color: Colors.text, lineHeight: 19 }}>{described}</Text>
              </Card>
              <Btn
                label={t('prda.describeUse')}
                size="sm"
                variant="subtle"
                disabled={!productId}
                onPress={useDescription}
              />
              {!productId ? <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('prda.pickProduct')}</Text> : null}
            </View>
          ) : null}
        </Card>

        {toast ? (
          <Card style={{ marginTop: Spacing.md, backgroundColor: Colors.successSoft }}>
            <Row gap={Spacing.sm}>
              <Icon name="checkmark-circle" size={18} color={Colors.success} />
              <Text style={{ fontSize: FontSize.sm, color: Colors.success, fontWeight: '700' }}>{toast}</Text>
            </Row>
          </Card>
        ) : null}
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
  topTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  sectionLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
    maxWidth: 220,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primaryDark },
  chipText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 11,
    fontSize: FontSize.sm,
    color: Colors.text,
    backgroundColor: Colors.card,
  },
  centerBox: { alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.lg },
  centerText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
});
