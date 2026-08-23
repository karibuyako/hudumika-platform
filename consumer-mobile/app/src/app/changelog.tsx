/* Changelog / release notes.
 *
 * CLIENT CONTENT, not contract data: the notes below are app content with
 * no server endpoint (OPERATIONS-COVERAGE has no changelog operation). In
 * production this list is fed from a CMS or remote config so release notes
 * can ship without an app update — keep the render loop, swap the source.
 */
import { useRouter } from 'expo-router';
import { StyleSheet, Text } from 'react-native';

import { Btn, Card, Row, Screen } from '@/components/ui';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t, type I18nKey } from '@/i18n';

const RELEASES: { key: string; title: I18nKey; notes: I18nKey }[] = [
  { key: 'v0.3.0', title: 'changelog.v0.3.0', notes: 'changelog.v0.3.0.notes' },
  { key: 'v0.2.0', title: 'changelog.v0.2.0', notes: 'changelog.v0.2.0.notes' },
  { key: 'v0.1.0', title: 'changelog.v0.1.0', notes: 'changelog.v0.1.0.notes' },
];

export default function ChangelogScreen() {
  const router = useRouter();

  return (
    <Screen scroll>
      <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
        <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
        <Text style={styles.title}>{t('changelog.title')}</Text>
      </Row>
      <Text style={styles.subtitle}>{t('changelog.subtitle')}</Text>
      {RELEASES.map((release) => (
        <Card key={release.key} style={styles.release}>
          <Text style={styles.version}>{t(release.title)}</Text>
          <Text style={styles.notes}>{t(release.notes)}</Text>
        </Card>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text },
  subtitle: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginBottom: Spacing.lg },
  release: { marginBottom: Spacing.md, paddingVertical: Spacing.lg },
  version: { fontSize: FontSize.md, fontFamily: Fonts.sansExtraBold, color: Colors.text, marginBottom: Spacing.sm },
  notes: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sans, lineHeight: 21 },
});
