import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { ApiError } from '@/api/client';
import { Btn, Card, ConfirmDialog, Field, Icon, ListRow, Pill, Screen, Segmented, SheetModal } from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { getLocale, onLocaleChange, setLocale, t } from '@/i18n';
import type { Locale } from '@/i18n';
import { capitalize, mmss } from '@/lib/format';
import { getAuthRepository } from '@/repos';
import { useSessionStore } from '@/store/session';
import type { RoleSummary } from '@hudumika/contract';

/** This app runs under the provider role — the rest are switchable. */
const ACTIVE_ROLE = 'provider';

export default function SettingsScreen() {
  const locale = useSyncExternalStore(onLocaleChange, getLocale);
  const userPhone = useSessionStore((s) => s.userPhone);
  const requestOtp = useSessionStore((s) => s.requestOtp);
  const verifyOtp = useSessionStore((s) => s.verifyOtp);
  const refreshCapabilities = useSessionStore((s) => s.refreshCapabilities);

  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [rolesLoading, setRolesLoading] = useState(true);
  const [switchRole, setSwitchRole] = useState<RoleSummary | null>(null);
  const [phone, setPhone] = useState(userPhone);
  const [requestId, setRequestId] = useState('');
  const [debugCode, setDebugCode] = useState('');
  const [code, setCode] = useState('');
  const [otpError, setOtpError] = useState('');
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      getAuthRepository()
        .roles()
        .then((r) => {
          if (live) setRoles(r);
        })
        .catch(() => undefined)
        .finally(() => {
          if (live) setRolesLoading(false);
        });
      return () => {
        live = false;
      };
    }, []),
  );

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  const onLogout = async () => {
    setSigningOut(true);
    await useSessionStore.getState().logout();
    router.replace('/login');
  };

  const openSwitch = (role: RoleSummary) => {
    setSwitchRole(role);
    setPhone(userPhone);
    setRequestId('');
    setDebugCode('');
    setCode('');
    setOtpError('');
    setResendIn(0);
  };

  const sendCode = async () => {
    if (!switchRole) return;
    const destination = phone.trim();
    if (!/^\+255[67]\d{8}$/.test(destination)) {
      setOtpError(t('login.phone'));
      return;
    }
    setOtpError('');
    setRequestId('');
    setDebugCode('');
    setSending(true);
    try {
      const res = await requestOtp(destination, 'verify_role');
      setRequestId(res.requestId);
      setDebugCode(res.debugCode ?? '');
      setResendIn(Math.min(res.expiresInSeconds, 120));
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) {
        setResendIn(Math.max(1, Math.ceil(e.retryAfterSeconds ?? 60)));
      } else {
        setOtpError(e instanceof ApiError ? e.message : t('misc.error'));
      }
    } finally {
      setSending(false);
    }
  };

  const verify = async () => {
    if (!switchRole || !requestId) return;
    if (!/^\d{6}$/.test(code)) {
      setOtpError(t('login.code'));
      return;
    }
    setOtpError('');
    setVerifying(true);
    try {
      await verifyOtp(requestId, code, 'verify_role');
      await refreshCapabilities();
      setSwitchRole(null);
      router.replace('/home');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setOtpError(e.message);
      } else {
        setOtpError(e instanceof ApiError ? e.message : t('misc.error'));
      }
    } finally {
      setVerifying(false);
    }
  };

  const roleSub = (r: RoleSummary) => r.providerId ?? r.merchantId ?? r.riderId ?? undefined;

  return (
    <Screen scroll>
      <Text style={styles.label}>{t('settings.locale')}</Text>
      <Text style={styles.sub}>{t('settings.localeSub')}</Text>
      <Segmented
        options={[
          { key: 'en', label: 'English' },
          { key: 'sw', label: 'Kiswahili' },
        ]}
        value={locale}
        onChange={(l: Locale) => setLocale(l)}
      />

      <Card style={{ marginTop: Spacing.lg, gap: Spacing.xs }}>
        <Text style={styles.label}>{t('settings.session')}</Text>
        {rolesLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={Colors.primary} />
          </View>
        ) : (
          roles.map((r) => {
            const active = r.role === ACTIVE_ROLE;
            const sub = roleSub(r);
            return (
              <Pressable
                key={r.role}
                onPress={() => openSwitch(r)}
                disabled={active}
                accessibilityRole="button"
                accessibilityLabel={`${capitalize(r.role)}${active ? ` · ${t('settings.active')}` : ''}`}
                style={({ pressed }) => [styles.roleRow, active && styles.roleRowActive, pressed && { opacity: 0.7 }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.roleName, active && { color: Colors.textTertiary }]}>{capitalize(r.role)}</Text>
                  {sub ? <Text style={styles.sub}>{sub}</Text> : null}
                </View>
                {active ? <Pill label={t('settings.active')} tone="success" /> : <Icon name="chevron-forward" size={15} color={Colors.textFaint} />}
              </Pressable>
            );
          })
        )}
      </Card>

      <View style={{ marginTop: Spacing.lg }}>
        <Card flat style={{ paddingHorizontal: Spacing.lg }}>
          <ListRow
            title={t('settings.notifications')}
            icon="notifications-outline"
            onPress={() => router.push('/profile/preferences' as never)}
          />
        </Card>
      </View>

      <Card style={{ marginTop: Spacing.lg, gap: Spacing.xs }}>
        <Text style={styles.label}>{t('settings.about')}</Text>
        <Text style={styles.sub}>Hudumika Provider</Text>
        <Text style={styles.sub}>
          {t('settings.version')} 0.1.0
        </Text>
      </Card>

      <View style={{ marginTop: Spacing.lg }}>
        <ListRow
          title={t('settings.logout')}
          icon="log-out-outline"
          danger
          onPress={() => setConfirmingLogout(true)}
        />
      </View>

      <ConfirmDialog
        visible={confirmingLogout}
        title={t('settings.logout')}
        sub={t('profile.logoutConfirm')}
        confirmLabel={t('settings.logout')}
        cancelLabel={t('misc.cancel')}
        onConfirm={onLogout}
        onCancel={() => setConfirmingLogout(false)}
        loading={signingOut}
        danger
      />

      <SheetModal visible={switchRole !== null} onClose={() => setSwitchRole(null)} title={t('settings.switchRole')}>
        <View style={styles.roleBox}>
          <Text style={styles.roleLabel}>{t('login.roleNotice')}</Text>
          <Text style={styles.roleSub}>{t('login.roleSub')}</Text>
        </View>
        <Text style={styles.sub}>{t('settings.switchRoleSub')}</Text>
        <Field label={t('login.phone')} value={phone} onChangeText={setPhone} placeholder="+255700000000" keyboardType="phone-pad" maxLength={13} />
        <Btn label={resendIn > 0 ? mmss(resendIn) : sending ? t('misc.loading') : t('login.sendCode')} variant="ghost" size="sm" disabled={sending || resendIn > 0} onPress={sendCode} />
        {debugCode && process.env.EXPO_PUBLIC_ENV !== 'production' ? (
          <View style={styles.demoBox}>
            <Text style={styles.demoLabel}>DEMO MODE — your verification code is</Text>
            <Text style={styles.demoCode}>{debugCode}</Text>
          </View>
        ) : null}
        <View style={{ gap: Spacing.xs }}>
          <Text style={styles.fieldLabel}>{t('login.code')}</Text>
          <View style={{ flexDirection: 'row', gap: Spacing.sm }}>
            <TextInput
              value={code}
              onChangeText={setCode}
              placeholder="6-digit code"
              placeholderTextColor={Colors.textTertiary}
              keyboardType="number-pad"
              maxLength={6}
              style={[styles.input, { flex: 1 }]}
            />
          </View>
        </View>
        {otpError ? <Text style={styles.error}>{otpError}</Text> : null}
        <Btn label={verifying ? t('misc.loading') : t('settings.switchRole')} onPress={verify} loading={verifying} disabled={!requestId} size="lg" />
        <Btn label={t('misc.cancel')} variant="ghost" onPress={() => setSwitchRole(null)} disabled={verifying} />
      </SheetModal>

      {signingOut ? (
        <View style={styles.signingOut}>
          <ActivityIndicator color={Colors.primary} />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: 'PlusJakartaSans_600SemiBold' },
  sub: { fontSize: FontSize.sm, color: Colors.textTertiary, marginTop: 2 },
  center: { alignItems: 'center', paddingVertical: Spacing.lg },
  roleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  roleRowActive: { opacity: 0.75 },
  roleName: { fontSize: FontSize.md, color: Colors.text, fontWeight: '700' },
  roleBox: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    padding: Spacing.md,
    gap: 2,
  },
  roleLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '700' },
  roleSub: { fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 16 },
  fieldLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    fontSize: FontSize.md,
    color: Colors.text,
    backgroundColor: Colors.card,
    fontFamily: Fonts.sans,
  },
  error: { color: Colors.danger, fontSize: FontSize.sm, fontWeight: '600' },
  demoBox: {
    backgroundColor: Colors.primarySoft,
    borderRadius: Radius.md,
    padding: Spacing.md,
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: Colors.primary,
  },
  demoLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '700' },
  demoCode: { fontSize: 24, fontWeight: '800', color: Colors.text, letterSpacing: 6 },
  signingOut: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: Colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
