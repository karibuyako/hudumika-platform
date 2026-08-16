import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { Btn, Card, Field, Icon, Row, Screen, SheetModal, Spinner } from '@/components/ui';
import { Colors, FontSize, NumberStyle, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { getRiderRepository, getSupportRepository } from '@/repos';
import type { RiderPerformance } from '@hudumika/contract';

const REVIEW_THRESHOLD = 40;

export default function PenaltiesScreen() {
  const [performance, setPerformance] = useState<RiderPerformance | null>(null);
  const [error, setError] = useState('');
  const [appealVisible, setAppealVisible] = useState(false);
  const [appealOrderId, setAppealOrderId] = useState('');
  const [appealReason, setAppealReason] = useState('');
  const [sending, setSending] = useState(false);
  const [appealError, setAppealError] = useState('');
  const [appealSent, setAppealSent] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      setPerformance(await getRiderRepository().getPerformance());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('penalties.loadFailed'));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const openAppeal = () => {
    setAppealOrderId('');
    setAppealReason('');
    setAppealError('');
    setAppealSent(false);
    setAppealVisible(true);
  };

  const sendAppeal = async () => {
    const score = performance?.reliabilityScore;
    const body = [
      t('penalties.appealBody'),
      t('penalties.appealScore', { score: score != null ? score : '—' }),
      appealOrderId.trim() ? t('penalties.appealOrderLine', { orderId: appealOrderId.trim() }) : null,
      appealReason.trim() ? appealReason.trim() : null,
    ]
      .filter(Boolean)
      .join('\n');
    setSending(true);
    setAppealError('');
    try {
      await getSupportRepository().createTicket(t('penalties.appealSubject'), body, 'account', appealOrderId.trim() || undefined);
      setAppealSent(true);
      setAppealVisible(false);
    } catch (e) {
      setAppealError(e instanceof ApiError ? e.message : t('penalties.appealFailed'));
    } finally {
      setSending(false);
    }
  };

  if (error) {
    return (
      <Screen>
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
          <Btn
            label={t('common.retry')}
            variant="ghost"
            onPress={() => {
              setError('');
              load();
            }}
          />
        </View>
      </Screen>
    );
  }

  if (!performance) {
    return (
      <Screen>
        <View style={styles.center}>
          <Spinner color={Colors.primary} />
        </View>
      </Screen>
    );
  }

  const score = performance.reliabilityScore;
  const underReview = score != null && score < REVIEW_THRESHOLD;

  return (
    <Screen scroll>
      {/* Reliability score card */}
      <Card style={{ gap: Spacing.md }}>
        <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={styles.cardTitle}>{t('penalties.reliability')}</Text>
          {score != null ? (
            <Text style={[styles.scoreValue, underReview && { color: Colors.danger }]}>{score}</Text>
          ) : (
            <Text style={styles.sub}>{t('safety.securityScoreUnavailable')}</Text>
          )}
        </Row>
        {underReview ? (
          <View style={styles.reviewBox}>
            <Icon name="alert-circle" size={14} color={Colors.danger} />
            <Text style={styles.reviewText}>{t('penalties.reviewNotice')}</Text>
          </View>
        ) : null}
        <Row gap={Spacing.lg}>
          {score != null ? (
            <View style={{ flex: 1 }}>
              <Text style={styles.kpiLabel}>{t('penalties.level')}</Text>
              <Text style={styles.kpiValue}>{performance.level}</Text>
            </View>
          ) : null}
          <View style={{ flex: 1 }}>
            <Text style={styles.kpiLabel}>{t('penalties.behavior')}</Text>
            {performance.behaviorScore != null ? (
              <Text style={styles.kpiValue}>{performance.behaviorScore}</Text>
            ) : (
              <Text style={styles.plannedText}>{t('penalties.behaviorPlanned')}</Text>
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.kpiLabel}>{t('penalties.percentile')}</Text>
            <Text style={styles.kpiValue}>
              {performance.benchmarks?.percentileRank != null ? `${performance.benchmarks.percentileRank}%` : '—'}
            </Text>
          </View>
        </Row>
        {performance.benchmarks?.teamAverage != null ? (
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={styles.sub}>{t('penalties.benchmarks')}</Text>
            <Text style={styles.sub}>{t('penalties.teamAverage')}: {performance.benchmarks.teamAverage}</Text>
          </Row>
        ) : null}
      </Card>

      {/* Honest note: penalty history is planned, never fabricated */}
      <View style={styles.plannedBox}>
        <Icon name="time-outline" size={14} color={Colors.textTertiary} />
        <Text style={styles.plannedText}>{t('penalties.historyPlanned')}</Text>
      </View>

      {/* Appeal */}
      <Card style={{ gap: Spacing.sm }}>
        <Text style={styles.cardTitle}>{t('penalties.appeal')}</Text>
        <Text style={styles.sub}>{t('penalties.appealSub')}</Text>
        <Btn label={t('penalties.appeal')} icon="document-text-outline" onPress={openAppeal} />
      </Card>

      {appealSent ? (
        <View style={styles.sentBox}>
          <Icon name="checkmark-circle" size={16} color={Colors.success} />
          <Text style={styles.sentText}>{t('penalties.appealSent')}</Text>
        </View>
      ) : null}

      {/* Appeal ticket sheet */}
      <SheetModal visible={appealVisible} onClose={() => setAppealVisible(false)} title={t('penalties.appealTitle')}>
        <View style={{ gap: Spacing.md }}>
          <Text style={styles.sub}>
            {t('penalties.appealBody')} — {t('penalties.reliability')}: {score != null ? score : '—'}
          </Text>
          <Field label={t('penalties.appealOrder')} value={appealOrderId} onChangeText={setAppealOrderId} placeholder={t('penalties.appealOrderPlaceholder')} />
          <Field label={t('penalties.appealBody')} value={appealReason} onChangeText={setAppealReason} placeholder={t('penalties.appealBodyPlaceholder')} multiline maxLength={4000} />
          {appealError ? <Text style={styles.error}>{appealError}</Text> : null}
          <Btn label={t('penalties.appealSend')} icon="send-outline" onPress={sendAppeal} loading={sending} size="lg" />
        </View>
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md },
  error: { color: Colors.danger, fontSize: FontSize.sm },
  cardTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  scoreValue: { fontSize: FontSize.xxl, fontWeight: '900', color: Colors.primaryDeep, fontVariant: NumberStyle.fontVariant },
  sub: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 19 },
  kpiLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600' },
  kpiValue: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, fontVariant: NumberStyle.fontVariant, textTransform: 'capitalize' },
  plannedBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.surface,
    borderRadius: Radius.sm,
    padding: Spacing.md,
    marginVertical: Spacing.md,
  },
  plannedText: { flex: 1, color: Colors.textTertiary, fontSize: FontSize.xs, lineHeight: 17, fontWeight: '600' },
  reviewBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.dangerSoft,
    borderRadius: Radius.sm,
    padding: Spacing.sm,
  },
  reviewText: { flex: 1, color: Colors.danger, fontSize: FontSize.xs, lineHeight: 17, fontWeight: '700' },
  sentBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.successSoft,
    borderRadius: Radius.sm,
    padding: Spacing.md,
    marginTop: Spacing.md,
  },
  sentText: { flex: 1, color: Colors.success, fontSize: FontSize.sm, fontWeight: '700' },
});
