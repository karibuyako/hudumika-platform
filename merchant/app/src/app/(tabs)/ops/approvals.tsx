import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Chip, Empty, Field, Icon, Pill, Row, Screen, Segmented, SheetModal } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { fullTime, tzs } from '@/lib/format';
import type { ApprovalRequest, ApprovalStatus, ApprovalType } from '@/api/types';
import { useStaffOpsStore } from '@/store/staff-ops';
import { useMessageStore } from '@/store/messages';

const TYPE_LABEL: Record<ApprovalType, I18nKey> = {
  price_change: 'ap.typePriceChange',
  promotion: 'ap.typePromotion',
  refund_above_threshold: 'ap.typeRefund',
  inventory_adjustment: 'ap.typeInventory',
  staff_role_change: 'ap.typeRoleChange',
  bulk_operation: 'ap.typeBulk',
};

const TYPE_TONE: Record<ApprovalType, 'neutral' | 'danger' | 'success' | 'info' | 'warning'> = {
  price_change: 'warning',
  promotion: 'info',
  refund_above_threshold: 'danger',
  inventory_adjustment: 'warning',
  staff_role_change: 'info',
  bulk_operation: 'neutral',
};

const STATUS_PILL: Record<ApprovalStatus, { label: I18nKey; tone: 'neutral' | 'danger' | 'success' | 'info' | 'warning' }> = {
  pending: { label: 'ap.statusPending', tone: 'warning' },
  approved: { label: 'ap.statusApproved', tone: 'success' },
  rejected: { label: 'ap.statusRejected', tone: 'danger' },
  cancelled: { label: 'ap.statusCancelled', tone: 'neutral' },
};

const SUBMIT_TYPES: ApprovalType[] = ['price_change', 'promotion', 'refund_above_threshold', 'inventory_adjustment', 'staff_role_change', 'bulk_operation'];

