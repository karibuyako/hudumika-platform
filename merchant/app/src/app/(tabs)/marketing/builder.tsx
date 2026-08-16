import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Icon, IconName, Row } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { dayLabel, tzs } from '@/lib/format';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { useCampaignStore } from '@/store/campaigns';
import { useCatalogStore } from '@/store/catalog';
import type { CampaignType } from '@/types';

const TYPES: { type: CampaignType; icon: IconName; label: I18nKey; desc: I18nKey; tint: string }[] = [
  { type: 'discount', icon: 'pricetag-outline', label: 'mkt.typeDiscount', desc: 'mktb.descDiscount', tint: Colors.warning },
  { type: 'coupon', icon: 'ticket-outline', label: 'mkt.typeCoupon', desc: 'mktb.descCoupon', tint: Colors.info },
  { type: 'flash', icon: 'flash-outline', label: 'mkt.typeFlash', desc: 'mktb.descFlash', tint: 'Colors.violet' },
  { type: 'full_reduction', icon: 'layers-outline', label: 'mkt.typeFullReduction', desc: 'mktb.descFullReduction', tint: Colors.danger },
  { type: 'new_customer', icon: 'person-add-outline', label: 'mkt.typeNewCustomer', desc: 'mktb.descNewCustomer', tint: Colors.warning },
  { type: 'free_delivery', icon: 'bicycle-outline', label: 'mkt.typeFreeDelivery', desc: 'mktb.descFreeDelivery', tint: Colors.success },
  { type: 'group_buy', icon: 'people-outline', label: 'mkt.typeGroupBuy', desc: 'mktb.descGroupBuy', tint: Colors.warning },
  { type: 'haggle', icon: 'chatbubble-ellipses-outline', label: 'mkt.typeHaggle', desc: 'mktb.descHaggle', tint: Colors.danger },
  { type: 'featured', icon: 'star-outline', label: 'mkt.typeFeatured', desc: 'mktb.descFeatured', tint: Colors.gold },
  { type: 'ppc', icon: 'search-outline', label: 'mkt.typePpc', desc: 'mktb.descPpc', tint: Colors.info },
  { type: 'brand', icon: 'diamond-outline', label: 'mkt.typeBrand', desc: 'mktb.descBrand', tint: 'Colors.violet' },
  { type: 'instant_discount', icon: 'pricetag-outline', label: 'mkt.typeInstant', desc: 'mktb.descInstant', tint: Colors.danger },
];

const BUDGETS = [100, 300, 500, 1000];
const DURATIONS: { label: I18nKey; value: number }[] = [
  { label: 'mktb.day1', value: 1 },
  { label: 'mktb.day3', value: 3 },
  { label: 'mktb.day7', value: 7 },
  { label: 'mktb.day14', value: 14 },
];

const REDUCTION_CHOICES = [
  { spend: 60, save: 8 },
  { spend: 80, save: 12 },
  { spend: 120, save: 20 },
];

