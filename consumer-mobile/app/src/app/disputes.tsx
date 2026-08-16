import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Btn, Card, Chip, EmptyState, ErrorState, Field, Icon, Pill, Row, Screen, Segmented, SheetModal, SkeletonCard } from '@/components/ui';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t, type I18nKey } from '@/i18n';
import { getBookingsRepository, getDisputesRepository, getOrdersRepository, type DisputeRecord, type DisputeStatus } from '@/repos';
import { track } from '@/lib/analytics';
import { dateISO } from '@/lib/dates';
import { idempotencyKey } from '@/lib/idempotency';
import { useSessionStore } from '@/store/session';
import { ApiError } from '@/api/client';

/** Dispute center (MASTER-BLUEPRINT §18) — mock-first customer dispute API
 * (docs/CONTRACT-ADDITIONS.md #8): the list comes from
 * DisputesRepository.list() and new disputes are raised through
 * DisputesRepository.raise() (GET /disputes/me + POST /disputes are
 * mock-only-until-adopted paths — parity allow-list). The old derivation
 * from disputed order/booking statuses is gone: the mock seeds cover the
 * same data. Support tickets remain a secondary path. */

/** Raise-sheet reason chips — codes stored on the record, labels via i18n
 * ('disputes.reason.{code}'). */
const REASONS: string[] = ['missing_item', 'damaged', 'not_delivered', 'service_not_completed', 'overcharged', 'other'];

const STATUS_TONE: Record<DisputeStatus, 'warning' | 'info' | 'success' | 'neutral'> = {
  open: 'warning',
  resolving: 'info',
  resolved: 'success',
  dismissed: 'neutral',
};

interface ReferenceOption {
  id: string;
  type: 'order' | 'booking';
  label: string;
}