export default function ApprovalsScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const approvals = useStaffOpsStore((s) => s.approvals);
  const hydrateApprovals = useStaffOpsStore((s) => s.hydrateApprovals);
  const decideApproval = useStaffOpsStore((s) => s.decideApproval);
  const submitApproval = useStaffOpsStore((s) => s.submitApproval);
  const pushMessage = useMessageStore((s) => s.push);

  const [scope, setScope] = useState<'submitted' | 'inbox' | 'all'>('inbox');
  const [statusFilter, setStatusFilter] = useState<ApprovalStatus | null>(null);
  const [sheet, setSheet] = useState<null | 'decide' | 'submit'>(null);
  const [target, setTarget] = useState<ApprovalRequest | null>(null);
  const [decision, setDecision] = useState<'approved' | 'rejected'>('approved');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [decidedConflict, setDecidedConflict] = useState<string | null>(null);

  const [submitType, setSubmitType] = useState<ApprovalType>('price_change');
  const [summary, setSummary] = useState('');
  const [amount, setAmount] = useState('');
  const [refId, setRefId] = useState('');

  useEffect(() => {
    hydrateApprovals(scope, statusFilter ?? undefined);
  }, [hydrateApprovals, scope, statusFilter]);

  const openDecide = (a: ApprovalRequest, decision: 'approved' | 'rejected') => {
    if (a.status !== 'pending') return;
    setTarget(a);
    setDecision(decision);
    setComment('');
    setError('');
    setDecidedConflict(null);
    setSheet('decide');
  };

  const decide = async () => {
    if (!target) return;
    if (!comment.trim()) {
      setError(t('ap.commentRequired'));
      return;
    }
    setBusy(true);
    setError('');
    const res = await decideApproval(target.id, { decision, comment: comment.trim() });
    setBusy(false);
    if (res.ok) {
      setSheet(null);
      setTarget(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({ type: 'system', title: decision === 'approved' ? t('ap.approved') : t('ap.rejected'), body: comment.trim() });
    } else {
      if (res.code === 'APPROVAL_ALREADY_DECIDED') {
        setDecidedConflict(res.message ?? null);
      } else {
        setError(res.message ?? t('ap.errDecide'));
      }
    }
  };

  const submit = async () => {
    if (!summary.trim()) return;
    setBusy(true);
    setError('');
    const res = await submitApproval({
      type: submitType,
      summary: summary.trim(),
      refId: refId.trim() || undefined,
      amountTZS: amount.trim() === '' ? null : Number(amount.trim()),
    });
    setBusy(false);
    if (res.ok) {
      setSheet(null);
      setSummary('');
      setAmount('');
      setRefId('');
      setSubmitType('price_change');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({ type: 'system', title: t('ap.submitted'), body: summary.trim() });
      hydrateApprovals(scope, statusFilter ?? undefined);
    } else {
      setError(res.message ?? t('ap.errSubmit'));
    }
  };

  const rows = [...approvals.rows].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('ap.title')}</Text>
        <Btn label={t('ap.newRequest')} icon="add" size="sm" onPress={() => { setError(''); setSheet('submit'); }} />
      </View>

      <Screen scroll>
        <View style={{ marginTop: Spacing.md }}>
          <Segmented
            options={[
              { key: 'submitted', label: t('ap.scopeSubmitted') },
              { key: 'inbox', label: t('ap.scopeInbox') },
              { key: 'all', label: t('ap.scopeAll') },
            ]}
            value={scope}
            onChange={setScope}
          />
        </View>
        <Row gap={8} style={{ flexWrap: 'wrap', marginTop: Spacing.sm }}>
          <Chip label={t('common.all')} selected={statusFilter === null} onPress={() => setStatusFilter(null)} />
          {(Object.keys(STATUS_PILL) as ApprovalStatus[]).map((st) => (
            <Chip key={st} label={t(STATUS_PILL[st].label)} selected={statusFilter === st} onPress={() => setStatusFilter(st)} />
          ))}
        </Row>

        {approvals.error ? (
          <View style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.lg }}>
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('ap.errLoad')}</Text>
            <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => hydrateApprovals(scope, statusFilter ?? undefined)} />
          </View>
        ) : null}

        <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
          {!approvals.loading && rows.length === 0 ? <Empty icon="checkmark-done-outline" title={t('ap.empty')} sub={t('ap.emptySub')} /> : null}
          {rows.map((a) => {
            const decided = a.status !== 'pending';
            return (
              <Card key={a.id} style={{ gap: Spacing.sm }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Pill label={t(TYPE_LABEL[a.type])} tone={TYPE_TONE[a.type]} />
                  <Pill label={t(STATUS_PILL[a.status].label)} tone={STATUS_PILL[a.status].tone} />
                </Row>
                <Text style={styles.summary} numberOfLines={3}>
                  {a.summary ?? a.type}
                </Text>
                {a.amountTZS !== null && a.amountTZS !== undefined ? (
                  <Text style={styles.meta}>{t('ap.amount', { amount: tzs(a.amountTZS) })}</Text>
                ) : null}
                {a.refType ? (
                  <Text style={styles.meta}>
                    {a.refType}{a.refId ? ` · ${a.refId}` : ''}
                  </Text>
                ) : null}
                <Text style={styles.meta}>
                  {t('ap.requestedBy', { name: a.requestedBy })} · {fullTime(a.createdAt)}
                </Text>
                {decided ? (
                  <>
                    <Text style={styles.meta}>
                      {t('ap.decidedBy', { name: a.decisionBy ?? '—' })}{a.decidedAt ? ` · ${fullTime(a.decidedAt)}` : ''}
                    </Text>
                    {a.decisionComment ? <Text style={styles.comment}>“{a.decisionComment}”</Text> : null}
                    <Text style={styles.finalNote}>{t('ap.alreadyDecided')}</Text>
                  </>
                ) : (
                  <Row gap={Spacing.sm}>
                    <Btn label={t('ap.approve')} variant="success" size="sm" style={{ flex: 1 }} onPress={() => openDecide(a, 'approved')} />
                    <Btn label={t('ap.reject')} variant="danger" size="sm" style={{ flex: 1 }} onPress={() => openDecide(a, 'rejected')} />
                  </Row>
                )}
              </Card>
            );
          })}
        </View>
      </Screen>

      <SheetModal visible={sheet === 'decide'} onClose={() => setSheet(null)} title={t('ap.decideTitle')}>
        <View style={{ gap: Spacing.md }}>
          {decidedConflict ? (
            <View style={styles.conflictBanner}>
              <Icon name="information-circle-outline" size={16} color={Colors.warning} />
              <Text style={styles.conflictText}>{decidedConflict}</Text>
            </View>
          ) : null}
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 19 }}>
            {target?.summary ?? ''}
          </Text>
          <Field
            label={t('ap.comment')}
            value={comment}
            onChangeText={setComment}
            placeholder={t('ap.commentPh')}
            maxLength={500}
            multiline
          />
          <Text style={styles.tip}>{t('ap.decideBody')}</Text>
          {error ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{error}</Text> : null}
          <Row gap={Spacing.sm}>
            <Btn label={t('common.cancel')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => setSheet(null)} />
            <Btn
              label={decision === 'approved' ? t('ap.approve') : t('ap.reject')}
              variant={decision === 'approved' ? 'success' : 'danger'}
              size="sm"
              style={{ flex: 1 }}
              loading={busy}
              disabled={!comment.trim()}
              onPress={decide}
            />
          </Row>
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'submit'} onClose={() => setSheet(null)} title={t('ap.submitTitle')}>
        <View style={{ gap: Spacing.md }}>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('ap.submitType')}</Text>
            <Row gap={8} style={{ flexWrap: 'wrap' }}>
              {SUBMIT_TYPES.map((ty) => (
                <Chip key={ty} label={t(TYPE_LABEL[ty])} selected={submitType === ty} onPress={() => setSubmitType(ty)} />
              ))}
            </Row>
          </View>
          <Field label={t('ap.submitSummary')} value={summary} onChangeText={setSummary} placeholder={t('ap.submitSummaryPh')} maxLength={300} multiline />
          <Field label={t('ap.submitAmount')} value={amount} onChangeText={setAmount} keyboardType="number-pad" placeholder="TZS" maxLength={12} />
          <Field label={t('ap.submitRef')} value={refId} onChangeText={setRefId} placeholder="e.g. o_seed_11" maxLength={80} />
          {error ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{error}</Text> : null}
          <Btn label={t('ap.submit')} size="lg" loading={busy} disabled={!summary.trim()} onPress={submit} />
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
  summary: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text, lineHeight: 20 },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 16 },
  comment: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontStyle: 'italic',
    lineHeight: 18,
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    padding: Spacing.sm,
  },
  finalNote: { fontSize: FontSize.xs, color: Colors.warning, fontWeight: '600' },
  conflictBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.warningSoft,
    borderRadius: Radius.md,
    padding: Spacing.sm,
  },
  conflictText: { flex: 1, fontSize: FontSize.xs, color: Colors.warning, fontWeight: '600' },
  fieldLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  tip: { fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'center', lineHeight: 16 },
});
