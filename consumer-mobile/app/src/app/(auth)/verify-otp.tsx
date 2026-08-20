import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Btn, Icon, Screen } from '@/components/ui';
import { Colors, Fonts, FontSize, NumberStyle, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { ApiError } from '@/api/client';
import { useSessionStore } from '@/store/session';
import type { OtpPurpose } from '@/repos';

const CODE_RE = /^\d{4,8}$/;

export default function VerifyOtpScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    requestId: string;
    debugCode?: string;
    destination?: string;
    purpose?: string;
    resendInSeconds?: string;
  }>();
  const [requestId, setRequestId] = useState(params.requestId);
  const [demoCode, setDemoCode] = useState(params.debugCode);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [focused, setFocused] = useState(false);
  const [countdown, setCountdown] = useState(() => {
    const n = Number(params.resendInSeconds);
    return Number.isFinite(n) && n > 0 ? n : 60;
  });

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  const submit = async () => {
    if (!CODE_RE.test(code.trim())) {
      setError(t('login.wrongCode'));
      return;
    }
    setError('');
    setVerifying(true);
    try {
      await useSessionStore.getState().verifyOtp(requestId, code.trim());
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const target = useSessionStore.getState().status === 'authed' ? '/home' : '/onboarding';
      router.replace(target);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'OTP_MAX_ATTEMPTS') setError(t('login.maxAttempts'));
        else if (e.code === 'OTP_INVALID') setError(t('login.wrongCode'));
        else if (e.code === 'OTP_EXPIRED') setError(t('login.expired'));
        else if (e.code === 'INTERNAL_ERROR') setError(t('error.generic'));
        else setError(e.message);
      } else {
        setError(t('common.error'));
      }
    } finally {
      setVerifying(false);
    }
  };

  const resend = async () => {
    if (!params.destination) return;
    setError('');
    setResending(true);
    try {
      const res = await useSessionStore
        .getState()
        .requestOtp(params.destination, (params.purpose as OtpPurpose | undefined) ?? 'login');
      // The server issued a NEW requestId — verify against that one from now on.
      setRequestId(res.requestId);
      setCountdown(res.resendInSeconds ?? 60);
      if (res.debugCode) setDemoCode(res.debugCode);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'RATE_LIMITED' || e.status === 429) {
          const s = typeof e.details?.retryAfterSeconds === 'number' ? e.details.retryAfterSeconds : 60;
          setCountdown(s);
          setError(t('login.rateLimited', { s }));
        } else if (e.code === 'INTERNAL_ERROR') {
          setError(t('error.generic'));
        } else {
          setError(e.message);
        }
      } else {
        setError(t('common.error'));
      }
    } finally {
      setResending(false);
    }
  };

  return (
    <Screen scroll contentStyle={{ justifyContent: 'center', flexGrow: 1 }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={12}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('common.back')} style={styles.backBtn}>
          <Icon name="chevron-back" size={22} color={Colors.textSecondary} />
          <Text style={styles.backText}>{t('common.back')}</Text>
        </Pressable>
        <Text style={styles.title}>{t('login.code')}</Text>
        <Text style={styles.sub}>{t('login.tip')}</Text>

        <View style={styles.codeRow}>
          <TextInput
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            maxLength={8}
            placeholder="000000"
            placeholderTextColor={Colors.textFaint}
            accessibilityLabel={t('login.code')}
            autoComplete="sms-otp"
            textContentType="oneTimeCode"
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="done"
            onSubmitEditing={submit}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            style={[styles.codeInput, focused && styles.codeInputFocused, { fontVariant: NumberStyle.fontVariant }]}
          />
          <Btn
            label={countdown > 0 ? t('login.resend', { s: countdown }) : t('login.sendCode')}
            onPress={resend}
            variant="ghost"
            disabled={countdown > 0 || resending}
            style={{ minHeight: 44, justifyContent: 'center' }}
          />
        </View>

        {demoCode ? (
          <View style={styles.demoBox} accessible accessibilityLabel={`${t('login.demoCode')} ${demoCode}`}>
            <Text style={styles.demoLabel}>{t('login.demoCode')}</Text>
            <Text style={[styles.demoCode, { fontVariant: NumberStyle.fontVariant }]}>{demoCode}</Text>
          </View>
        ) : null}

        {error ? <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</Text> : null}

        <Btn label={t('login.signin')} onPress={submit} size="lg" loading={verifying} style={{ marginTop: Spacing.lg, minHeight: 44 }} />
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', minHeight: 44, paddingVertical: 10, paddingRight: 12, marginBottom: Spacing.md },
  backText: { color: Colors.textSecondary, fontSize: FontSize.sm, fontFamily: Fonts.sansMedium },
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text },
  sub: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: Spacing.xs, marginBottom: Spacing.xl },
  codeRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, minHeight: 44 },
  codeInput: {
    flex: 1,
    minHeight: 44,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Platform.select({ ios: 12, default: 10 }) ?? 10,
    fontSize: FontSize.xl,
    color: Colors.text,
    fontFamily: Fonts.sans,
    backgroundColor: Colors.card,
    letterSpacing: 6,
    textAlign: 'center',
  },
  codeInputFocused: { borderColor: Colors.primary, borderWidth: 1.5 },
  demoBox: {
    backgroundColor: Colors.primarySoft,
    borderRadius: Radius.md,
    padding: Spacing.md,
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: Colors.primary,
    marginTop: Spacing.lg,
  },
  demoLabel: { color: Colors.primaryDeep, fontSize: FontSize.xs, fontFamily: Fonts.sansSemibold },
  demoCode: { fontSize: 24, fontFamily: Fonts.sansExtraBold, color: Colors.text, letterSpacing: 6 },
  error: { color: Colors.danger, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, marginTop: Spacing.md, backgroundColor: Colors.dangerSoft, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, borderRadius: Radius.md, overflow: 'hidden' },
});
