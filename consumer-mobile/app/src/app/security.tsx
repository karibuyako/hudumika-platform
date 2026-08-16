import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { Btn, Card, EmptyState, ErrorState, Field, ListRow, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, Fonts, FontSize, NumberStyle, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { ApiError } from '@/api/client';
import { getAuthRepository } from '@/repos';
import type { TwoFactorStatus } from '@/repos';
import { useSessionStore } from '@/store/session';
import { idempotencyKey } from '@/lib/idempotency';
import { timeAgoISO } from '@/lib/dates';
import type { SessionInfo } from '@hudumika/contract';

export default function SecurityScreen() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [twoFactor, setTwoFactor] = useState<TwoFactorStatus | null>(null);
  const [error, setError] = useState('');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  // 2FA enable/disable flow (mock-first, docs/CONTRACT-ADDITIONS.md #23).
  const [enabling, setEnabling] = useState(false);
  const [demoCode, setDemoCode] = useState('');
  const [demoSheetVisible, setDemoSheetVisible] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [disableCode, setDisableCode] = useState('');
  const [disableError, setDisableError] = useState('');
  const [disabling, setDisabling] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const [sessionList, tfa] = await Promise.all([
        getAuthRepository().listSessions(),
        getAuthRepository().getTwoFactorStatus(),
      ]);
      setSessions(sessionList);
      setTwoFactor(tfa);
    } catch (e) {
      setSessions(null);
      setError(e instanceof ApiError && e.code === 'INTERNAL_ERROR' ? t('error.generic') : t('security.error'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const revoke = async (session: SessionInfo) => {
    setConfirmingId(null);
    setRevokingId(session.id);
    try {
      await getAuthRepository().revokeSession(session.id);
      setSessions((prev) => prev?.filter((s) => s.id !== session.id) ?? null);
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'INTERNAL_ERROR' ? t('error.generic') : t('security.revokeFailed'));
      load();
    } finally {
      setRevokingId(null);
    }
  };

  const enableTwoFactor = async () => {
    setEnabling(true);
    setError('');
    try {
      const user = useSessionStore.getState().user;
      const res = await getAuthRepository().enableTwoFactor(idempotencyKey(user?.id ?? 'customer', 'enable-2fa'));
      setTwoFactor({ enabled: true, method: 'otp' });
      // Mock-only extension (same pattern as the OTP debugCode): the demo
      // code is shown once after enabling so the flow is testable in dev.
      if (res.demoCode) setDemoCode(res.demoCode);
      setDemoSheetVisible(true);
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'INTERNAL_ERROR' ? t('error.generic') : e instanceof ApiError ? e.message : t('common.error'));
    } finally {
      setEnabling(false);
    }
  };

  const confirmDisable = async () => {
    setDisableError('');
    const code = disableCode.trim();
    if (!code) {
      setDisableError(t('security.enterCode'));
      return;
    }
    setDisabling(true);
    try {
      const user = useSessionStore.getState().user;
      await getAuthRepository().disableTwoFactor(code, idempotencyKey(user?.id ?? 'customer', 'disable-2fa'));
      setDisableOpen(false);
      setDisableCode('');
      setTwoFactor({ enabled: false, method: null });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'UNAUTHORIZED') setDisableError(t('security.invalidCode'));
      else if (e instanceof ApiError && e.code === 'INTERNAL_ERROR') setDisableError(t('error.generic'));
      else setDisableError(e instanceof ApiError ? e.message : t('common.error'));
    } finally {
      setDisabling(false);
    }
  };

  if (error && !sessions) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (sessions === null) {
    return (
      <Screen>
        <ActivityIndicator color={Colors.primary} style={{ marginTop: Spacing.xxl }} />
        <Text style={styles.loading}>{t('common.loading')}</Text>
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <Text style={styles.title}>{t('security.title')}</Text>

      {error ? <ErrorState message={error} onRetry={load} /> : null}

      <Card flat style={{ padding: 0, marginBottom: Spacing.lg }}>
        <ListRow
          title={t('security.changePassword')}
          icon="key-outline"
          onPress={() => router.push('/change-password')}
        />
      </Card>

      {twoFactor ? (
        <Card flat style={{ padding: Spacing.md, marginBottom: Spacing.lg }}>
          <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
            <Text style={styles.twoFactorTitle}>{t('security.twoFactor')}</Text>
            <Pill
              label={twoFactor.enabled ? t('security.twoFactorEnabled') : t('security.twoFactorDisabled')}
              tone={twoFactor.enabled ? 'success' : 'neutral'}
            />
          </Row>
          {twoFactor.enabled ? (
            <Btn label={t('security.disable2fa')} variant="outline" size="sm" onPress={() => setDisableOpen(true)} />
          ) : (
            <Btn label={t('security.enable2fa')} size="sm" onPress={enableTwoFactor} loading={enabling} icon="shield-checkmark-outline" />
          )}
        </Card>
      ) : null}

      {sessions.length === 0 ? (
        <EmptyState icon="phone-portrait-outline" title={t('security.empty')} />
      ) : (
        <Card flat style={{ padding: 0 }}>
          {sessions.map((session) => {
            const isCurrent = session.current === true;
            const confirming = confirmingId === session.id;
            const busy = revokingId === session.id;
            return (
              <View key={session.id}>
                <View style={styles.row}>
                  <View style={{ flex: 1, gap: 4 }}>
                    <Row gap={Spacing.sm}>
                      <Text style={styles.device} numberOfLines={1}>
                        {session.deviceInfo}
                      </Text>
                      {isCurrent ? (
                        <View style={styles.currentBadge}>
                          <Text style={styles.currentBadgeText}>{t('security.current')}</Text>
                        </View>
                      ) : null}
                    </Row>
                    <Text style={styles.lastActive}>{t('security.lastActive', { t: timeAgoISO(session.lastActiveAt) })}</Text>
                  </View>
                  {isCurrent ? null : confirming ? (
                    <Row gap={Spacing.sm}>
                      <Btn label={t('common.cancel')} variant="subtle" size="sm" disabled={busy} onPress={() => setConfirmingId(null)} />
                      <Btn label={t('security.confirmRevoke')} variant="danger" size="sm" loading={busy} onPress={() => revoke(session)} />
                    </Row>
                  ) : (
                    <Btn label={t('security.revoke')} variant="outline" size="sm" onPress={() => setConfirmingId(session.id)} />
                  )}
                </View>
              </View>
            );
          })}
        </Card>
      )}

      <Text style={styles.note}>{t('security.note')}</Text>

      <SheetModal visible={demoSheetVisible} onClose={() => setDemoSheetVisible(false)} title={t('security.twoFactor')}>
        <Text style={styles.demoLabel}>{t('security.demoCode', { code: demoCode })}</Text>
        <Text style={[styles.demoCode, { fontVariant: NumberStyle.fontVariant }]}>{demoCode}</Text>
        <Btn label={t('common.done')} onPress={() => setDemoSheetVisible(false)} />
      </SheetModal>

      <SheetModal
        visible={disableOpen}
        onClose={() => {
          setDisableOpen(false);
          setDisableError('');
          setDisableCode('');
        }}
        title={t('security.disable2fa')}>
        <Field
          label={t('security.enterCode')}
          value={disableCode}
          onChangeText={setDisableCode}
          keyboardType="number-pad"
          maxLength={6}
          placeholder="000000"
          autoCapitalize="none"
        />
        {disableError ? <Text style={styles.error}>{disableError}</Text> : null}
        <Btn label={t('security.disable2fa')} variant="danger" size="lg" onPress={confirmDisable} loading={disabling} />
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text, marginBottom: Spacing.md },
  loading: { textAlign: 'center', color: Colors.textFaint, fontSize: FontSize.sm, fontFamily: Fonts.sans, marginTop: Spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, padding: Spacing.md },
  device: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text, flexShrink: 1 },
  lastActive: { fontSize: FontSize.xs, color: Colors.textFaint, fontFamily: Fonts.sans },
  currentBadge: {
    backgroundColor: Colors.primarySoft,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
  },
  currentBadgeText: { color: Colors.primaryDeep, fontSize: FontSize.xs, fontFamily: Fonts.sansSemibold },
  twoFactorTitle: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text, flex: 1 },
  demoLabel: { textAlign: 'center', color: Colors.textSecondary, fontSize: FontSize.sm, fontFamily: Fonts.sans },
  demoCode: { textAlign: 'center', fontSize: 24, fontWeight: '900', color: Colors.text, letterSpacing: 6 },
  error: { color: Colors.danger, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, textAlign: 'center' },
  note: { textAlign: 'center', color: Colors.textFaint, fontSize: FontSize.xs, fontFamily: Fonts.sans, marginTop: Spacing.lg },
});