export default function CampaignBuilderScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const createCampaign = useCampaignStore((s) => s.createCampaign);
  const products = useCatalogStore((s) => s.products);
  const [step, setStep] = useState(0);
  const [type, setType] = useState<CampaignType>('coupon');
  const [budget, setBudget] = useState(300);
  const [budgetCustom, setBudgetCustom] = useState('');
  const [days, setDays] = useState(3);
  const [discountRate, setDiscountRate] = useState(0.8);
  const [couponAmount, setCouponAmount] = useState('20');
  const [reduction, setReduction] = useState(REDUCTION_CHOICES[1]);
  const [target, setTarget] = useState('All customers');
  const [picked, setPicked] = useState<string[]>([]);
  const [published, setPublished] = useState(false);
  const [groupBuyTiers, setGroupBuyTiers] = useState<{ buyers: number; discountRate: number }[]>([{ buyers: 10, discountRate: 0.8 }]);
  const [cpc, setCpc] = useState(1);

  const targetOptions: { value: string; label: I18nKey }[] = [
    { value: 'All customers', label: 'mktb.tgtAll' },
    { value: 'New customers within 3 km', label: 'mktb.tgtNew' },
    { value: 'Repeat customers (2+ orders)', label: 'mktb.tgtRepeat' },
    { value: 'Users searching "BBQ"', label: 'mktb.tgtSearch' },
  ];
  const finalBudget = budgetCustom ? Number(budgetCustom) || budget : budget;
  const titleMap: Record<CampaignType, string> = {
    discount: `${Math.round((1 - discountRate) * 100)}% off storewide`,
    coupon: `TZS ${couponAmount} off orders over TZS ${Number(couponAmount) * 3}`,
    flash: `Flash sale · ${picked.length ? `${picked.length} items` : 'storewide'}`,
    full_reduction: `Full reduction · TZS ${reduction.save} off TZS ${reduction.spend}+`,
    new_customer: `First order · ${Math.round((1 - (discountRate + 0.1) * 0.5) * 100)}% off up to TZS ${couponAmount}`,
    free_delivery: `Free delivery · orders over TZS ${reduction.spend}`,
    group_buy: `Group buy · ${groupBuyTiers.length} tier${groupBuyTiers.length === 1 ? '' : 's'}`,
    haggle: 'Haggle · customer-price negotiation',
    featured: 'Featured · homepage slot',
    ppc: `DianJin PPC · TZS ${cpc}/click`,
    brand: 'Brand display campaign',
    instant_discount: `Instant ${Math.round((1 - discountRate) * 100)}% off storewide`,
  };
    // eslint-disable-next-line react-hooks/purity
  const start = Date.now() + 3600000;
  const end = start + days * 86400000;

  const togglePick = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const publish = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    createCampaign({
      type,
      title: titleMap[type],
      budget: finalBudget,
      start,
      end,
      discountRate: type === 'discount' || type === 'new_customer' || type === 'instant_discount' ? discountRate : undefined,
      couponAmount: type === 'coupon' || type === 'new_customer' ? Number(couponAmount) || 20 : undefined,
      threshold: type === 'full_reduction' || type === 'free_delivery' ? reduction.spend : undefined,
      target,
      productIds: picked,
      groupBuyTargets: type === 'group_buy' ? groupBuyTiers : undefined,
      haggleEnabled: type === 'haggle' ? true : undefined,
      cpc: type === 'ppc' ? cpc : undefined,
    });
    setPublished(true);
    setTimeout(() => router.back(), 900);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => (step === 0 ? router.back() : setStep(step - 1))} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('mktb.title', { n: step + 1 })}</Text>
        <View style={{ width: 26 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: Spacing.lg, gap: Spacing.md, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        {step === 0 ? (
          <View style={{ gap: Spacing.md }}>
            {TYPES.map((tp) => (
              <Pressable key={tp.type} onPress={() => setType(tp.type)} style={[styles.typeCard, type === tp.type && styles.typeCardActive]}>
                <View style={[styles.typeIcon, { backgroundColor: `${tp.tint}1A` }]}>
                  <Icon name={tp.icon} size={22} color={tp.tint} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.typeLabel}>{t(tp.label)}</Text>
                  <Text style={styles.typeDesc}>{t(tp.desc)}</Text>
                </View>
                <View style={[styles.radio, type === tp.type && styles.radioActive]}>
                  {type === tp.type ? <View style={styles.radioDot} /> : null}
                </View>
              </Pressable>
            ))}
          </View>
        ) : step === 1 ? (
          <View style={{ gap: Spacing.md }}>
            <Card style={{ gap: Spacing.md }}>
              <Text style={styles.sectionLabel}>{t('mktb.budget')}</Text>
              <Row gap={8} style={{ flexWrap: 'wrap' }}>
                {BUDGETS.map((b) => (
                  <Pressable
                    key={b}
                    onPress={() => {
                      setBudget(b);
                      setBudgetCustom('');
                    }}
                    style={[styles.chip, budget === b && !budgetCustom && styles.chipActive]}>
                    <Text style={[styles.chipText, budget === b && !budgetCustom && { color: Colors.text, fontWeight: '700' }]}>{b}</Text>
                  </Pressable>
                ))}
              </Row>
              <TextInput
                value={budgetCustom}
                onChangeText={setBudgetCustom}
                placeholder={t('mktb.customAmount')}
                placeholderTextColor={Colors.textTertiary}
                keyboardType="number-pad"
                style={styles.input}
              />
            </Card>

            <Card style={{ gap: Spacing.md }}>
              <Text style={styles.sectionLabel}>{t('mktb.duration')}</Text>
              <Row gap={8} style={{ flexWrap: 'wrap' }}>
                {DURATIONS.map((d) => (
                  <Pressable
                    key={d.value}
                    onPress={() => setDays(d.value)}
                    style={[styles.chip, days === d.value && styles.chipActive]}>
                    <Text style={[styles.chipText, days === d.value && { color: Colors.text, fontWeight: '700' }]}>{t(d.label)}</Text>
                  </Pressable>
                ))}
              </Row>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                {t('mktb.window', { start: dayLabel(start), end: dayLabel(end) })}
              </Text>
            </Card>

            <Card style={{ gap: Spacing.md }}>
              <Text style={styles.sectionLabel}>{t('mktb.targeting')}</Text>
              {targetOptions.map((o) => (
                <Pressable key={o.value} onPress={() => setTarget(o.value)} style={[styles.targetRow, target === o.value && styles.targetActive]}>
                  <Text style={{ fontSize: FontSize.md, color: target === o.value ? Colors.text : Colors.textSecondary }}>{t(o.label)}</Text>
                  {target === o.value ? <Icon name="checkmark-circle" size={17} color={Colors.success} /> : null}
                </Pressable>
              ))}
            </Card>

            {type === 'discount' ? (
              <Card style={{ gap: Spacing.md }}>
                <Text style={styles.sectionLabel}>{t('mktb.discountLevel', { pct: Math.round((1 - discountRate) * 100) })}</Text>
                <Row gap={8}>
                  {[0.6, 0.7, 0.8, 0.9].map((r) => (
                    <Pressable
                      key={r}
                      onPress={() => setDiscountRate(r)}
                      style={[styles.chip, discountRate === r && styles.chipActive]}>
                      <Text style={[styles.chipText, discountRate === r && { color: Colors.text, fontWeight: '700' }]}>
                        {t('mktb.pctOff', { pct: Math.round((1 - r) * 100) })}
                      </Text>
                    </Pressable>
                  ))}
                </Row>
              </Card>
            ) : null}
            {type === 'coupon' ? (
              <Card style={{ gap: Spacing.md }}>
                <Text style={styles.sectionLabel}>{t('mktb.couponValue')}</Text>
                <Row gap={8}>
                  {['10', '15', '20', '30'].map((a) => (
                    <Pressable
                      key={a}
                      onPress={() => setCouponAmount(a)}
                      style={[styles.chip, couponAmount === a && styles.chipActive]}>
                      <Text style={[styles.chipText, couponAmount === a && { color: Colors.text, fontWeight: '700' }]}>{a}</Text>
                    </Pressable>
                  ))}
                </Row>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                  {t('mktb.validOver', { n: Number(couponAmount) * 3 })}
                </Text>
              </Card>
            ) : null}
            {type === 'full_reduction' || type === 'free_delivery' ? (
              <Card style={{ gap: Spacing.md }}>
                <Text style={styles.sectionLabel}>
                  {type === 'full_reduction' ? t('mktb.spendThreshold') : t('mktb.minCart')}
                </Text>
                {REDUCTION_CHOICES.map((r) => (
                  <Pressable
                    key={r.spend}
                    onPress={() => setReduction(r)}
                    style={[styles.targetRow, reduction.spend === r.spend && styles.targetActive]}>
                    <Text style={{ fontSize: FontSize.md, color: Colors.text }}>
                      {type === 'full_reduction'
                        ? t('mktb.spendSave', { a: r.spend, b: r.save })
                        : t('mktb.freeOver', { a: r.spend })}
                    </Text>
                    {reduction.spend === r.spend ? <Icon name="checkmark-circle" size={17} color={Colors.success} /> : null}
                  </Pressable>
                ))}
              </Card>
            ) : null}
            {type === 'instant_discount' ? (
              <Card style={{ gap: Spacing.md }}>
                <Text style={styles.sectionLabel}>{t('mktb.instantLevel', { pct: Math.round((1 - discountRate) * 100) })}</Text>
                <Row gap={8}>
                  {[0.7, 0.8, 0.9].map((r) => (
                    <Pressable
                      key={r}
                      onPress={() => setDiscountRate(r)}
                      style={[styles.chip, discountRate === r && styles.chipActive]}>
                      <Text style={[styles.chipText, discountRate === r && { color: Colors.text, fontWeight: '700' }]}>
                        {t('mktb.pctOff', { pct: Math.round((1 - r) * 100) })}
                      </Text>
                    </Pressable>
                  ))}
                </Row>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                  {t('mktb.instantHint')}
                </Text>
              </Card>
            ) : null}
            {type === 'instant_discount' ? (
              <Card style={{ gap: Spacing.md }}>
                <Text style={styles.sectionLabel}>{t('mktb.instantLevel', { pct: Math.round((1 - discountRate) * 100) })}</Text>
                <Row gap={8}>
                  {[0.7, 0.8, 0.9].map((r) => (
                    <Pressable
                      key={r}
                      onPress={() => setDiscountRate(r)}
                      style={[styles.chip, discountRate === r && styles.chipActive]}>
                      <Text style={[styles.chipText, discountRate === r && { color: Colors.text, fontWeight: '700' }]}>
                        {t('mktb.pctOff', { pct: Math.round((1 - r) * 100) })}
                      </Text>
                    </Pressable>
                  ))}
                </Row>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                  {t('mktb.instantHint')}
                </Text>
              </Card>
            ) : null}
            {type === 'new_customer' ? (
              <Card style={{ gap: Spacing.md }}>
                <Text style={styles.sectionLabel}>{t('mktb.firstOrder')}</Text>
                <Row gap={8}>
                  {[0.7, 0.8].map((r) => (
                    <Pressable
                      key={r}
                      onPress={() => setDiscountRate(r)}
                      style={[styles.chip, discountRate === r && styles.chipActive]}>
                      <Text style={[styles.chipText, discountRate === r && { color: Colors.text, fontWeight: '700' }]}>
                        {t('mktb.pctOff', { pct: Math.round((1 - r) * 100) })}
                      </Text>
                    </Pressable>
                  ))}
                </Row>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                  {t('mktb.firstOrderHint', { n: Number(couponAmount) || 20 })}
                </Text>
              </Card>
            ) : null}
            {type === 'group_buy' ? (
              <Card style={{ gap: Spacing.md }}>
                <Text style={styles.sectionLabel}>{t('mktb.tiers', { n: groupBuyTiers.length })}</Text>
                {groupBuyTiers.map((tier, i) => (
                  <View key={i} style={styles.tierRow}>
                    <Row style={{ justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '700' }}>{t('mktb.tier', { n: i + 1 })}</Text>
                      <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                        {t('mktb.tierOff', { pct: Math.round((1 - tier.discountRate) * 100), n: tier.buyers })}
                      </Text>
                    </Row>
                    <Row style={{ justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>{t('mktb.buyersNeeded')}</Text>
                      <View style={styles.stepper}>
                        <Pressable
                          onPress={() =>
                            setGroupBuyTiers((t) => t.map((x, j) => (j === i ? { ...x, buyers: Math.max(5, x.buyers - 5) } : x)))
                          }
                          hitSlop={8}>
                          <Icon name="remove" size={16} color={Colors.text} />
                        </Pressable>
                        <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text }}>{tier.buyers}</Text>
                        <Pressable
                          onPress={() => setGroupBuyTiers((t) => t.map((x, j) => (j === i ? { ...x, buyers: x.buyers + 5 } : x)))}
                          hitSlop={8}>
                          <Icon name="add" size={16} color={Colors.text} />
                        </Pressable>
                      </View>
                    </Row>
                    <Row gap={8}>
                      {[0.9, 0.8, 0.7].map((r) => (
                        <Pressable
                          key={r}
                          onPress={() => setGroupBuyTiers((t) => t.map((x, j) => (j === i ? { ...x, discountRate: r } : x)))}
                          style={[styles.chip, tier.discountRate === r && styles.chipActive]}>
                          <Text style={[styles.chipText, tier.discountRate === r && { color: Colors.text, fontWeight: '700' }]}>
                            {t('mktb.pctOff', { pct: Math.round((1 - r) * 100) })}
                          </Text>
                        </Pressable>
                      ))}
                    </Row>
                  </View>
                ))}
                {groupBuyTiers.length < 3 ? (
                  <Btn
                    label={t('mktb.addTier')}
                    variant="ghost"
                    size="sm"
                    onPress={() =>
                      setGroupBuyTiers((t) => {
                        const last = t[t.length - 1];
                        return [...t, { buyers: last.buyers + 10, discountRate: Math.max(0.7, last.discountRate - 0.1) }];
                      })
                    }
                  />
                ) : null}
              </Card>
            ) : null}
            {type === 'ppc' ? (
              <Card style={{ gap: Spacing.md }}>
                <Text style={styles.sectionLabel}>{t('mktb.cpc')}</Text>
                <Row gap={8}>
                  {[0.5, 1, 2, 3].map((v) => (
                    <Pressable
                      key={v}
                      onPress={() => setCpc(v)}
                      style={[styles.chip, cpc === v && styles.chipActive]}>
                      <Text style={[styles.chipText, cpc === v && { color: Colors.text, fontWeight: '700' }]}>{v}</Text>
                    </Pressable>
                  ))}
                </Row>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                  {t('mktb.cpcHint')}
                </Text>
              </Card>
            ) : null}
            {type === 'haggle' ? (
              <Card style={{ gap: Spacing.md }}>
                <Text style={styles.sectionLabel}>{t('mktb.negotiation')}</Text>
                <Row gap={10}>
                  <Icon name="checkmark-circle" size={18} color={Colors.success} />
                  <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, flex: 1, lineHeight: 18 }}>
                    {t('mktb.negotiationHint')}
                  </Text>
                </Row>
              </Card>
            ) : null}

            <Card style={{ gap: Spacing.md }}>
              <Text style={styles.sectionLabel}>{t('mktb.items', { n: picked.length })}</Text>
              {products.slice(0, 10).map((p) => (
                <Pressable key={p.id} onPress={() => togglePick(p.id)} style={[styles.targetRow, picked.includes(p.id) && styles.targetActive]}>
                  <Text style={{ fontSize: 18 }}>{p.emoji}</Text>
                  <Text style={{ flex: 1, fontSize: FontSize.sm, color: Colors.textSecondary }} numberOfLines={1}>{p.name}</Text>
                  <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary }}>{tzs(p.price)}</Text>
                  {picked.includes(p.id) ? <Icon name="checkmark-circle" size={17} color={Colors.success} /> : null}
                </Pressable>
              ))}
            </Card>
          </View>
        ) : (
          <View style={{ gap: Spacing.md }}>
            <Card style={{ backgroundColor: Colors.black, gap: 6 }}>
              <Text style={{ color: Colors.primary, fontWeight: '800', fontSize: FontSize.sm }}>{t('mktb.preview')}</Text>
              <Text style={{ color: Colors.white, fontSize: FontSize.xl, fontWeight: '800' }}>{titleMap[type]}</Text>
              <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: FontSize.sm }}>
                {TYPES.find((x) => x.type === type) ? t(TYPES.find((x) => x.type === type)!.label) : ''}
              </Text>
            </Card>
            <Card style={{ gap: 0 }}>
              <PreviewRow label={t('mktb.budgetLabel')} value={tzs(finalBudget)} />
              <View style={styles.divider} />
              <PreviewRow label={t('mktb.windowLabel')} value={`${dayLabel(start)} ~ ${dayLabel(end)} (${t('mktb.daysCount', { days })})`} />
              <View style={styles.divider} />
              <PreviewRow label={t('mktb.targetingLabel')} value={target} />
              <View style={styles.divider} />
              <PreviewRow label={t('mktb.itemsLabel')} value={picked.length ? t('mktb.selected', { n: picked.length }) : t('mktb.allItems')} />
              <View style={styles.divider} />
              <PreviewRow label={t('mktb.budgetLabel')} value={tzs(finalBudget)} />
            </Card>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'center', lineHeight: 16 }}>
              {t('mktb.launchNote')}
            </Text>
          </View>
        )}
      </ScrollView>

      <View style={styles.footer}>
        <Btn
          label={step === 2 ? t('mktb.publish') : t('mktb.next')}
          size="lg"
          onPress={() => (step < 2 ? setStep(step + 1) : publish())}
        />
      </View>

      {published ? (
        <View style={styles.publishedOverlay}>
          <Icon name="checkmark-circle" size={40} color={Colors.success} />
          <Text style={{ color: Colors.white, fontWeight: '800', fontSize: FontSize.md }}>{t('mktb.published')}</Text>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <Row style={{ justifyContent: 'space-between', paddingVertical: 12 }}>
      <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary }}>{label}</Text>
      <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text }}>{value}</Text>
    </Row>
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
  typeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: Colors.card,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  typeCardActive: { borderColor: Colors.primaryDark, backgroundColor: Colors.primarySoft },
  typeIcon: {
    width: 44,
    height: 44,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  typeLabel: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  typeDesc: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: Colors.textTertiary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioActive: { borderColor: Colors.primaryDark },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.primaryDark },
  sectionLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  chip: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primaryDark },
  chipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 11,
    fontSize: FontSize.md,
    color: Colors.text,
    backgroundColor: Colors.card,
  },
  targetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 11,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
  },
  targetActive: { borderColor: Colors.primaryDark, backgroundColor: Colors.primarySoft },
  tierRow: {
    gap: Spacing.sm,
    padding: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.bg,
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border },
  footer: {
    padding: Spacing.lg,
    paddingBottom: 28,
    backgroundColor: Colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  publishedOverlay: {
    position: 'absolute',
    top: 90,
    left: 40,
    right: 40,
    backgroundColor: 'rgba(0,0,0,0.85)',
    borderRadius: Radius.lg,
    padding: 24,
    alignItems: 'center',
    gap: 8,
  },
});