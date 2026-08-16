/* Privacy & consent (MASTER-BLUEPRINT §21): per-purpose, revocable consent
 * with explanatory copy, personal data export (POST /privacy/export) and a
 * link to account deletion (Settings owns the confirm flow).
 *
 * The location permission sheet (src/components/LocationPermissionSheet.tsx)
 * is owned by a parallel agent and may not exist yet; it is consumed through
 * a runtime-resolved dynamic import so a missing module never breaks the
 * build. Grant/deny drive the consent store either way.
 */
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Btn, Card, ListRow, Screen, ToggleRow } from '@/components/ui';
import { ApiError } from '@/api/client';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { getAuthRepository } from '@/repos';
import { CONSENT_PURPOSES, useConsentStore, type ConsentPurpose } from '@/store/consent';
import { toast } from '@/store/ui';

interface LocationSheetProps {
  visible: boolean;
  onGrant: () => void;
  onDeny: () => void;
}

type LocationSheetModule = { default?: React.ComponentType<LocationSheetProps> };

function loadLocationSheetModule(): Promise<LocationSheetModule | null> {
  // The specifier goes through a function parameter on purpose: a literal
  // dynamic import would be statically resolved (and fail typecheck/bundle)
  // while the parallel agent's sheet does not exist yet.
  return import('@/components/LocationPermissionSheet' as string).then(
    (mod) => mod as LocationSheetModule,
    () => null,
  );
}

const PURPOSE_META: Record<ConsentPurpose, { label: string; hint: string }> = {
  location: { label: t('privacy.location'), hint: t('privacy.locationHint') },
  notifications: { label: t('privacy.notifications'), hint: t('privacy.notificationsHint') },
  marketing: { label: t('privacy.marketing'), hint: t('privacy.marketingHint') },
  contacts: { label: t('privacy.contacts'), hint: t('privacy.contactsHint') },
  camera: { label: t('privacy.camera'), hint: t('privacy.cameraHint') },
  microphone: { label: t('privacy.microphone'), hint: t('privacy.microphoneHint') },
  photos: { label: t('privacy.photos'), hint: t('privacy.photosHint') },
  backgroundLocation: { label: t('privacy.backgroundLocation'), hint: t('privacy.backgroundLocationHint') },
  personalization: { label: t('privacy.personalization'), hint: t('privacy.personalizationHint') },
};

export default function PrivacyScreen() {
  const router = useRouter();
  const consents = useConsentStore((s) => s.consents);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [LocationSheet, setLocationSheet] = useState<React.ComponentType<LocationSheetProps> | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  const grant = useCallback((purpose: ConsentPurpose) => useConsentStore.getState().grant(purpose), []);
  const revoke = useCallback((purpose: ConsentPurpose) => useConsentStore.getState().revoke(purpose), []);

  const togglePurpose = (purpose: ConsentPurpose) => {
    if (consents[purpose]) {
      revoke(purpose);
      return;
    }
    if (purpose !== 'location') {
      grant(purpose);
      return;
    }
    // Location consent goes through the permission sheet when it is built;
    // otherwise it is granted directly and stays revocable here.
    void loadLocationSheetModule().then((mod) => {
      if (mod?.default) {
        setLocationSheet(() => mod.default as React.ComponentType<LocationSheetProps>);
        setSheetOpen(true);
      } else {
        grant('location');
      }
    });
  };

  const exportData = async () => {
    setExportError('');
    setExporting(true);
    try {
      const res = await getAuthRepository().exportData();
      toast(t('privacy.exported', { jobId: res.jobId }));
    } catch (e) {
      setExportError(e instanceof ApiError ? e.message : t('privacy.exportError'));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Screen scroll>
      <Text style={styles.title}>{t('privacy.title')}</Text>
      <Text style={styles.subtitle}>{t('privacy.subtitle')}</Text>

      <Card style={{ marginTop: Spacing.md }}>
        <Text style={styles.section}>{t('privacy.purposes')}</Text>
        <Text style={styles.sectionHint}>{t('privacy.purposesHint')}</Text>
        {CONSENT_PURPOSES.map((purpose) => (
          <ToggleRow
            key={purpose}
            label={PURPOSE_META[purpose].label}
            sub={PURPOSE_META[purpose].hint}
            value={consents[purpose]}
            onChange={() => togglePurpose(purpose)}
          />
        ))}
      </Card>

      <Card style={{ marginTop: Spacing.lg }}>
        <Text style={styles.section}>{t('privacy.data')}</Text>
        {exportError ? <Text style={styles.error}>{exportError}</Text> : null}
        <Btn label={t('privacy.export')} onPress={exportData} loading={exporting} icon="download-outline" />
        <Text style={styles.sectionHint}>{t('privacy.exportHint')}</Text>
      </Card>

      <Card style={{ marginTop: Spacing.lg }}>
        <ListRow
          title={t('privacy.deleteLink')}
          icon="trash-outline"
          onPress={() => router.push('/settings')}
        />
        <View style={{ paddingHorizontal: Spacing.md }}>
          <Text style={styles.sectionHint}>{t('privacy.deleteHint')}</Text>
        </View>
      </Card>

      {LocationSheet ? (
        <LocationSheet
          visible={sheetOpen}
          onGrant={() => {
            grant('location');
            setSheetOpen(false);
          }}
          onDeny={() => {
            revoke('location');
            setSheetOpen(false);
          }}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text, marginBottom: Spacing.sm },
  subtitle: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sans, lineHeight: 19, marginBottom: Spacing.md },
  section: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sansSemibold, marginBottom: Spacing.sm },
  sectionHint: { fontSize: FontSize.xs, color: Colors.textFaint, fontFamily: Fonts.sans, lineHeight: 16, marginTop: Spacing.sm },
  error: { color: Colors.danger, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, marginBottom: Spacing.sm },
});
