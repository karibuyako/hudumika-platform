import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { t, onLocaleChange, type I18nKey } from '@/i18n';
import type { SelfServicePackage } from '@/api/types';
import { Btn, Card, Icon, Row, Screen, ToggleRow } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { dayLabel } from '@/lib/format';
import { usePromotionStore } from '@/store/promotions';

const PACKAGE_CHOICES: { pkg: SelfServicePackage; label: I18nKey }[] = [
  { pkg: 'basic', label: 'ss.basic' },
  { pkg: 'premium', label: 'ss.premium' },
  { pkg: 'enterprise', label: 'ss.enterprise' },
];

export default function SelfServiceScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const selfService = usePromotionStore((s) => s.selfService);
  const ssLoading = usePromotionStore((s) => s.ssLoading);
  const ssError = usePromotionStore((s) => s.ssError);
  const hydrateSelfService = usePromotionStore((s) => s.hydrateSelfService);
  const toggleSelfService = usePromotionStore((s) => s.toggleSelfService);

  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    hydrateSelfService();
  }, [hydrateSelfService]);

  const submit = async (active: boolean) => {
    setBusy(true);
    setFormError(null);
    const res = await toggleSelfService(active, {
      package: selfService?.package ?? 'basic',
      designUrl: selfService?.designUrl ?? undefined,
      homepageExposure: selfService?.homepageExposure ?? false,
    });
    setBusy(false);
    if (res.ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      setFormError(res.message ?? t('ss.errSave'));
    }
  };

  const setPackage = async (pkg: SelfServicePackage) => {
    setBusy(true);
    setFormError(null);
    const res = await toggleSelfService(selfService?.active ?? false, {
      package: pkg,
      designUrl: selfService?.designUrl ?? undefined,
      homepageExposure: selfService?.homepageExposure ?? false,
    });
    setBusy(false);
    if (res.ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      setFormError(res.message ?? t('ss.errSave'));
    }
  };

  return (
    <Screen scroll>
      {ssLoading && !selfService ? (
        <Card style={{ alignItems: 'center', paddingVertical: Spacing.xl }}>
          <Icon name="time-outline" size={22} color={Colors.textTertiary} />
          <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary, marginTop: Spacing.sm }}>{t('mkt.loading')}</Text>
        </Card>
      ) : (
        <View style={{ gap: Spacing.md }}>
          <Card style={{ gap: Spacing.sm }}>
            <View style={{ paddingVertical: Spacing.sm }}>
              <Text style={[styles.stateTitle, { color: selfService?.active ? Colors.primary : Colors.text }]}>
                {selfService?.active ? t('ss.active') : t('ss.inactive')}
              </Text>
              {selfService?.startedAt ? (
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 }}>
                  {t('ss.started', { date: dayLabel(selfService.startedAt) })}
                </Text>
              ) : null}
            </View>
            <ToggleRow label={t('ss.toggle')} value={selfService?.active ?? false} onChange={(v) => submit(v)} />
          </Card>

          {formError ? (
            <Card style={{ backgroundColor: Colors.dangerSoft }}>
              <Row gap={Spacing.sm}>
                <Icon name="alert-circle-outline" size={18} color={Colors.danger} />
                <Text style={{ fontSize: FontSize.sm, color: Colors.danger, fontWeight: '600', flex: 1 }}>{formError}</Text>
              </Row>
            </Card>
          ) : null}

          {ssError && !selfService ? (
            <Card style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.xl }}>
              <Icon name="cloud-offline-outline" size={22} color={Colors.textTertiary} />
              <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('ss.errLoad')}</Text>
              <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => hydrateSelfService()} />
            </Card>
          ) : null}

          <Card style={{ gap: Spacing.md }}>
            <Text style={styles.sectionLabel}>{t('ss.package')}</Text>
            <Row gap={8} style={{ flexWrap: 'wrap' }}>
              {PACKAGE_CHOICES.map((c) => (
                <Pressable
                  key={c.pkg}
                  onPress={() => setPackage(c.pkg)}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel={t(c.label)}
                  style={[styles.chip, (selfService?.package ?? 'basic') === c.pkg && styles.chipActive]}>
                  <Text style={[styles.chipText, (selfService?.package ?? 'basic') === c.pkg && { color: Colors.white, fontWeight: '700' }]}>
                    {t(c.label)}
                  </Text>
                </Pressable>
              ))}
            </Row>
            <ToggleRow
              label={t('ss.homepage')}
              value={selfService?.homepageExposure ?? false}
              onChange={(v) =>
                toggleSelfService(selfService?.active ?? false, {
                  package: selfService?.package ?? 'basic',
                  designUrl: selfService?.designUrl ?? undefined,
                  homepageExposure: v,
                })
              }
            />
          </Card>
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  stateTitle: { fontSize: FontSize.lg, fontWeight: '700' },
  sectionLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  chip: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primaryDark },
  chipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
});
