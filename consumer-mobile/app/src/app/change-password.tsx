import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { Btn, Card, Screen } from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { ApiError } from '@/api/client';
import { getAuthRepository } from '@/repos';
import { useSessionStore } from '@/store/session';
import { toast } from '@/store/ui';
import { idempotencyKey } from '@/lib/idempotency';

/** Contract ChangePasswordBody.newPassword — minLength 8 / maxLength 128. */
const MIN_PASSWORD_LENGTH = 8;

export default function ChangePasswordScreen() {
  const router = useRouter();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setError('');
    if (next.length < MIN_PASSWORD_LENGTH) {
      setError(t('changePassword.minLength'));
      return;
    }
    if (next !== confirm) {
      setError(t('changePassword.mismatch'));
      return;
    }
    setSubmitting(true);
    const user = useSessionStore.getState().user;
    try {
      await getAuthRepository().changePassword(current, next, idempotencyKey(user?.id ?? 'customer', 'change-password'));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      toast(t('changePassword.success'));
      router.back();
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'VALIDATION_FAILED') setError(t('changePassword.minLength'));
        else if (e.code === 'UNAUTHORIZED') setError(t('changePassword.wrongCurrent'));
        else if (e.code === 'INTERNAL_ERROR') setError(t('error.generic'));
        else setError(t('changePassword.failed'));
      } else {
        setError(t('changePassword.failed'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen scroll>
      <Text style={styles.title}>{t('changePassword.title')}</Text>

      <Card style={{ gap: Spacing.md }}>
        <View>
          <Text style={styles.label}>{t('changePassword.current')}</Text>
          <TextInput
            value={current}
            onChangeText={setCurrent}
            secureTextEntry
            autoCapitalize="none"
            placeholder={t('changePassword.currentPlaceholder')}
            placeholderTextColor={Colors.textFaint}
            style={styles.input}
            accessibilityLabel={t('changePassword.current')}
          />
        </View>
        <View>
          <Text style={styles.label}>{t('changePassword.new')}</Text>
          <TextInput
            value={next}
            onChangeText={setNext}
            secureTextEntry
            autoCapitalize="none"
            placeholder={t('changePassword.newPlaceholder')}
            placeholderTextColor={Colors.textFaint}
            style={styles.input}
            accessibilityLabel={t('changePassword.new')}
          />
        </View>
        <View>
          <Text style={styles.label}>{t('changePassword.confirm')}</Text>
          <TextInput
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry
            autoCapitalize="none"
            placeholder={t('changePassword.confirmPlaceholder')}
            placeholderTextColor={Colors.textFaint}
            style={styles.input}
            accessibilityLabel={t('changePassword.confirm')}
          />
        </View>
      </Card>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Btn label={t('changePassword.save')} onPress={submit} loading={submitting} size="lg" style={{ marginTop: Spacing.lg }} />
      <Text style={styles.note}>{t('security.note')}</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text, marginBottom: Spacing.md },
  label: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sansSemibold, marginBottom: Spacing.xs },
  input: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    fontSize: FontSize.md,
    color: Colors.text,
    fontFamily: Fonts.sans,
    backgroundColor: Colors.card,
  },
  error: { color: Colors.danger, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, marginTop: Spacing.md, textAlign: 'center' },
  note: { textAlign: 'center', color: Colors.textFaint, fontSize: FontSize.xs, fontFamily: Fonts.sans, marginTop: Spacing.lg },
});
