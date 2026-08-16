import { Stack, router } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card, Chip, Empty, Icon, Row, Screen } from '@/components/ui';
import type { IconName } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';
import { api, ApiError } from '@/api/client';
import type { StoreListItem, StoreLog } from '@/api/types';
import { timeAgo } from '@/lib/format';

const ACTION_META: Record<string, { icon: IconName; color: string }> = {
  'store:update': { icon: 'create-outline', color: Colors.info },
  'store:reopen': { icon: 'refresh', color: Colors.success },
  'store:close': { icon: 'lock-closed-outline', color: Colors.danger },
  'closure:apply': { icon: 'shield', color: Colors.success },
  'closure:cancel': { icon: 'shield-outline', color: Colors.warning },
  'closure:expire': { icon: 'timer-outline', color: Colors.textTertiary },
};

const DEFAULT_META: { icon: IconName; color: string } = { icon: 'document-text-outline', color: Colors.textTertiary };

const diffSnippet = (before: unknown, after: unknown) => {
  const prev = JSON.stringify(before);
  const next = JSON.stringify(after);
  const truncate = (s: string) => (s.length > 60 ? `${s.slice(0, 60)}…` : s);
  return `${truncate(prev)} → ${truncate(next)}`;
};

export default function LogsScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const [stores, setStores] = useState<StoreListItem[]>([]);
  const [storeId, setStoreId] = useState('s_demo');
  const [logs, setLogs] = useState<StoreLog[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get<{ stores: StoreListItem[] }>('/stores', { retries: 1 })
      .then((r) => setStores(r.stores))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    api
      .get<{ logs: StoreLog[] }>(`/store/logs?storeId=${storeId}`, { retries: 1 })
      .then((r) => setLogs(r.logs))
      .catch((e) => setError(e instanceof ApiError ? e.message : t('olog.err')));
  }, [storeId]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('olog.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {stores.map((s) => (
            <Chip key={s.id} label={s.name} selected={storeId === s.id} onPress={() => setStoreId(s.id)} />
          ))}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
          {logs.length === 0 ? <Empty icon="document-text-outline" title={t('olog.empty')} sub={t('olog.emptySub')} /> : null}
          {logs.map((l) => {
            const meta = ACTION_META[l.action] ?? DEFAULT_META;
            return (
              <Card key={l.id} style={{ gap: Spacing.sm }}>
                <Row gap={10} style={{ alignItems: 'flex-start' }}>
                  <View style={styles.iconBox}>
                    <Icon name={meta.icon} size={17} color={meta.color} />
                  </View>
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text style={styles.title} numberOfLines={1}>
                      {l.action}
                      {l.field ? ` · ${l.field}` : ''}
                    </Text>
                    {l.before !== undefined && l.after !== undefined ? (
                      <Text style={styles.diff} numberOfLines={2}>{diffSnippet(l.before, l.after)}</Text>
                    ) : null}
                    <Text style={styles.meta}>{l.role} · {timeAgo(l.ts)}</Text>
                  </View>
                </Row>
              </Card>
            );
          })}
        </View>
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
  error: { color: Colors.danger, fontSize: FontSize.xs, marginTop: Spacing.sm },
  iconBox: {
    width: 34,
    height: 34,
    borderRadius: Radius.sm,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  diff: { fontSize: FontSize.xs, color: Colors.textSecondary, lineHeight: 16 },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary },
});
