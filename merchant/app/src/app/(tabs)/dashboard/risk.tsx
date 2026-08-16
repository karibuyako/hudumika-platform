import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Chip, Empty, Field, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { api } from '@/api/client';
import type { RiskEvent } from '@/api/types';
import { fullTime } from '@/lib/format';
import { useSessionStore } from '@/store/session';

const LEVEL_TONE: Record<RiskEvent['level'], { label: I18nKey; tone: 'danger' | 'warning' | 'info' }> = {
  high: { label: 'risk.high', tone: 'danger' },
  medium: { label: 'risk.medium', tone: 'warning' },
  low: { label: 'risk.low', tone: 'info' },
};

const TYPE_LABEL: Record<RiskEvent['type'], I18nKey> = {
  'refund-ratio': 'risk.typeRefundRatio',
  'refund-velocity': 'risk.typeRefundVelocity',
  'large-refund': 'risk.typeLargeRefund',
  'withdrawal-anomaly': 'risk.typeWithdrawal',
  'login-risk': 'risk.typeLogin',
  'unusual-order-pattern': 'risk.typeUnusualPattern',
};

export default function RiskScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const perms = useSessionStore((s) => s.perms);
  const canView = perms.includes('*') || perms.includes('audit:view');
  const [events, setEvents] = useState<RiskEvent[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [target, setTarget] = useState<RiskEvent | null>(null);
  const [decision, setDecision] = useState<'resolved' | 'dismissed'>('resolved');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');

  const load = () => {
    if (!canView) return;
    api.get<{ events: RiskEvent[]; openCount: number }>('/risk/events', { retries: 1 })
      .then((r) => {
        setEvents(r.events);
        setOpenCount(r.openCount);
      })
      .catch(() => undefined);
  };

  useEffect(load, [canView]);

  const openReview = (e: RiskEvent) => {
    setTarget(e);
    setDecision('resolved');
    setReason('');
    setFormError('');
  };

  const review = async () => {
    if (!target) return;
    if (!reason.trim()) {
      setFormError(t('risk.reasonRequired'));
      return;
    }
    setBusy(true);
    setFormError('');
    try {
      const res = await api.post<{ event: RiskEvent }>(
        `/risk/${target.id}/review`,
        { decision, reason: reason.trim().slice(0, 500) },
        { idempotencyKey: `rk:${target.id}:${Date.now()}` },
      );
      setEvents((l) => l.map((e) => (e.id === target.id ? res.event : e)));
      setOpenCount((c) => Math.max(0, c - 1));
      setTarget(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === 'RISK_ALREADY_REVIEWED') {
        setFormError(t('risk.alreadyReviewed'));
        load();
      } else {
        setFormError(err.message ?? t('risk.errReview'));
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('risk.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        {!canView ? (
          <Card style={styles.noAccess}>
            <Icon name="lock-closed-outline" size={20} color={Colors.warning} />
            <Text style={{ flex: 1, fontSize: FontSize.sm, color: Colors.textSecondary }}>
              {t('risk.note')}
            </Text>
          </Card>
        ) : (
          <>
            <Card style={styles.summary}>
              <Row style={{ justifyContent: 'space-between' }}>
                <View>
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('risk.openFlags')}</Text>
                  <Text style={{ fontSize: 30, fontWeight: '900', color: openCount ? Colors.danger : Colors.success }}>
                    {openCount}
                  </Text>
                </View>
                <View style={{ flex: 1, paddingLeft: Spacing.lg }}>
                  <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 }}>
                    {t('risk.rules')}
                  </Text>
                </View>
              </Row>
            </Card>

            <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
              {events.length === 0 ? <Empty icon="shield-checkmark-outline" title={t('risk.empty')} sub={t('risk.healthy')} /> : null}
              {events.map((e) => (
                <Card key={e.id} style={{ gap: Spacing.sm }}>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Row gap={8} style={{ flex: 1 }}>
                      <Pill label={t(LEVEL_TONE[e.level].label)} tone={LEVEL_TONE[e.level].tone} />
                      <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.text }}>{t(TYPE_LABEL[e.type])}</Text>
                    </Row>
                    {e.status === 'open' ? (
                      <Pill label={t('risk.open')} tone="danger" />
                    ) : e.status === 'resolved' ? (
                      <Pill label={t('risk.resolved')} tone="success" />
                    ) : (
                      <Pill label={t('risk.dismissed')} tone="neutral" />
                    )}
                  </Row>
                  <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 }}>{e.detail}</Text>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{fullTime(e.ts)}</Text>
                    {e.status === 'open' ? (
                      <Btn label={t('risk.review')} size="sm" variant="outline" onPress={() => openReview(e)} />
                    ) : (
                      <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, flexShrink: 1, textAlign: 'right' }}>
                        {t('risk.reviewedBy', { name: e.reviewedBy ?? '' })}
                        {e.reason ? ` · ${e.reason}` : ''}
                      </Text>
                    )}
                  </Row>
                </Card>
              ))}
            </View>
          </>
        )}
      </Screen>

      <SheetModal visible={target !== null} onClose={() => setTarget(null)} title={t('risk.reviewTitle')}>
        <View style={{ gap: Spacing.md }}>
          {target ? (
            <>
              <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 19 }}>{target.detail}</Text>
              <Row gap={8} style={{ flexWrap: 'wrap' }}>
                <Chip label={t('risk.decisionResolved')} selected={decision === 'resolved'} onPress={() => setDecision('resolved')} />
                <Chip label={t('risk.decisionDismissed')} selected={decision === 'dismissed'} onPress={() => setDecision('dismissed')} />
              </Row>
              <Field
                label={t('risk.reason')}
                value={reason}
                onChangeText={setReason}
                multiline
                maxLength={500}
                placeholder={t('risk.reasonPh')}
              />
              {formError ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{formError}</Text> : null}
              <Row gap={Spacing.sm}>
                <Btn label={t('common.cancel')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => setTarget(null)} />
                <Btn
                  label={decision === 'resolved' ? t('risk.resolve') : t('risk.dismiss')}
                  variant={decision === 'resolved' ? 'success' : 'danger'}
                  size="sm"
                  style={{ flex: 1 }}
                  loading={busy}
                  disabled={!reason.trim()}
                  onPress={review}
                />
              </Row>
            </>
          ) : null}
        </View>
      </SheetModal>
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
  noAccess: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  summary: { marginTop: Spacing.sm },
});
