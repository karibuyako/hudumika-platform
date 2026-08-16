import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { Btn, Field, Icon, Row, Screen, Segmented, SheetModal } from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { getLocale, t } from '@/i18n';
import { ApiError, setToken } from '@/api/client';
import { idempotencyKey } from '@/lib/idempotency';
import { setStoredSession } from '@/lib/secureStorage';
import { useSessionStore } from '@/store/session';
import { getAuthRepository, type OtpPurpose, type SocialProvider } from '@/repos';

const PHONE_RE = /^\+255[67]\d{8}$/;

type LoginMode = 'login' | 'signup';

export default function LoginScreen() {
  const router = useRouter();
  const [mode, setMode] = useState<LoginMode>('login');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [socialProvider, setSocialProvider] = useState<SocialProvider | null>(null);
  const [socialLoading, setSocialLoading] = useState(false);
  const [socialError, setSocialError] = useState('');

  const purpose: OtpPurpose = mode === 'signup' ? 'signup' : 'login';

  const sendCode = async (forPurpose: OtpPurpose = purpose) => {
    if (!PHONE_RE.test(phone.trim())) {
      setError(t('login.invalidPhone'));
      return;
    }
    setError('');
    setSending(true);
    try {
      const res = await useSessionStore.getState().requestOtp(phone.trim(), forPurpose);
      router.push({
        pathname: '/verify-otp',
        params: {
          requestId: res.requestId,
          debugCode: res.debugCode ?? '',
          destination: phone.trim(),
          purpose: forPurpose,
          resendInSeconds: String(res.resendInSeconds ?? 60),
        },
      });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'INTERNAL_ERROR') {
        setError(t('error.generic'));
      } else {
        setError(e instanceof ApiError ? e.message : t('common.error'));
      }
    } finally {
      setSending(false);
    }
  };

  const openSocial = (provider: SocialProvider) => {
    setSocialProvider(provider);
    setSocialError('');
  };

  const closeSocial = () => {
    if (socialLoading) return;
    setSocialProvider(null);
    setSocialError('');
  };

  const confirmSocial = async () => {
    if (!socialProvider || socialLoading) return;
    setSocialError('');
    setSocialLoading(true);
    try {
      // Simulated OAuth exchange (mock-first, CONTRACT-ADDITIONS.md #19): the
      // demo needs no real provider code — the mock signs in the demo user.
      const res = await getAuthRepository().socialLogin(
        { provider: socialProvider },
        idempotencyKey('customer', 'social'),
      );
      // Apply the session exactly like the OTP path (store/session.ts
      // verifyOtp): setToken + set the user + status onboarding (city
      // picker) + persist the pair.
      setToken(res.accessToken);
      useSessionStore.setState({ token: res.accessToken, user: res.user, status: 'onboarding' });
      await setStoredSession({
        accessToken: res.accessToken,
        refreshToken: res.refreshToken ?? '',
        userId: res.user.id,
        phone: res.user.phone,
        locale: getLocale(),
        savedAt: new Date().toISOString(),
      });
      setSocialProvider(null);
      router.replace('/onboarding');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'INTERNAL_ERROR') {
        setSocialError(t('error.generic'));
      } else if (e instanceof ApiError) {
        setSocialError(e.message);
      } else {
        setSocialError(t('auth.socialError'));
      }
    } finally {
      setSocialLoading(false);
    }
  };

  return (
    <Screen scroll contentStyle={{ justifyContent: 'center', flexGrow: 1 }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.hero}>
          <View style={styles.logoBox}>
            <Icon name="leaf" size={34} color={Colors.white} />
          </View>
          <Text style={styles.title}>{t('login.title')}</Text>
          <Text style={styles.sub}>{t('login.sub')}</Text>
        </View>
        <View style={{ gap: Spacing.lg }}>
          <Segmented
            options={[
              { key: 'login', label: t('login.signinTab') },
              { key: 'signup', label: t('login.signupTab') },
            ]}
            value={mode}
            onChange={setMode}
          />
          <Field
            label={t('login.phone')}
            value={phone}
            onChangeText={setPhone}
            placeholder="+255700000000"
            keyboardType="phone-pad"
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Btn label={t('login.sendCode')} onPress={() => sendCode()} size="lg" loading={sending} />
          {mode === 'login' ? (
            <Pressable
              onPress={() => sendCode('password_reset').catch(() => undefined)}
              accessibilityRole="button"
              accessibilityLabel={t('login.forgot')}
              hitSlop={8}
              style={styles.forgotWrap}>
              <Text style={styles.forgot}>{t('login.forgot')}</Text>
            </Pressable>
          ) : null}
          <Text style={styles.tip}>{t('login.tip')}</Text>
          <View style={styles.orDivider}>
            <View style={styles.orLine} />
            <Text style={styles.orLabel}>{t('auth.orContinue')}</Text>
            <View style={styles.orLine} />
          </View>
          <Row style={{ gap: Spacing.md }}>
            <Btn
              label={t('auth.socialGoogle')}
              icon="logo-google"
              variant="outline"
              size="lg"
              style={{ flex: 1 }}
              onPress={() => openSocial('google')}
            />
            <Btn
              label={t('auth.socialApple')}
              icon="logo-apple"
              variant="outline"
              size="lg"
              style={{ flex: 1 }}
              onPress={() => openSocial('apple')}
            />
          </Row>
        </View>
      </KeyboardAvoidingView>
      <SheetModal
        visible={socialProvider !== null}
        onClose={closeSocial}
        title={socialProvider ? t(socialProvider === 'google' ? 'auth.socialGoogle' : 'auth.socialApple') : undefined}>
        <Text style={styles.socialExplain}>
          {t('auth.socialExplain', { provider: socialProvider === 'google' ? 'Google' : 'Apple' })}
        </Text>
        {socialError ? <Text style={styles.socialErrorText}>{socialError}</Text> : null}
        <Btn
          label={t('common.continue')}
          onPress={confirmSocial}
          size="lg"
          loading={socialLoading}
        />
        <Btn label={t('common.cancel')} onPress={closeSocial} variant="ghost" size="lg" disabled={socialLoading} />
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: Spacing.sm, marginBottom: Spacing.xxl },
  logoBox: {
    width: 64,
    height: 64,
    borderRadius: Radius.lg,
    backgroundColor: Colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text },
  sub: { fontSize: FontSize.md, color: Colors.textTertiary, fontFamily: Fonts.sans },
  error: { color: Colors.danger, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold },
  forgotWrap: { alignItems: 'center', paddingVertical: 2 },
  forgot: {
    color: Colors.primaryDeep,
    fontSize: FontSize.sm,
    fontFamily: Fonts.sansSemibold,
    textDecorationLine: 'underline',
  },
  tip: { color: Colors.textFaint, fontSize: FontSize.xs, fontFamily: Fonts.sans, textAlign: 'center' },
  orDivider: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginTop: Spacing.xs },
  orLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: Colors.border },
  orLabel: {
    color: Colors.textFaint,
    fontSize: FontSize.xs,
    fontFamily: Fonts.sansSemibold,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  socialExplain: {
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    fontFamily: Fonts.sans,
    lineHeight: 20,
    textAlign: 'center',
  },
  socialErrorText: { color: Colors.danger, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, textAlign: 'center' },
});
