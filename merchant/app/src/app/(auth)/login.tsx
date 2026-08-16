import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Btn, Field, Icon, Screen, Segmented } from '@/components/ui';
import { Colors, fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { ApiError } from '@/api/client';
import { t, onLocaleChange } from '@/i18n';
import { useSessionStore } from '@/store/session';

export default function LoginScreen() {
  const requestOtp = useSessionStore((s) => s.requestOtp);
  const verifyOtp = useSessionStore((s) => s.verifyOtp);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [requestId, setRequestId] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'otp' | 'password'>('otp');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [sent, setSent] = useState(false);
  const [debugCode, setDebugCode] = useState('');
  const [countdown, setCountdown] = useState(0);
  useSyncExternalStore(onLocaleChange, () => 0);

  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  const validPhone = /^\+255[67]\d{8}$/.test(phone);

  const sendCode = async () => {
    if (!validPhone) {
      setError(t('login.errPhone'));
      return;
    }
    setError('');
    setSending(true);
    try {
      const res = await requestOtp(phone, 'login');
      setRequestId(res.requestId);
      setDebugCode(res.debugCode);
      setCountdown(res.resendAfterSec);
      setSent(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('login.couldNotSend'));
    } finally {
      setSending(false);
    }
  };

  const submit = async () => {
    if (mode === 'password') {
      setError(t('login.errPassword'));
      return;
    }
    if (!validPhone) {
      setError(t('login.errPhone'));
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      setError(t('login.errOtp'));
      return;
    }
    setError('');
    setVerifying(true);
    try {
      await verifyOtp(requestId, code, 'login');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace('/dashboard');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('login.signinFailed'));
    } finally {
      setVerifying(false);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.hero}>
          <View style={styles.logo}>
            <Icon name="flame" size={40} color={Colors.primary} />
          </View>
          <Text style={styles.title}>Merchant Pro</Text>
          <Text style={styles.sub}>{t('login.sub')}</Text>
        </View>

        <View style={styles.form}>
          <Segmented
            options={[
              { key: 'otp', label: t('login.otp') },
              { key: 'password', label: t('login.password') },
            ]}
            value={mode}
            onChange={setMode}
          />

          <View style={{ gap: Spacing.md }}>
            <Field label={t('login.phone')} value={phone} onChangeText={setPhone} placeholder="+255700000000" keyboardType="phone-pad" maxLength={13} />
            {mode === 'otp' ? (
              <View style={{ gap: Spacing.xs }}>
                <Text style={styles.fieldLabel}>{t('login.code')}</Text>
                <View style={{ flexDirection: 'row', gap: Spacing.sm }}>
                  <TextInput
                    value={code}
                    onChangeText={setCode}
                    placeholder={t('login.otpPh')}
                    placeholderTextColor={Colors.textTertiary}
                    keyboardType="number-pad"
                    maxLength={6}
                    style={[styles.input, { flex: 1 }]}
                  />
                  <Btn
                    label={countdown > 0 ? `${countdown}s` : sent && !debugCode ? t('login.sent') : sending ? t('login.sending') : t('login.getCode')}
                    variant="ghost"
                    size="sm"
                    disabled={sending || countdown > 0}
                    onPress={sendCode}
                    style={{ paddingHorizontal: Spacing.lg }}
                  />
                </View>
              </View>
            ) : (
              <Field label={t('login.password')} value={password} onChangeText={setPassword} placeholder={t('login.passwordPh')} maxLength={20} />
            )}

            {debugCode ? (
              <View style={styles.demoBox}>
                <Text style={styles.demoLabel}>{t('login.demoMode')}</Text>
                <Text style={styles.demoCode}>{debugCode}</Text>
              </View>
            ) : null}

            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Btn label={verifying ? t('login.signingIn') : t('login.signin')} onPress={submit} size="lg" loading={verifying} />
          </View>

          <View style={styles.footer}>
            <Pressable onPress={() => router.push('/register')}>
              <Text style={styles.linkDark}>{t('login.register')}</Text>
            </Pressable>
          </View>
          <Text style={styles.tip}>{t('login.tip')}</Text>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: {
    alignItems: 'center',
    paddingTop: 70,
    gap: Spacing.sm,
  },
  logo: {
    width: 64,
    height: 64,
    borderRadius: 20,
    backgroundColor: Colors.black,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  title: { fontSize: FontSize.xxl, fontFamily: fonts.display700, color: Colors.text },
  sub: { fontSize: FontSize.sm, color: Colors.textSecondary },
  form: {
    flex: 1,
    padding: Spacing.xl,
    marginTop: Spacing.xxl,
    gap: Spacing.xl,
  },
  fieldLabel: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontWeight: '500',
  },
  input: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Platform.OS === 'ios' ? 12 : 8,
    fontSize: FontSize.md,
    color: Colors.text,
    backgroundColor: Colors.card,
  },
  error: { color: Colors.danger, fontSize: FontSize.sm },
  demoBox: {
    backgroundColor: Colors.primarySoft,
    borderRadius: Radius.md,
    padding: Spacing.md,
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: Colors.primary,
  },
  demoLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontFamily: fonts.body600 },
  demoCode: { fontSize: 24, fontFamily: fonts.display700, color: Colors.text, letterSpacing: 6 },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: Spacing.sm,
  },
  link: { color: Colors.textTertiary, fontSize: FontSize.sm },
  linkDark: { color: Colors.text, fontSize: FontSize.sm, fontWeight: '600' },
  tip: {
    color: Colors.textTertiary,
    fontSize: FontSize.xs,
    textAlign: 'center',
    marginTop: 'auto',
  },
});
