import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';

import { ApiError } from '@/api/client';
import { Btn, Field, Icon, Screen } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { mmss } from '@/lib/format';
import { useSessionStore } from '@/store/session';

export default function LoginScreen() {
  const requestOtp = useSessionStore((s) => s.requestOtp);
  const verifyOtp = useSessionStore((s) => s.verifyOtp);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [requestId, setRequestId] = useState('');
  const [debugCode, setDebugCode] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  const validPhone = /^\+255[67]\d{8}$/.test(phone);

  const sendCode = async () => {
    if (!validPhone) {
      setError(t('login.invalidPhone'));
      return;
    }
    setError('');
    setSending(true);
    try {
      const res = await requestOtp(phone);
      setRequestId(res.requestId);
      setDebugCode(res.debugCode ?? '');
      setResendIn(Math.min(res.resendAfterSeconds ?? 60, 120));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) {
        const retry = e.details?.retryAfterSeconds;
        setResendIn(typeof retry === 'number' ? Math.ceil(retry) : 60);
      } else {
        setError(e instanceof ApiError ? e.message : t('login.sendFailed'));
      }
    } finally {
      setSending(false);
    }
  };

  const submit = async () => {
    if (!validPhone) {
      setError(t('login.invalidPhone'));
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      setError(t('login.invalidCode'));
      return;
    }
    if (!requestId) return;
    setError('');
    setVerifying(true);
    try {
      await verifyOtp(requestId, code);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const target = useSessionStore.getState().status === 'authed' ? '/home' : '/onboarding';
      router.replace(target as never);
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
            <Icon name="leaf" size={40} color={Colors.primary} />
          </View>
          <Text style={styles.title}>{t('login.title')}</Text>
          <Text style={styles.sub}>{t('login.sub')}</Text>
        </View>

        <View style={styles.form}>
          <View style={{ gap: Spacing.md }}>
            <Field label={t('login.phone')} value={phone} onChangeText={setPhone} placeholder={t('login.phonePlaceholder')} keyboardType="phone-pad" maxLength={13} />
            <View style={{ gap: Spacing.xs }}>
              <Text style={styles.fieldLabel}>{t('login.code')}</Text>
              <View style={{ flexDirection: 'row', gap: Spacing.sm }}>
                <TextInput
                  value={code}
                  onChangeText={setCode}
                  placeholder={t('login.codePlaceholder')}
                  placeholderTextColor={Colors.textTertiary}
                  keyboardType="number-pad"
                  maxLength={6}
                  accessibilityLabel={t('login.code')}
                  style={[styles.input, { flex: 1 }]}
                />
                <Btn
                  label={resendIn > 0 ? mmss(resendIn) : sending ? t('login.sending') : t('login.sendCode')}
                  variant="ghost"
                  size="sm"
                  disabled={sending || resendIn > 0}
                  onPress={sendCode}
                  style={{ paddingHorizontal: Spacing.lg }}
                />
              </View>
            </View>

            {debugCode ? (
              <View style={styles.demoBox}>
                <Text style={styles.demoLabel}>{t('login.demoMode')}</Text>
                <Text style={styles.demoCode}>{debugCode}</Text>
              </View>
            ) : null}

            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Btn label={verifying ? t('login.signingIn') : t('login.signin')} onPress={submit} size="lg" loading={verifying} />
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
  title: { fontSize: FontSize.xxl, fontWeight: '800', color: Colors.text },
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
    borderColor: Colors.borderStrong,
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
  demoLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '600' },
  demoCode: { fontSize: 24, fontWeight: '900', color: Colors.text, letterSpacing: 6 },
  tip: {
    color: Colors.textTertiary,
    fontSize: FontSize.xs,
    textAlign: 'center',
    marginTop: 'auto',
  },
});