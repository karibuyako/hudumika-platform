import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Empty, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { api, ApiError } from '@/api/client';
import { t, onLocaleChange } from '@/i18n';
import type { ActiveSession } from '@/api/types';
import { useSessionStore } from '@/store/session';
import { timeAgo } from '@/lib/format';

export default function SessionsScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const token = useSessionStore((s) => s.token);
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revokeTarget, setRevokeTarget] = useState<ActiveSession | null>(null);
  const [logoutOthers, setLogoutOthers] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await api.get<{ sessions: ActiveSession[] }>('/sessions', { retries: 1 });
      setSessions(res.sessions.filter((s) => !s.revoked));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('ses.errLoad'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const revoke = async (s: ActiveSession) => {
    setBusy(true);
    setError('');
    try {
      await api.post(`/sessions/${s.token}/revoke`);
      setSessions((list) => list.filter((x) => x.token !== s.token));
      setRevokeTarget(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('ses.errRevoke'));
    } finally {
      setBusy(false);
    }
  };

  const revokeOthers = async () => {
    setBusy(true);
    setError('');
    try {
      const others = sessions.filter((s) => s.token !== token);
      for (const s of others) {
        await api.post(`/sessions/${s.token}/revoke`);
      }
      setSessions((list) => list.filter((s) => s.token === token));
      setLogoutOthers(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('ses.errRevoke'));
    } finally {
      setBusy(false);
    }
  };

  const others = sessions.filter((s) => s.token !== token);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('ses.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <Text style={styles.sub}>{t('ses.sub')}</Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        {loading && sessions.length === 0 ? (
          <Card style={styles.centerCard}>
            <Text style={{ color: Colors.textSecondary, fontSize: FontSize.sm }}>{t('common.loading')}</Text>
          </Card>
        ) : (
          <Card style={{ paddingVertical: 0, overflow: 'hidden', marginTop: Spacing.md }}>
            {sessions.length === 0 ? (
              <View style={{ paddingVertical: Spacing.lg }}>
                <Empty icon="phone-portrait-outline" title={t('ses.empty')} />
              </View>
            ) : (
              sessions.map((s, i) => {
                const current = s.token === token;
                return (
                  <View key={s.token}>
                    {i > 0 ? <View style={styles.divider} /> : null}
                    <Row style={{ justifyContent: 'space-between', alignItems: 'center', paddingVertical: Spacing.sm }}>
                      <View style={{ flex: 1, gap: 2 }}>
                        <Row gap={6} style={{ alignItems: 'center' }}>
                          <Icon name="phone-portrait-outline" size={15} color={Colors.textSecondary} />
                          <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.text }}>{s.device}</Text>
                          {current ? <Pill label={t('ses.current')} tone="info" /> : null}
                        </Row>
                        <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                          {t('ses.signedIn', { time: timeAgo(s.createdAt) })} · {s.ip}
                        </Text>
                      </View>
                      {!current ? (
                        <Btn label={t('ses.revoke')} variant="danger" size="sm" onPress={() => setRevokeTarget(s)} />
                      ) : null}
                    </Row>
                  </View>
                );
              })
            )}
          </Card>
        )}

        {others.length > 0 ? (
          <Btn
            label={t('ses.logoutOthers')}
            variant="outline"
            size="md"
            loading={busy}
            onPress={() => setLogoutOthers(true)}
            style={{ marginTop: Spacing.lg }}
          />
        ) : null}
      </Screen>

      <SheetModal visible={!!revokeTarget} onClose={() => setRevokeTarget(null)} title={t('ses.revokeTitle')}>
        <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 }}>
          {t('ses.revokeBody')}
        </Text>
        <Row gap={10}>
          <Btn label={t('common.cancel')} variant="outline" onPress={() => setRevokeTarget(null)} style={{ flex: 1 }} />
          <Btn label={t('ses.revoke')} variant="danger" loading={busy} onPress={() => revokeTarget && revoke(revokeTarget)} style={{ flex: 1 }} />
        </Row>
      </SheetModal>

      <SheetModal visible={logoutOthers} onClose={() => setLogoutOthers(false)} title={t('ses.logoutOthers')}>
        <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 }}>
          {t('ses.logoutOthersBody')}
        </Text>
        <Row gap={10}>
          <Btn label={t('common.cancel')} variant="outline" onPress={() => setLogoutOthers(false)} style={{ flex: 1 }} />
          <Btn label={t('ses.logoutOthers')} variant="danger" loading={busy} onPress={revokeOthers} style={{ flex: 1 }} />
        </Row>
      </SheetModal>
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
  sub: { fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 16, marginTop: Spacing.md },
  error: { color: Colors.danger, fontSize: FontSize.xs, marginTop: Spacing.sm },
  centerCard: { alignItems: 'center', paddingVertical: Spacing.xl, marginTop: Spacing.lg },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border },
});
