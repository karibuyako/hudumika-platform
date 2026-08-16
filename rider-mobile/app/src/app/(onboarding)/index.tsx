import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { Btn, Field, Icon, Screen, Segmented } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { getRiderRepository } from '@/repos';
import { useSessionStore } from '@/store/session';
import type { RiderUpdateTransportMode, RiderUpdateVehicle } from '@hudumika/contract';

const VEHICLES = [
  { key: 'motorcycle', label: t('vehicles.motorcycle') },
  { key: 'car', label: t('vehicles.car') },
  { key: 'van', label: t('vehicles.van') },
] as const;

type VehicleKey = (typeof VEHICLES)[number]['key'];

const VEHICLE_PROFILE: Record<VehicleKey, { vehicle: RiderUpdateVehicle; transportMode: RiderUpdateTransportMode }> = {
  motorcycle: { vehicle: 'motorcycle', transportMode: 'local_motorcycle' },
  car: { vehicle: 'car', transportMode: 'local_car' },
  van: { vehicle: 'car', transportMode: 'van' },
};

function verificationMeta(verification: string): { tone: 'success' | 'warning' | 'danger'; label: string } | null {
  if (verification === 'approved') return { tone: 'success', label: t('onboard.verificationApproved') };
  if (verification === 'rejected' || verification === 'suspended' || verification === 'changes_requested') {
    return { tone: 'danger', label: t('onboard.verificationRejected') };
  }
  return { tone: 'warning', label: t('onboard.verificationPending') };
}

export default function OnboardingScreen() {
  const [name, setName] = useState('');
  const [vehicle, setVehicle] = useState<VehicleKey>('motorcycle');
  const [licensePlate, setLicensePlate] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [verification, setVerification] = useState<string | null>(null);

  useEffect(() => {
    getRiderRepository()
      .getProfile()
      .then((p) => setVerification(p.verification))
      .catch(() => setVerification(null));
  }, []);

  const save = async () => {
    if (!name.trim()) {
      setError(t('onboard.nameRequired'));
      return;
    }
    setError('');
    setSaving(true);
    try {
      const profile = VEHICLE_PROFILE[vehicle];
      const updated = await getRiderRepository().updateProfile({
        vehicle: profile.vehicle,
        transportMode: profile.transportMode,
        licensePlate: licensePlate.trim() || undefined,
      });
      // RiderUpdate has no name field — apply it to the local session profile.
      useSessionStore.getState().completeOnboarding({ ...updated, name: name.trim() });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace('/home');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('onboard.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const meta = verification ? verificationMeta(verification) : null;

  return (
    <Screen scroll contentStyle={{ justifyContent: 'center' }}>
      <Text style={styles.title}>{t('onboard.title')}</Text>
      <Text style={styles.sub}>{t('onboard.sub')}</Text>

      {meta ? (
        <View style={[styles.verificationBox, meta.tone === 'success' && styles.verificationBoxSuccess, meta.tone === 'danger' && styles.verificationBoxDanger]}>
          <Icon
            name={meta.tone === 'success' ? 'checkmark-circle' : meta.tone === 'danger' ? 'alert-circle' : 'hourglass-outline'}
            size={16}
            color={meta.tone === 'success' ? Colors.success : meta.tone === 'danger' ? Colors.danger : Colors.warning}
          />
          <Text style={[styles.verificationText, { color: meta.tone === 'success' ? Colors.success : meta.tone === 'danger' ? Colors.danger : Colors.warning }]}>
            {meta.label}
          </Text>
        </View>
      ) : null}

      <View style={styles.form}>
        <Field label={t('onboard.name')} value={name} onChangeText={setName} placeholder={t('onboard.namePlaceholder')} maxLength={40} />
        <View style={{ gap: Spacing.xs }}>
          <Text style={styles.fieldLabel}>{t('onboard.vehicle')}</Text>
          <Segmented
            options={VEHICLES.map((v) => ({ key: v.key, label: v.label }))}
            value={vehicle}
            onChange={setVehicle}
          />
        </View>
        <Field label={t('onboard.plate')} value={licensePlate} onChangeText={(s) => setLicensePlate(s.toUpperCase())} placeholder={t('onboard.platePlaceholder')} maxLength={12} hint={t('common.optional')} />

        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Btn label={t('onboard.save')} onPress={save} size="lg" loading={saving} style={{ marginTop: Spacing.sm }} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xxl, fontWeight: '800', color: Colors.text, marginTop: 24 },
  sub: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4 },
  verificationBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.lg,
    backgroundColor: Colors.warningSoft,
    borderRadius: Radius.md,
    padding: Spacing.md,
  },
  verificationBoxSuccess: { backgroundColor: Colors.successSoft },
  verificationBoxDanger: { backgroundColor: Colors.dangerSoft },
  verificationText: { flex: 1, fontSize: FontSize.sm, fontWeight: '700' },
  form: { gap: Spacing.lg, marginTop: Spacing.xl },
  fieldLabel: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontWeight: '600',
  },
  error: { color: Colors.danger, fontSize: FontSize.sm },
});