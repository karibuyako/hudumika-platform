import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { api } from '@/api/client';
import type { PrecisionCampaign, PrecisionCampaignInput, PrecisionOffer, PrecisionStatus, SegmentRow } from '@/api/types';
import { Btn, Card, Empty, Field, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { useMarketingStore } from '@/store/marketing';

const STATUS_META: Record<PrecisionStatus, { label: I18nKey; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  draft: { label: 'pr.statusDraft', tone: 'neutral' },
  sent: { label: 'pr.statusSent', tone: 'success' },
  active: { label: 'pr.statusActive', tone: 'info' },
  ended: { label: 'pr.statusEnded', tone: 'neutral' },
};

const OFFER_CHOICES: { type: PrecisionOffer['type']; label: I18nKey }[] = [
  { type: 'coupon', label: 'pr.offerCoupon' },
  { type: 'discount', label: 'pr.offerDiscount' },
  { type: 'message', label: 'pr.offerMessage' },
];

/** Rule-builder chips — the editor writes the exact rule keys the API accepts. */
const SPEND_CHOICES = [50000, 100000, 150000];
const RECENCY_CHOICES = [7, 30, 60];
const ORDER_CHOICES = [2, 5, 10];

export default function PrecisionScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const precision = useMarketingStore((s) => s.precision);
  const loading = useMarketingStore((s) => s.loading);
  const error = useMarketingStore((s) => s.error);
  const hydratePrecision = useMarketingStore((s) => s.hydratePrecision);
  const createPrecision = useMarketingStore((s) => s.createPrecision);
  const sendPrecision = useMarketingStore((s) => s.sendPrecision);

  const [segments, setSegments] = useState<SegmentRow[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState('');
  const [segmentId, setSegmentId] = useState<string>('');
  const [offerType, setOfferType] = useState<PrecisionOffer['type']>('coupon');
  const [offerValue, setOfferValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  /* Segment editor (rule builder) */
  const [showSegment, setShowSegment] = useState(false);
  const [segName, setSegName] = useState('');
  const [segSpend, setSegSpend] = useState<number | null>(null);
  const [segRecency, setSegRecency] = useState<number | null>(null);
  const [segOrders, setSegOrders] = useState<number | null>(null);
  const [segPriceTag, setSegPriceTag] = useState('');
  const [segError, setSegError] = useState<string | null>(null);

  const loadSegments = () => {
    api
      .get<{ segments: SegmentRow[] }>('/segments', { retries: 1 })
      .then((r) => setSegments(r.segments))
      .catch(() => {
        /* segments stay empty */
      });
  };

  useEffect(() => {
    hydratePrecision();
    loadSegments();
  }, [hydratePrecision]);

  const openNew = () => {
    setName('');
    setSegmentId(segments[0]?.id ?? '');
    setOfferType('coupon');
    setOfferValue('');
    setFormError(null);
    setShowNew(true);
  };

  const submit = async () => {
    if (!name.trim()) return setFormError(t('pr.errName'));
    if (!segmentId) return setFormError(t('pr.errSegment'));
    const input: PrecisionCampaignInput = {
      name: name.trim(),
      segmentId,
      offer: { type: offerType, value: offerValue.trim() ? offerValue.trim() : undefined },
    };
    setBusy(true);
    const res = await createPrecision(input);
    setBusy(false);
    if (res.ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setShowNew(false);
    } else {
      setFormError(res.message ?? t('pr.errCreate'));
    }
  };

  const doSend = async (c: PrecisionCampaign) => {
    const res = await sendPrecision(c.id);
    if (res.ok) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const openSegmentEditor = () => {
    setSegName('');
    setSegSpend(null);
    setSegRecency(null);
    setSegOrders(null);
    setSegPriceTag('');
    setSegError(null);
    setShowSegment(true);
  };

  const createSegment = async () => {
    const rules: Record<string, unknown> = {};
    if (segSpend !== null) rules.minSpendTZS = segSpend;
    if (segRecency !== null) rules.recencyDays = segRecency;
    if (segOrders !== null) rules.minOrders = segOrders;
    if (segPriceTag.trim()) rules.priceTag = segPriceTag.trim();
    if (!segName.trim()) return setSegError(t('pr.errName'));
    if (Object.keys(rules).length === 0) return setSegError(t('pr.errSegment'));
    setBusy(true);
    try {
      const res = await api.post<{ segment: SegmentRow }>('/segments', { name: segName.trim(), rules }, { idempotencyKey: `seg:${Date.now()}` });
      loadSegments();
      setSegmentId(res.segment.id);
      setShowSegment(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      setSegError(err.message ?? t('pr.errCreate'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll>
      <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.sm }}>
        <Text style={styles.subtitle}>{t('pr.subtitle')}</Text>
        <Btn label={t('pr.new')} icon="add" size="sm" onPress={openNew} />
      </Row>

      {error ? (
        <Card style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.xl }}>
          <Icon name="cloud-offline-outline" size={22} color={Colors.textTertiary} />
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('pr.errLoad')}</Text>
          <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => hydratePrecision()} />
        </Card>
      ) : loading && precision.length === 0 ? (
        <Card style={{ alignItems: 'center', paddingVertical: Spacing.xl }}>
          <Icon name="time-outline" size={22} color={Colors.textTertiary} />
          <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary, marginTop: Spacing.sm }}>{t('mkt.loading')}</Text>
        </Card>
      ) : precision.length === 0 ? (
        <Empty icon="people-outline" title={t('pr.empty')} sub={t('pr.emptySub')} />
      ) : (
        <View style={{ gap: Spacing.md }}>
          {precision.map((c) => {
            const meta = STATUS_META[c.status];
            return (
              <Card key={c.id} style={{ gap: Spacing.sm }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={styles.dealTitle} numberOfLines={2}>{c.name}</Text>
                  <Pill label={t(meta.label)} tone={meta.tone} />
                </Row>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 16 }}>
                  {t('pr.segmentLine', { segment: c.segmentLabel ?? c.segmentId, offer: c.offer.type })}
                  {c.offer.value ? ` · ${c.offer.value}` : ''}
                </Text>
                <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                    {c.status === 'sent' ? t('pr.sent', { n: c.sentCount }) : t('pr.notSent')}
                  </Text>
                  {c.status === 'draft' ? (
                    <Btn label={t('pr.send')} icon="send-outline" size="sm" onPress={() => doSend(c)} />
                  ) : null}
                </Row>
              </Card>
            );
          })}
        </View>
      )}

      <SheetModal visible={showNew} onClose={() => setShowNew(false)} title={t('pr.newTitle')}>
        <View style={{ gap: Spacing.md }}>
          <Field label={t('pr.name')} value={name} onChangeText={setName} placeholder={t('pr.namePh')} maxLength={80} />
          <View style={{ gap: Spacing.xs }}>
            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={styles.fieldLabel}>{t('pr.segment')}</Text>
              <Btn label={t('pr.newSegment')} icon="add" variant="outline" size="sm" onPress={openSegmentEditor} />
            </Row>
            <Row gap={8} style={{ flexWrap: 'wrap' }}>
              {segments.map((s) => (
                <Pressable
                  key={s.id}
                  onPress={() => setSegmentId(s.id)}
                  accessibilityRole="button"
                  accessibilityLabel={s.label}
                  style={[styles.chip, segmentId === s.id && styles.chipActive]}>
                  <Text style={[styles.chipText, segmentId === s.id && { color: Colors.white, fontWeight: '700' }]}>
                    {s.label} · {s.memberCount ?? s.count}
                  </Text>
                </Pressable>
              ))}
            </Row>
          </View>
          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.fieldLabel}>{t('pr.offerType')}</Text>
            <Row gap={8} style={{ flexWrap: 'wrap' }}>
              {OFFER_CHOICES.map((o) => (
                <Pressable
                  key={o.type}
                  onPress={() => setOfferType(o.type)}
                  accessibilityRole="button"
                  accessibilityLabel={t(o.label)}
                  style={[styles.chip, offerType === o.type && styles.chipActive]}>
                  <Text style={[styles.chipText, offerType === o.type && { color: Colors.white, fontWeight: '700' }]}>{t(o.label)}</Text>
                </Pressable>
              ))}
            </Row>
          </View>
          <Field label={t('pr.offerValue')} value={offerValue} onChangeText={setOfferValue} placeholder={t('pr.offerValuePh')} maxLength={80} />
          {formError ? (
            <Card style={{ backgroundColor: Colors.dangerSoft }}>
              <Row gap={Spacing.sm}>
                <Icon name="alert-circle-outline" size={18} color={Colors.danger} />
                <Text style={{ fontSize: FontSize.sm, color: Colors.danger, fontWeight: '600', flex: 1 }}>{formError}</Text>
              </Row>
            </Card>
          ) : null}
          <Btn label={t('pr.create')} icon="checkmark" size="lg" loading={busy} onPress={submit} />
        </View>
      </SheetModal>

      <SheetModal visible={showSegment} onClose={() => setShowSegment(false)} title={t('pr.newSegment')}>
        <View style={{ gap: Spacing.md }}>
          <Field label={t('pr.segName')} value={segName} onChangeText={setSegName} placeholder={t('pr.segNamePh')} maxLength={80} />
          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.fieldLabel}>{t('pr.segRules')}</Text>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('pr.segRuleSpend', { n: segSpend ?? SPEND_CHOICES[1] })}</Text>
            <Row gap={8} style={{ flexWrap: 'wrap' }}>
              {SPEND_CHOICES.map((v) => (
                <Pressable key={v} onPress={() => setSegSpend(segSpend === v ? null : v)} accessibilityRole="button" style={[styles.chip, segSpend === v && styles.chipActive]}>
                  <Text style={[styles.chipText, segSpend === v && { color: Colors.white, fontWeight: '700' }]}>TZS {v.toLocaleString('en-US')}+</Text>
                </Pressable>
              ))}
            </Row>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('pr.segRuleRecency', { n: segRecency ?? RECENCY_CHOICES[1] })}</Text>
            <Row gap={8} style={{ flexWrap: 'wrap' }}>
              {RECENCY_CHOICES.map((v) => (
                <Pressable key={v} onPress={() => setSegRecency(segRecency === v ? null : v)} accessibilityRole="button" style={[styles.chip, segRecency === v && styles.chipActive]}>
                  <Text style={[styles.chipText, segRecency === v && { color: Colors.white, fontWeight: '700' }]}>{v}d</Text>
                </Pressable>
              ))}
            </Row>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('pr.segRuleOrders', { n: segOrders ?? ORDER_CHOICES[1] })}</Text>
            <Row gap={8} style={{ flexWrap: 'wrap' }}>
              {ORDER_CHOICES.map((v) => (
                <Pressable key={v} onPress={() => setSegOrders(segOrders === v ? null : v)} accessibilityRole="button" style={[styles.chip, segOrders === v && styles.chipActive]}>
                  <Text style={[styles.chipText, segOrders === v && { color: Colors.white, fontWeight: '700' }]}>{v}+</Text>
                </Pressable>
              ))}
            </Row>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('pr.segRulePriceTag', { tag: segPriceTag.trim() || '…' })}</Text>
            <Field label={t('pr.segPriceTagLabel')} value={segPriceTag} onChangeText={setSegPriceTag} placeholder="BBQ" maxLength={40} />
          </View>
          {segError ? (
            <Card style={{ backgroundColor: Colors.dangerSoft }}>
              <Row gap={Spacing.sm}>
                <Icon name="alert-circle-outline" size={18} color={Colors.danger} />
                <Text style={{ fontSize: FontSize.sm, color: Colors.danger, fontWeight: '600', flex: 1 }}>{segError}</Text>
              </Row>
            </Card>
          ) : null}
          <Btn label={t('pr.segCreate')} icon="checkmark" size="lg" loading={busy} onPress={createSegment} />
        </View>
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  subtitle: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600', flex: 1, paddingRight: Spacing.md },
  dealTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flex: 1, paddingRight: Spacing.md },
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
