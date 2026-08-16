import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Btn, Field, Icon, Segmented } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import type { I18nKey } from '@/i18n';
import type { ProofOfServiceType } from '@hudumika/contract';

const OPTIONS: { key: ProofOfServiceType; icon: 'camera' | 'create' | 'document-text'; labelKey: I18nKey }[] = [
  { key: 'photo', icon: 'camera', labelKey: 'proof.type.photo' },
  { key: 'signature', icon: 'create', labelKey: 'proof.type.signature' },
  { key: 'notes', icon: 'document-text', labelKey: 'proof.type.notes' },
];

/** Proof-of-service capture (simulated camera/signature in mocks, notes always). */
export function ProofUpload({ onSubmit, loading, onCancel, submitted }: {
  onSubmit: (type: ProofOfServiceType, value: string) => void;
  loading?: boolean;
  onCancel?: () => void;
  submitted?: boolean;
}) {
  const [type, setType] = useState<ProofOfServiceType | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  const pick = (t: ProofOfServiceType) => {
    setType(t);
    setValue('');
    setError('');
  };

  const submit = () => {
    if (!type) return;
    if (!value.trim()) {
      setError('Capture or enter the proof value first');
      return;
    }
    setError('');
    onSubmit(type, value.trim());
  };

  if (submitted) {
    return (
      <View style={styles.doneBox}>
        <Icon name="checkmark-circle" size={22} color={Colors.success} />
        <Text style={styles.doneText}>{t('proof.submitted')}</Text>
      </View>
    );
  }

  return (
    <View style={{ gap: Spacing.md }}>
      <Segmented
        options={OPTIONS.map((o) => ({ key: o.key, label: t(o.labelKey) }))}
        value={type ?? 'photo'}
        onChange={(k) => pick(k)}
        equal
      />

      {type === 'photo' || type === 'signature' ? (
        <Pressable
          onPress={() => setValue(value ? '' : type === 'photo' ? 'photo://simulated' : 'signature://simulated')}
          accessibilityRole="button"
          accessibilityLabel={t(type === 'photo' ? 'proof.capture' : 'proof.sign')}
          style={({ pressed }) => [styles.simTile, value && styles.simDone, pressed && { opacity: 0.7 }]}>
          {value ? (
            <>
              <Icon name="checkmark-circle" size={26} color={Colors.success} />
              <Text style={styles.simText}>{t(type === 'photo' ? 'proof.captured' : 'proof.signed')}</Text>
            </>
          ) : (
            <>
              <Icon name={type === 'photo' ? 'camera' : 'create'} size={26} color={Colors.textTertiary} />
              <Text style={styles.simText}>{t(type === 'photo' ? 'proof.capture' : 'proof.sign')}</Text>
            </>
          )}
        </Pressable>
      ) : (
        <Field
          label={t('proof.type.notes')}
          value={value}
          onChangeText={setValue}
          multiline
          placeholder={t('proof.notesPlaceholder')}
          maxLength={2000}
        />
      )}

      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Btn label={t('proof.submit')} onPress={submit} loading={loading} disabled={!type} size="lg" icon="checkmark-circle" />
      {onCancel ? <Btn label={t('misc.cancel')} variant="ghost" onPress={onCancel} disabled={loading} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  simTile: {
    height: 120,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  simDone: { borderColor: Colors.success, borderStyle: 'solid', backgroundColor: Colors.successSoft },
  simText: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: 'PlusJakartaSans_600SemiBold' },
  doneBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.successSoft,
    borderRadius: Radius.sm,
    padding: Spacing.md,
  },
  doneText: { color: Colors.success, fontSize: FontSize.sm, fontFamily: 'PlusJakartaSans_700Bold' },
  error: { color: Colors.danger, fontSize: FontSize.sm },
});

