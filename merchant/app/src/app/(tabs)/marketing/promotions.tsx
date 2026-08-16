import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { t, onLocaleChange, type I18nKey } from '@/i18n';
import type { Promotion, PromotionInput, PromotionPerformance, PromotionStatus, PromotionType } from '@/api/types';
import { Btn, Card, Empty, Field, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { dayLabel, tzs } from '@/lib/format';
import { usePromotionStore } from '@/store/promotions';

const STATUS_META: Record<PromotionStatus, { label: I18nKey; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  draft: { label: 'pm.statusDraft', tone: 'neutral' },
  pending_review: { label: 'pm.statusPendingReview', tone: 'info' },
  live: { label: 'pm.statusLive', tone: 'success' },
  paused: { label: 'pm.statusPaused', tone: 'warning' },
  rejected: { label: 'pm.statusRejected', tone: 'danger' },
  ended: { label: 'pm.statusEnded', tone: 'neutral' },
};

const TYPE_CHOICES: { type: PromotionType; label: I18nKey }[] = [
  { type: 'discount', label: 'mkt.typeDiscount' },
  { type: 'coupon', label: 'mkt.typeCoupon' },
  { type: 'free_delivery', label: 'mkt.typeFreeDelivery' },
  { type: 'new_customer', label: 'mkt.typeNewCustomer' },
  { type: 'flash', label: 'mkt.typeFlash' },
  { type: 'ppc', label: 'mkt.typePpc' },
];

export default function PromotionsScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const promotions = usePromotionStore((s) => s.promotions);
  const loading = usePromotionStore((s) => s.loading);
  const error = usePromotionStore((s) => s.error);
  const hydrate = usePromotionStore((s) => s.hydrate);
  const create = usePromotionStore((s) => s.create);
  const update = usePromotionStore((s) => s.update);
  const pause = usePromotionStore((s) => s.pause);
  const performance = usePromotionStore((s) => s.performance);

  const [editing, setEditing] = useState<Promotion | 'new' | null>(null);
  const [perfId, setPerfId] = useState<string | null>(null);
  const [perf, setPerf] = useState<PromotionPerformance | null>(null);
  const [perfFailed, setPerfFailed] = useState(false);
  const [conflict, setConflict] = useState<{ message: string; conflicting?: Record<string, unknown> } | null>(null);

  const [title, setTitle] = useState('');
  const [type, setType] = useState<PromotionType>('discount');
  const [budget, setBudget] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const openNew = () => {
    setTitle('');
    setType('discount');
    setBudget('');
    setDescription('');
    setFormError(null);
    setConflict(null);
    setEditing('new');
  };

  const openEdit = (p: Promotion) => {
    setTitle(p.title);
    setType(p.type);
    setBudget(p.budgetTZS != null ? String(p.budgetTZS) : '');
    setDescription(p.description ?? '');
    setFormError(null);
    setConflict(null);
    setEditing(p);
  };

  const openPerf = useCallback(
    async (id: string) => {
      setPerfId(id);
      setPerf(null);
      setPerfFailed(false);
      const p = await performance(id);
      if (!p) setPerfFailed(true);
      else setPerf(p);
    },
    [performance],
  );

  const submit = async () => {
    const budgetTZS = budget ? Math.round(Number(budget.replace(/[^\d]/g, ''))) : 0;
    if (!title.trim()) return setFormError(t('pm.errTitle'));
    if (budgetTZS <= 0) return setFormError(t('pm.errBudget'));
    const input: PromotionInput = {
      type,
      title: title.trim(),
      description: description.trim() ? description.trim() : undefined,
      budgetTZS,
      startsAt: Date.now(),
      endsAt: Date.now() + 7 * 86400000,
    };
    setBusy(true);
    const res = editing !== 'new' && editing ? await update(editing.id, input) : await create(input);
    setBusy(false);
    if (res.ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setEditing(null);
      setConflict(null);
      hydrate();
    } else if (res.code === 'PROMOTION_CONFLICT_ACTIVE') {
      /* Conflict banner: list the conflicting campaign + window; the merchant
       * picks "edit mine" or "keep theirs" — no silent stacking. */
      const conflicting = (res.details?.conflicting ?? {}) as Record<string, unknown>;
      setConflict({
        message: res.message ?? t('pm.errCreate'),
        conflicting,
      });
    } else {
      setFormError(res.message ?? t('pm.errCreate'));
    }
  };

  const togglePause = async (p: Promotion) => {
    const res = await pause(p.id, p.status !== 'paused');
    if (res.ok) {
      hydrate();
    } else if (res.code === 'PROMOTION_CONFLICT_ACTIVE') {
      const conflicting = (res.details?.conflicting ?? {}) as Record<string, unknown>;
      setConflict({ message: res.message ?? t('pm.statusError'), conflicting });
    } else {
      setConflict({ message: res.message ?? t('pm.statusError') });
    }
  };

  return (
    <Screen scroll>
      <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.sm }}>
        <Text style={styles.subtitle}>{t('pm.subtitle')}</Text>
        <Btn label={t('pm.newPromotion')} icon="add" size="sm" onPress={openNew} />
      </Row>

      {error ? (
        <Card style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.xl }}>
          <Icon name="cloud-offline-outline" size={22} color={Colors.textTertiary} />
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('pm.errLoad')}</Text>
          <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => hydrate()} />
        </Card>
      ) : loading && promotions.length === 0 ? (
        <Card style={{ alignItems: 'center', paddingVertical: Spacing.xl }}>
          <Icon name="time-outline" size={22} color={Colors.textTertiary} />
          <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary, marginTop: Spacing.sm }}>{t('mkt.loading')}</Text>
        </Card>
      ) : promotions.length === 0 ? (
        <Empty icon="megaphone-outline" title={t('pm.empty')} sub={t('pm.emptySub')} />
      ) : (
        <View style={{ gap: Spacing.md }}>
          {conflict ? (
            <Card style={{ backgroundColor: Colors.dangerSoft, gap: Spacing.sm }}>
              <Row gap={Spacing.sm}>
                <Icon name="alert-circle-outline" size={18} color={Colors.danger} />
                <Text style={{ fontSize: FontSize.sm, color: Colors.danger, fontWeight: '600', flex: 1, lineHeight: 18 }}>{conflict.message}</Text>
              </Row>
              {conflict.conflicting ? (
                <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary, lineHeight: 16 }}>
                  {String(conflict.conflicting.title ?? '')}
                  {conflict.conflicting.startsAt && conflict.conflicting.endsAt
                    ? ` · ${dayLabel(Number(conflict.conflicting.startsAt))} ~ ${dayLabel(Number(conflict.conflicting.endsAt))}`
                    : ''}
                </Text>
              ) : null}
              <Row gap={Spacing.sm}>
                <Btn label={t('pm.editMine')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => setConflict(null)} />
                <Btn label={t('pm.keepTheirs')} size="sm" style={{ flex: 1 }} onPress={() => setConflict(null)} />
              </Row>
            </Card>
          ) : null}
          {promotions.map((p) => {
            const meta = STATUS_META[p.status];
            return (
              <Card key={p.id} style={{ gap: Spacing.sm }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={styles.dealTitle} numberOfLines={2}>{p.title}</Text>
                  <Pill label={t(meta.label)} tone={meta.tone} />
                </Row>
                {p.status === 'pending_review' ? (
                  <Card style={{ backgroundColor: Colors.primarySoft, paddingVertical: 8 }}>
                    <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '600' }}>{t('pm.pendingReview')}</Text>
                  </Card>
                ) : null}
                {p.status === 'rejected' || p.rejectReason ? (
                  <Card style={{ backgroundColor: Colors.dangerSoft, paddingVertical: 8 }}>
                    <Row gap={Spacing.sm}>
                      <Icon name="alert-circle-outline" size={15} color={Colors.danger} />
                      <Text style={{ fontSize: FontSize.xs, color: Colors.danger, fontWeight: '600', flex: 1 }}>
                        {t('pm.rejectedBanner', { reason: p.rejectReason ?? t('pm.statusRejected') })}
                      </Text>
                    </Row>
                  </Card>
                ) : null}
                {p.budgetExceededReason === 'PROMOTION_BUDGET_EXCEEDED' ? (
                  <Card style={{ backgroundColor: Colors.warningSoft, paddingVertical: 8 }}>
                    <Row gap={Spacing.sm}>
                      <Icon name="information-circle-outline" size={15} color={Colors.warning} />
                      <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '600', flex: 1 }}>{t('pm.budgetExceeded')}</Text>
                    </Row>
                  </Card>
                ) : null}
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 16 }}>
                  {t('pm.typeLine', {
                    label: t(TYPE_CHOICES.find((c) => c.type === p.type)?.label ?? 'mkt.typeDiscount'),
                    start: p.startsAt ? dayLabel(p.startsAt) : '—',
                    end: p.endsAt ? dayLabel(p.endsAt) : '—',
                  })}
                </Text>
                <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                    {t('pm.spendBudget', { a: tzs(p.spendTZS), b: p.budgetTZS != null ? tzs(p.budgetTZS) : '—' })}
                  </Text>
                  <Pressable
                    onPress={() => openPerf(p.id)}
                    accessibilityRole="button"
                    accessibilityLabel={t('pm.perf')}
                    style={styles.linkBtn}>
                    <Icon name="trending-up-outline" size={14} color={Colors.info} />
                    <Text style={styles.linkText}>{t('pm.perf')}</Text>
                  </Pressable>
                </Row>
                <Row gap={Spacing.sm}>
                  {p.status === 'live' || p.status === 'paused' ? (
                    <View style={{ flex: 1 }}>
                      <Btn
                        label={p.status === 'paused' ? t('pm.resume') : t('pm.pause')}
                        variant={p.status === 'paused' ? 'primary' : 'outline'}
                        size="sm"
                        onPress={() => togglePause(p)}
                      />
                    </View>
                  ) : null}
                  <View style={{ flex: 1 }}>
                    <Btn label={t('pm.edit')} variant="outline" size="sm" onPress={() => openEdit(p)} />
                  </View>
                </Row>
              </Card>
            );
          })}
        </View>
      )}

      <SheetModal visible={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? t('pm.createTitle') : t('pm.editTitle')}>
        <View style={{ gap: Spacing.md }}>
          <Field label={t('pm.title')} value={title} onChangeText={setTitle} placeholder={t('pm.titlePh')} maxLength={160} />
          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.fieldLabel}>{t('pm.type')}</Text>
            <Row gap={8} style={{ flexWrap: 'wrap' }}>
              {TYPE_CHOICES.map((c) => (
                <Pressable
                  key={c.type}
                  onPress={() => setType(c.type)}
                  accessibilityRole="button"
                  accessibilityLabel={t(c.label)}
                  style={[styles.chip, type === c.type && styles.chipActive]}>
                  <Text style={[styles.chipText, type === c.type && { color: Colors.white, fontWeight: '700' }]}>{t(c.label)}</Text>
                </Pressable>
              ))}
            </Row>
          </View>
          <Field label={t('pm.budget')} value={budget} onChangeText={(v) => setBudget(v.replace(/[^\d]/g, ''))} keyboardType="number-pad" maxLength={9} />
          <Field label={t('pm.description')} value={description} onChangeText={setDescription} placeholder={t('pm.descPh')} multiline maxLength={2000} />
          {formError ? (
            <Card style={{ backgroundColor: Colors.dangerSoft }}>
              <Row gap={Spacing.sm}>
                <Icon name="alert-circle-outline" size={18} color={Colors.danger} />
                <Text style={{ fontSize: FontSize.sm, color: Colors.danger, fontWeight: '600', flex: 1 }}>{formError}</Text>
              </Row>
            </Card>
          ) : null}
          <Btn label={editing === 'new' ? t('pm.create') : t('pm.update')} icon="checkmark" size="lg" loading={busy} onPress={submit} />
        </View>
      </SheetModal>

      <SheetModal visible={perfId !== null} onClose={() => setPerfId(null)} title={t('pm.perfTitle')}>
        {perfFailed ? (
          <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary, textAlign: 'center', paddingVertical: Spacing.md }}>{t('pm.perfErr')}</Text>
        ) : !perf ? (
          <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary, textAlign: 'center', paddingVertical: Spacing.md }}>{t('mkt.loading')}</Text>
        ) : (
          <View>
            <PerfRow label={t('pm.perfImpressions')} value={perf.impressions.toLocaleString()} />
            <View style={styles.divider} />
            <PerfRow label={t('pm.perfClicks')} value={perf.clicks.toLocaleString()} />
            <View style={styles.divider} />
            <PerfRow label={t('pm.perfRedeemed')} value={perf.redeemCount.toLocaleString()} />
            <View style={styles.divider} />
            <PerfRow label={t('pm.perfSpend')} value={tzs(perf.spendTZS)} />
            <View style={styles.divider} />
            <PerfRow label={t('pm.perfRevenue')} value={tzs(perf.attributedRevenueTZS)} />
            <View style={styles.divider} />
            <PerfRow label={t('pm.perfRoi')} value={`${perf.roiPercent.toFixed(1)}%`} />
          </View>
        )}
      </SheetModal>
    </Screen>
  );
}

function PerfRow({ label, value }: { label: string; value: string }) {
  return (
    <Row style={{ justifyContent: 'space-between', paddingVertical: 10 }}>
      <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary }}>{label}</Text>
      <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text }}>{value}</Text>
    </Row>
  );
}

const styles = StyleSheet.create({
  subtitle: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600', flex: 1, paddingRight: Spacing.md },
  dealTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flex: 1, paddingRight: Spacing.md },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border },
  linkBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 4, paddingVertical: 2 },
  linkText: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.info },
  fieldLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '600' },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primaryDark },
  chipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
});
