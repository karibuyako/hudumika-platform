import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Field, Icon, Screen } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';
import { useLoyaltyStore } from '@/store/loyalty';

export default function MemberNewScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const registerMember = useLoyaltyStore((s) => s.registerMember);
  const error = useLoyaltyStore((s) => s.error);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [birthday, setBirthday] = useState('');
  const [busy, setBusy] = useState(false);

  const register = async () => {
    if (!name.trim() || !phone.trim()) return;
    setBusy(true);
    const member = await registerMember({
      name: name.trim(),
      phone: phone.trim(),
      birthday: birthday.trim() || undefined,
    });
    setBusy(false);
    if (member) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('loy.registerTitle')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <View style={{ gap: Spacing.md }}>
          <Field label={t('loy.name')} value={name} onChangeText={setName} maxLength={120} />
          <Field label={t('loy.phone')} value={phone} onChangeText={setPhone} placeholder="+2557…" keyboardType="phone-pad" maxLength={16} />
          <Field label={t('loy.birthday')} value={birthday} onChangeText={setBirthday} placeholder="YYYY-MM-DD" maxLength={10} />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Btn label={t('loy.add')} size="lg" loading={busy} disabled={!name.trim() || !phone.trim()} onPress={register} />
        </View>
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
  error: { color: Colors.danger, fontSize: FontSize.xs },
});