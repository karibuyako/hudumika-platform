import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Chip, Empty, Icon, Pill, Row, Screen } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { api, ApiError } from '@/api/client';
import type { ComplianceStatus, StoreListItem, StoreLog } from '@/api/types';
import { timeAgo } from '@/lib/format';

const STATUS_META: Record<ComplianceStatus['status'], { label: I18nKey; fg: string; bg: string }> = {
  compliant: { label: 'comp.compliant', fg: Colors.success, bg: Colors.successSoft },
  attention: { label: 'comp.attention', fg: Colors.warning, bg: Colors.warningSoft },
  suspended: { label: 'comp.suspended', fg: Colors.danger, bg: Colors.dangerSoft },
};

export default function ComplianceScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const [stores, setStores] = useState<StoreListItem[]>([]);
  const [storeId, setStoreId] = useState('s_demo');
  const [compliance, setCompliance] = useState<ComplianceStatus | null>(null);
  const [rechecks, setRechecks] = useState<StoreLog[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadRechecks = useCallback((id: string) => {
    api
      .get<{ logs: StoreLog[] }>(`/store/logs?storeId=${id}`, { retries: 1 })
      .then((r) => setRechecks(r.logs.filter((l) => l.action === 'compliance:recheck').sort((a, b) => b.ts - a.ts).slice(0, 3)))
      .catch(() => setRechecks([]));
  }, []);

  useEffect(() => {
    api
      .get<{ stores: StoreListItem[] }>('/stores', { retries: 1 })
      .then((r) => setStores(r.stores))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    loadRechecks(storeId);
    api
      .get<{ compliance: ComplianceStatus }>(`/stores/${storeId}/compliance`, { retries: 1 })
      .then((r) => setCompliance(r.compliance))
      .catch((e) => setError(e instanceof ApiError ? e.message : t('comp.errLoad')));
  }, [storeId, loadRechecks]);

  const recheck = async () => {
    setBusy(true);
    setError('');
    try {
      // POST /store/compliance/recheck runs the job state machine
      // (queued → processing → completed); a running job 409s with
      // COMPLIANCE_RECHECK_IN_PROGRESS.
      const r = await api.post<{ jobId: string; status: string; compliance: ComplianceStatus }>(`/store/compliance/recheck?storeId=${storeId}`);
      setCompliance(r.compliance);
      loadRechecks(storeId);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setError(e instanceof ApiError ? (e.status === 409 ? t('comp.inProgress') : e.message) : t('comp.errRecheck'));
    } finally {
      setBusy(false);
    }
  };

  const meta = compliance ? STATUS_META[compliance.status] : null;
  const passed = compliance ? compliance.checks.filter((c) => c.pass).length : 0;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('comp.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {stores.map((s) => (
            <Chip key={s.id} label={s.name} selected={storeId === s.id} onPress={() => setStoreId(s.id)} />
          ))}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {busy ? (
          <Card style={styles.busyCard}>
            <Icon name="hourglass-outline" size={22} color={Colors.warning} />
            <Text style={{ color: Colors.textSecondary, fontSize: FontSize.sm, fontWeight: '600' }}>{t('comp.rechecking')}</Text>
          </Card>
        ) : null}

        {compliance && meta ? (
          <>
            <Card style={[styles.hero, { backgroundColor: meta.bg }]}>
              <Row style={{ justifyContent: 'space-between' }}>
                <View style={{ gap: 4 }}>
                  <Text style={[styles.heroStatus, { color: meta.fg }]}>{t(meta.label).toUpperCase()}</Text>
                  <Text style={[styles.heroScore, { color: meta.fg }]}>
                    {compliance.score}<Text style={styles.heroScoreUnit}>%</Text>
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  <Pill label={compliance.status === 'compliant' ? t('comp.allPass') : t('comp.passed', { passed, total: compliance.checks.length })} tone={compliance.status === 'compliant' ? 'success' : compliance.status === 'suspended' ? 'danger' : 'warning'} />
                  <Text style={styles.heroMeta}>{t('comp.checked', { time: timeAgo(compliance.updatedAt) })}</Text>
                </View>
              </Row>
            </Card>

            <Btn label={t('comp.recheck')} icon="refresh" size="md" loading={busy} onPress={recheck} />

            <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
              {compliance.checks.length === 0 ? <Empty icon="shield-checkmark-outline" title={t('comp.empty')} sub={t('comp.emptySub')} /> : null}
              {compliance.checks.map((c) => {
                const failTone = compliance.status === 'suspended' ? Colors.danger : Colors.warning;
                return (
                  <Card key={c.key} style={{ gap: 6 }}>
                    <Row style={{ justifyContent: 'space-between' }}>
                      <Row gap={10} style={{ flex: 1 }}>
                        <Icon
                          name={c.pass ? 'checkmark-circle' : compliance.status === 'suspended' ? 'close-circle' : 'alert-circle'}
                          size={19}
                          color={c.pass ? Colors.success : failTone}
                        />
                        <Text style={{ fontSize: FontSize.md, fontWeight: '600', color: Colors.text }} numberOfLines={1}>{c.label}</Text>
                      </Row>
                      <Pill label={c.pass ? t('comp.pass') : t('comp.fail')} tone={c.pass ? 'success' : compliance.status === 'suspended' ? 'danger' : 'warning'} />
                    </Row>
                    <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 16 }}>{c.detail}</Text>
                  </Card>
                );
              })}
            </View>

            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: Spacing.md }}>
              {t('comp.lastChecked', { time: timeAgo(compliance.updatedAt) })}
            </Text>

            <Card style={{ gap: Spacing.sm, marginTop: Spacing.md }}>
              <Text style={{ fontSize: FontSize.sm, fontWeight: '800', color: Colors.text }}>{t('comp.history')}</Text>
              {rechecks.length === 0 ? (
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('comp.noRechecks')}</Text>
              ) : (
                rechecks.map((l) => {
                  const after = l.after as { status?: string; score?: number } | undefined;
                  return (
                    <Text key={l.id} style={{ fontSize: FontSize.xs, color: Colors.textSecondary }}>
                      {timeAgo(l.ts)} · {after?.status} · {after?.score}%
                    </Text>
                  );
                })
              )}
            </Card>
          </>
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
  error: { color: Colors.danger, fontSize: FontSize.xs, marginTop: Spacing.sm },
  busyCard: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginTop: Spacing.md },
  hero: { borderRadius: Radius.lg, marginTop: Spacing.md },
  heroStatus: { fontSize: FontSize.sm, fontWeight: '800', letterSpacing: 1 },
  heroScore: { fontSize: 44, fontWeight: '900', fontVariant: ['tabular-nums'] },
  heroScoreUnit: { fontSize: FontSize.lg, fontWeight: '700' },
  heroMeta: { fontSize: FontSize.xs, color: Colors.textTertiary },
});
