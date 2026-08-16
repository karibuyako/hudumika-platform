import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { t, onLocaleChange, type I18nKey } from '@/i18n';
import type { CouponCampaignInput, CouponCampaignKind, CouponStats } from '@/api/types';
import { Btn, Card, Empty, Field, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { dayLabel, tzs } from '@/lib/format';
import { useMarketingStore } from '@/store/marketing';

const KIND_CHOICES: { kind: CouponCampaignKind; label: I18nKey }[] = [
  { kind: 'fixed', label: 'cc.kindFixed' },
  { kind: 'percentage', label: 'cc.kindPercentage' },
  { kind: 'shipping', label: 'cc.kindShipping' },
];

export default function CouponCampaignsScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const coupons = useMarketingStore((s) => s.couponCampaigns);
  const hydrate = useMarketingStore((s) => s.hydrateCouponCampaigns);
  const create = useMarketingStore((s) => s.createCouponCampaign);
  const couponStatsOf = useMarketingStore((s) => s.couponStatsOf);

  const [showNew, setShowNew] = useState(false);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<CouponCampaignKind>('fixed');
  const [discount, setDiscount] = useState('');
  const [minSpend, setMinSpend] = useState('');
  const [quantity, setQuantity] = useState('');
  const [validDays, setValidDays] = useState('14');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [stats, setStats] = useState<Record<string, CouponStats>>({});
  const [statsOpen, setStatsOpen] = useState<string | null>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const openStats = async (id: string) => {
    setStatsOpen(id);
    const s = await couponStatsOf(id);
    if (s) setStats((prev) => ({ ...prev, [id]: s }));
  };

  const submit = async () => {
    const discountTZS = discount ? Math.round(Number(discount.replace(/[^\d]/g, ''))) : 0;
    const minimumSpendTZS = minSpend ? Math.round(Number(minSpend.replace(/[^\d]/g, ''))) : 0;
    const qty = quantity ? Math.round(Number(quantity.replace(/[^\d]/g, ''))) : 0;
    const days = validDays ? Math.round(Number(validDays.replace(/[^\d]/g, ''))) || 14 : 14;
    if (!title.trim()) return setFormError(t('cc.errTitle'));
    if (!qty || qty < 1) return setFormError(t('cc.errQuantity'));
    if (kind !== 'shipping' && discountTZS <= 0) return setFormError(t('cc.errDiscount'));
    const input: CouponCampaignInput = {
      title: title.trim(),
      kind,
      discountTZS,
      minimumSpendTZS,
      quantity: qty,
      validUntil: Date.now() + days * 86400000,
    };
    setBusy(true);
    const res = await create(input);
    setBusy(false);
    if (res.ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setShowNew(false);
      setTitle('');
      setDiscount('');
      setMinSpend('');
      setQuantity('');
      setFormError(null);
    } else {
      setFormError(res.message ?? t('pm.errCreate'));
    }
  };

  return (
    <Screen scroll>
      <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.sm }}>
        <Text style={styles.subtitle}>{t('cc.subtitle')}</Text>
        <Btn label={t('cc.new')} icon="add" size="sm" onPress={() => setShowNew(true)} />
      </Row>

      {coupons.length === 0 ? (
        <Empty icon="ticket-outline" title={t('cc.empty')} sub={t('cc.emptySub')} />
      ) : (
        <View style={{ gap: Spacing.md }}>
          {coupons.map((c) => {
            const remaining = Math.max(0, c.quantity - c.claimedCount);
            const progress = c.quantity > 0 ? Math.min(1, c.claimedCount / c.quantity) : 0;
            const stat = stats[c.id];
            return (
              <Card key={c.id} style={{ gap: Spacing.sm }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={styles.dealTitle} numberOfLines={2}>{c.title}</Text>
                  <Pill label={t(c.status === 'live' ? 'mkt.active' : c.status === 'ended' ? 'mkt.ended' : 'pm.statusDraft')} tone={c.status === 'live' ? 'success' : 'neutral'} />
                </Row>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 16 }}>
                  {c.kind === 'shipping'
                    ? t('cc.kindShipping')
                    : c.kind === 'percentage'
                      ? `${(c.discountRateBps ?? 0) / 100}% off`
                      : `${tzs(c.discountTZS)} off`}
                  {c.minimumSpendTZS > 0 ? ` · ${t('cc.minSpend')}: ${tzs(c.minimumSpendTZS)}` : ''}
                  {` · ${t('cc.expires', { date: dayLabel(c.validUntil) })}`}
                </Text>
                <View>
                  <View style={styles.progressTrack}>
                    <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
                  </View>
                  <Row style={{ justifyContent: 'space-between', marginTop: 6 }}>
                    <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                      {t('cc.claimedOf', { claimed: c.claimedCount, quantity: c.quantity })}
                    </Text>
                    <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                      {t('cc.remaining', { n: remaining })}
                    </Text>
                  </Row>
                </View>
                <Pressable
                  onPress={() => openStats(c.id)}
                  accessibilityRole="button"
                  accessibilityLabel={t('pm.perf')}
                  style={styles.linkBtn}>
                  <Icon name="analytics-outline" size={14} color={Colors.info} />
                  <Text style={styles.linkText}>{t('pm.perf')}</Text>
                </Pressable>
                {statsOpen === c.id ? (
                  stat ? (
                    <Card style={{ backgroundColor: Colors.surface, gap: Spacing.xs }}>
                      <Row style={{ justifyContent: 'space-between' }}>
                        <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary }}>{t('cc.statsClaimed')}</Text>
                        <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text }}>{stat.claimed}</Text>
                      </Row>
                      <Row style={{ justifyContent: 'space-between' }}>
                        <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary }}>{t('cc.statsUsed')}</Text>
                        <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text }}>{stat.used}</Text>
                      </Row>
                      <Row style={{ justifyContent: 'space-between' }}>
                        <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary }}>{t('cc.statsConversion')}</Text>
                        <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.success }}>
                          {stat.conversionRate.toFixed(1)}%
                        </Text>
                      </Row>
                    </Card>
                  ) : (
                    <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('mkt.loading')}</Text>
                  )
                ) : null}
              </Card>
            );
          })}
        </View>
      )}

      <SheetModal visible={showNew} onClose={() => setShowNew(false)} title={t('cc.new')}>
        <View style={{ gap: Spacing.md }}>
          <Field label={t('cc.title')} value={title} onChangeText={setTitle} placeholder={t('cc.titlePh')} maxLength={160} />
          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.fieldLabel}>{t('cc.kind')}</Text>
            <Row gap={8} style={{ flexWrap: 'wrap' }}>
              {KIND_CHOICES.map((k) => (
                <Pressable
                  key={k.kind}
                  onPress={() => setKind(k.kind)}
                  accessibilityRole="button"
                  accessibilityLabel={t(k.label)}
                  style={[styles.chip, kind === k.kind && styles.chipActive]}>
                  <Text style={[styles.chipText, kind === k.kind && { color: Colors.white, fontWeight: '700' }]}>{t(k.label)}</Text>
                </Pressable>
              ))}
            </Row>
          </View>
          {kind !== 'shipping' ? (
            <Field
              label={kind === 'percentage' ? t('cc.discountRate') : t('cc.discount')}
              value={discount}
              onChangeText={(v) => setDiscount(v.replace(/[^\d]/g, ''))}
              keyboardType="number-pad"
              maxLength={9}
            />
          ) : null}
          <Field label={t('cc.minSpend')} value={minSpend} onChangeText={(v) => setMinSpend(v.replace(/[^\d]/g, ''))} keyboardType="number-pad" maxLength={9} />
          <Field label={t('cc.quantity')} value={quantity} onChangeText={(v) => setQuantity(v.replace(/[^\d]/g, ''))} keyboardType="number-pad" maxLength={6} />
          <Field label={t('cc.validDays')} value={validDays} onChangeText={(v) => setValidDays(v.replace(/[^\d]/g, ''))} keyboardType="number-pad" maxLength={3} />
          {formError ? (
            <Card style={{ backgroundColor: Colors.dangerSoft }}>
              <Row gap={Spacing.sm}>
                <Icon name="alert-circle-outline" size={18} color={Colors.danger} />
                <Text style={{ fontSize: FontSize.sm, color: Colors.danger, fontWeight: '600', flex: 1 }}>{formError}</Text>
              </Row>
            </Card>
          ) : null}
          <Btn label={t('cc.create')} icon="checkmark" size="lg" loading={busy} onPress={submit} />
        </View>
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  subtitle: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600', flex: 1, paddingRight: Spacing.md },
  dealTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flex: 1, paddingRight: Spacing.md },
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
  progressTrack: { height: 6, borderRadius: 3, backgroundColor: Colors.surface, overflow: 'hidden' },
  progressFill: { height: 6, borderRadius: 3, backgroundColor: Colors.primary },
});
