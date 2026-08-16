import { Stack, router } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { t, onLocaleChange } from '@/i18n';
import { Card, Empty, Icon, Screen } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { api } from '@/api/client';
import type { AuditLog } from '@/api/types';
import { fullTime } from '@/lib/format';
import { useSessionStore } from '@/store/session';

const ACTION_META: Record<string, { icon: 'receipt-outline' | 'storefront-outline' | 'megaphone-outline' | 'shield-checkmark-outline' | 'wallet-outline' | 'person-add-outline'; tint: string }> = {
  'orders:accept': { icon: 'receipt-outline', tint: Colors.info },
  'orders:reject': { icon: 'receipt-outline', tint: Colors.danger },
  'orders:refund-decide': { icon: 'receipt-outline', tint: Colors.warning },
  'orders:rush-reply': { icon: 'receipt-outline', tint: 'Colors.violet' },
  'menu:update': { icon: 'storefront-outline', tint: Colors.success },
  'store:update': { icon: 'storefront-outline', tint: Colors.success },
  'campaigns:create': { icon: 'megaphone-outline', tint: Colors.warning },
  'campaigns:stop': { icon: 'megaphone-outline', tint: Colors.warning },
  'campaigns:platform-signup': { icon: 'megaphone-outline', tint: Colors.warning },
  'campaigns:segment-coupon': { icon: 'megaphone-outline', tint: Colors.success },
  'finance:withdraw': { icon: 'wallet-outline', tint: Colors.danger },
  'finance:settlement': { icon: 'wallet-outline', tint: Colors.success },
  'finance:payout': { icon: 'wallet-outline', tint: Colors.success },
  'finance:invoice': { icon: 'wallet-outline', tint: Colors.info },
  'auth:login': { icon: 'shield-checkmark-outline', tint: Colors.info },
  'team:*': { icon: 'person-add-outline', tint: Colors.textSecondary },
  'privacy:*': { icon: 'shield-checkmark-outline', tint: 'Colors.violet' },
  'support:*': { icon: 'shield-checkmark-outline', tint: 'Colors.rose' },
};

export default function AuditScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const perms = useSessionStore((s) => s.perms);
  const canView = perms.includes('*') || perms.includes('audit:view');
  const [logs, setLogs] = useState<AuditLog[]>([]);

  useEffect(() => {
    if (!canView) return;
    api.get<{ logs: AuditLog[] }>('/audit/me?limit=200', { retries: 1 }).then((r) => setLogs(r.logs)).catch(() => undefined);
  }, [canView]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('aud.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        {!canView ? (
          <Card style={styles.noAccess}>
            <Icon name="lock-closed-outline" size={20} color={Colors.warning} />
            <Text style={{ flex: 1, fontSize: FontSize.sm, color: Colors.textSecondary }}>
              {t('aud.note')}
            </Text>
          </Card>
        ) : (
          <>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginBottom: 8 }}>
              {t('aud.count', { n: logs.length })}
            </Text>
            {logs.length === 0 ? <Empty icon="shield-outline" title={t('aud.empty')} /> : null}
            <View style={{ gap: Spacing.sm }}>
              {logs.map((l) => {
                const meta = ACTION_META[l.action] ?? ACTION_META['team:*'];
                return (
                  <Card key={l.id} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 12 }}>
                    <View style={[styles.icon, { backgroundColor: `${meta.tint}1A` }]}>
                      <Icon name={meta.icon} size={16} color={meta.tint} />
                    </View>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text }} numberOfLines={1}>{l.detail}</Text>
                      <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                        {l.action} · {l.role} {l.actor === 'customer-platform' ? t('msg.catSystem') : ''}
                      </Text>
                    </View>
                    <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{fullTime(l.ts)}</Text>
                  </Card>
                );
              })}
            </View>
          </>
        )}
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
  noAccess: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  icon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
