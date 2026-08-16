import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { Btn, Card, Empty, ErrorCard, Field, Icon, Row, Screen, Segmented } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import type { I18nKey } from '@/i18n';
import { getCopilotRepository } from '@/repos';
import type { ProviderCopilot200 } from '@hudumika/contract';

const ACTIONS: { key: string; labelKey: I18nKey }[] = [
  { key: 'explain_job', labelKey: 'copilot.action.explain_job' },
  { key: 'diagnose_photos', labelKey: 'copilot.action.diagnose_photos' },
  { key: 'suggest_quote', labelKey: 'copilot.action.suggest_quote' },
  { key: 'recommend_materials', labelKey: 'copilot.action.recommend_materials' },
  { key: 'generate_message', labelKey: 'copilot.action.generate_message' },
  { key: 'summarize_history', labelKey: 'copilot.action.summarize_history' },
];

export default function CopilotScreen() {
  const { bookingId, jobSummary } = useLocalSearchParams<{ bookingId?: string; jobSummary?: string }>();
  const [action, setAction] = useState('explain_job');
  const [summary, setSummary] = useState(jobSummary ?? '');
  const [result, setResult] = useState<ProviderCopilot200 | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState(false);

  const onRun = async () => {
    setRunning(true);
    setError('');
    setUnavailable(false);
    try {
      const res = await getCopilotRepository().ask(action, {
        bookingId: bookingId || undefined,
        jobSummary: summary.trim() || undefined,
      });
      setResult(res);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'COPILOT_UNAVAILABLE') {
        setUnavailable(true);
      } else {
        setError(e instanceof ApiError ? e.message : t('misc.error'));
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <Screen scroll>
      <Segmented options={ACTIONS.map((a) => ({ key: a.key, label: t(a.labelKey) }))} value={action} onChange={setAction} />

      {bookingId ? (
        <Text style={styles.bookingId}>
          {t('booking.id')}: {bookingId}
        </Text>
      ) : null}
      <Field label={t('booking.description')} value={summary} onChangeText={setSummary} multiline hint={t('misc.optional')} />

      <Btn label={t('copilot.run')} icon="sparkles" onPress={onRun} loading={running} />

      {running ? (
        <View style={styles.center}>
          <ActivityIndicator color={Colors.primary} />
        </View>
      ) : unavailable ? (
        <Empty icon="sparkles-outline" title={t('copilot.unavailable')} sub={t('copilot.unavailableSub')} />
      ) : error ? (
        <ErrorCard message={error} onRetry={onRun} />
      ) : result ? (
        <>
          <Card style={{ gap: Spacing.sm }}>
            <Text style={styles.resultText}>{result.result}</Text>
          </Card>
          {result.suggestions && result.suggestions.length > 0 ? (
            <Card flat style={styles.suggestionsCard}>
              {result.suggestions.map((s, i) => (
                <Row key={`${i}-${s}`} gap={Spacing.sm} style={i > 0 ? styles.suggestionBorder : undefined}>
                  <Icon name="checkmark-circle" size={15} color={Colors.success} />
                  <Text style={styles.suggestionText}>{s}</Text>
                </Row>
              ))}
            </Card>
          ) : null}
        </>
      ) : null}

      <Card style={styles.disclaimerCard}>
        <Row gap={Spacing.sm}>
          <Icon name="information-circle-outline" size={16} color={Colors.textTertiary} />
          <Text style={styles.disclaimerText}>{t('copilot.disclaimer')}</Text>
        </Row>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', paddingVertical: 40 },
  bookingId: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: 'PlusJakartaSans_600SemiBold', marginTop: Spacing.md },
  resultText: { fontSize: FontSize.md, color: Colors.text, lineHeight: 22 },
  suggestionsCard: { paddingHorizontal: Spacing.lg },
  suggestionBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border, paddingTop: Spacing.sm, marginTop: Spacing.sm },
  suggestionText: { flex: 1, fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 18 },
  disclaimerCard: { backgroundColor: Colors.surface, borderColor: Colors.border },
  disclaimerText: { flex: 1, fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 16 },
});