export default function DisputesScreen() {
  const router = useRouter();
  const user = useSessionStore((s) => s.user);
  const [disputes, setDisputes] = useState<DisputeRecord[] | null>(null);
  const [error, setError] = useState('');

  const [raiseOpen, setRaiseOpen] = useState(false);
  const [references, setReferences] = useState<ReferenceOption[] | null>(null);
  const [refType, setRefType] = useState<'order' | 'booking'>('order');
  const [refId, setRefId] = useState('');
  const [reason, setReason] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      setDisputes(await getDisputesRepository().list());
    } catch {
      setError(t('common.error'));
    }
  }, []);

  useEffect(() => {
    load();
    track({ name: 'support_opened' });
  }, [load]);

  /** Open the raise sheet and load recent orders/bookings as the reference
   * picker source — the dispute LIST stays repo-sourced; the picker only
   * targets the raise input (which requires an orderId or bookingId). */
  const openRaise = useCallback(async () => {
    setRaiseOpen(true);
    setFormError('');
    setSubmitted(null);
    setReason('');
    setDescription('');
    setRefId('');
    setReferences(null);
    try {
      const [orders, bookings] = await Promise.all([
        getOrdersRepository().list({ limit: 20 }),
        getBookingsRepository().list({ limit: 20 }),
      ]);
      const options: ReferenceOption[] = [
        ...orders.map((o) => ({ id: o.id, type: 'order' as const, label: o.no ?? o.id })),
        ...bookings.map((b) => ({ id: b.id, type: 'booking' as const, label: b.id })),
      ];
      setReferences(options);
      const first = options.find((o) => o.type === 'order') ?? options[0];
      if (first) {
        setRefType(first.type);
        setRefId(first.id);
      }
    } catch {
      setReferences([]);
    }
  }, []);

  const submit = async () => {
    if (!refId) {
      setFormError(t('disputes.needReference'));
      return;
    }
    if (!reason) {
      setFormError(t('disputes.needReason'));
      return;
    }
    setFormError('');
    setSubmitting(true);
    try {
      const record = await getDisputesRepository().raise(
        {
          orderId: refType === 'order' ? refId : undefined,
          bookingId: refType === 'booking' ? refId : undefined,
          reason,
          description: description.trim(),
        },
        idempotencyKey(user?.id ?? 'customer', 'dispute'),
      );
      setSubmitted(record.id);
      setRaiseOpen(false);
      setDisputes(await getDisputesRepository().list());
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : t('common.error'));
    } finally {
      setSubmitting(false);
    }
  };

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (!disputes) {
    return (
      <Screen>
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={3} />
          <SkeletonCard rows={2} />
        </View>
      </Screen>
    );
  }

  const pickerOptions = (references ?? []).filter((r) => r.type === refType);

  return (
    <Screen>
      <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.title}>{t('disputes.title')}</Text>
          <Btn label={t('disputes.start')} onPress={openRaise} size="sm" icon="add" />
        </Row>
        <Text style={styles.sub}>{t('disputes.sub')}</Text>
      </View>
      {submitted ? (
        <View style={styles.successBanner}>
          <Text style={styles.successText}>
            {t('disputes.submitted')} {t('disputes.reference')}: {submitted}
          </Text>
        </View>
      ) : null}
      <ScrollView contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }} showsVerticalScrollIndicator={false}>
        {disputes.length === 0 ? (
          <EmptyState
            icon="shield-outline"
            title={t('disputes.empty')}
            sub={t('disputes.emptySub')}
            actionLabel={t('disputes.start')}
            onAction={openRaise}
          />
        ) : (
          <View style={{ gap: Spacing.md }}>
            {disputes.map((d) => (
              <Card
                key={d.id}
                style={styles.card}
                onPress={() => router.push(d.referenceType === 'order' ? `/order/${d.referenceId}` : `/booking/${d.referenceId}`)}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Row gap={Spacing.md} style={{ flex: 1 }}>
                    <View style={styles.typeIcon}>
                      <Icon name={d.referenceType === 'order' ? 'receipt-outline' : 'construct-outline'} size={17} color={Colors.warning} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.subject} numberOfLines={1}>{d.referenceId}</Text>
                      <Text style={styles.meta}>
                        {t(`disputes.reason.${d.reason}` as I18nKey)} · {dateISO(d.createdAt)}
                      </Text>
                    </View>
                  </Row>
                  <Pill label={t(`disputes.status.${d.status}` as I18nKey)} tone={STATUS_TONE[d.status]} />
                </Row>
                {d.resolution ? (
                  <Text style={styles.resolution}>
                    {t('disputes.resolution', { outcome: d.resolution.outcome })} · {dateISO(d.resolution.at)}
                  </Text>
                ) : null}
              </Card>
            ))}
          </View>
        )}
        <Pressable onPress={() => router.push('/support')} accessibilityRole="button" hitSlop={8} style={{ marginTop: Spacing.lg, alignSelf: 'center' }}>
          <Text style={styles.supportLink}>{t('disputes.supportLink')}</Text>
        </Pressable>
      </ScrollView>

      <SheetModal visible={raiseOpen} onClose={() => setRaiseOpen(false)} title={t('disputes.raise')}>
        <Text style={styles.sheetLabel}>{t('disputes.pickReference')}</Text>
        <Segmented
          options={[
            { key: 'order' as const, label: t('activity.orders') },
            { key: 'booking' as const, label: t('activity.bookings') },
          ]}
          value={refType}
          onChange={(k) => {
            setRefType(k);
            const first = (references ?? []).find((r) => r.type === k);
            setRefId(first?.id ?? '');
          }}
        />
        {references === null ? (
          <SkeletonCard rows={1} />
        ) : pickerOptions.length === 0 ? (
          <Text style={styles.meta}>{t('disputes.noReferences')}</Text>
        ) : (
          <View style={styles.chipRow}>
            {pickerOptions.map((r) => (
              <Chip key={r.id} label={r.label} selected={refId === r.id} onPress={() => setRefId(r.id)} />
            ))}
          </View>
        )}
        <Text style={styles.sheetLabel}>{t('disputes.reason')}</Text>
        <View style={styles.chipRow}>
          {REASONS.map((r) => (
            <Chip key={r} label={t(`disputes.reason.${r}` as I18nKey)} selected={reason === r} onPress={() => setReason(r)} />
          ))}
        </View>
        <Field
          label={t('disputes.description')}
          value={description}
          onChangeText={setDescription}
          multiline
          maxLength={1000}
          placeholder={t('disputes.descriptionPlaceholder')}
        />
        {formError ? <Text style={styles.error}>{formError}</Text> : null}
        <Btn label={t('disputes.start')} onPress={submit} size="lg" loading={submitting} style={{ marginTop: Spacing.md }} />
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text, marginBottom: Spacing.xs },
  sub: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sans, marginBottom: Spacing.md },
  card: { marginBottom: Spacing.md },
  typeIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  subject: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 4 },
  resolution: { fontSize: FontSize.xs, color: Colors.success, fontFamily: Fonts.sansSemibold, marginTop: 6 },
  supportLink: { fontSize: FontSize.sm, color: Colors.primaryDeep, fontFamily: Fonts.sansSemibold, textDecorationLine: 'underline' },
  successBanner: { marginHorizontal: Spacing.lg, marginBottom: Spacing.sm, backgroundColor: Colors.successSoft, borderRadius: 10, padding: Spacing.md },
  successText: { color: Colors.success, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold },
  sheetLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sansSemibold, marginBottom: Spacing.sm, marginTop: Spacing.lg },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginTop: Spacing.xs },
  error: { color: Colors.danger, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, marginTop: Spacing.sm },
});
