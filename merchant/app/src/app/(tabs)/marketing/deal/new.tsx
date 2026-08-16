import { router, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { t, onLocaleChange, type I18nKey } from '@/i18n';
import type { GroupBuyDealInput } from '@/api/types';
import { Btn, Card, Field, Icon, Row, Screen, ToggleRow } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { dayLabel } from '@/lib/format';
import { useGroupBuyStore } from '@/store/group-buy';

const DAY_CHOICES: { days: number; label: I18nKey }[] = [
  { days: 3, label: 'gb.day3' },
  { days: 7, label: 'gb.day7' },
  { days: 14, label: 'gb.day14' },
  { days: 30, label: 'gb.day30' },
];
const TZ_DAY = 86400000;

export default function DealFormScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const { id } = useLocalSearchParams<{ id?: string }>();
  const isEdit = !!id;
  const createDeal = useGroupBuyStore((s) => s.createDeal);
  const updateDeal = useGroupBuyStore((s) => s.updateDeal);
  const getDeal = useGroupBuyStore((s) => s.getDeal);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [original, setOriginal] = useState('');
  const [quantity, setQuantity] = useState('');
  const [validityDays, setValidityDays] = useState('60');
  const [days, setDays] = useState(7);
  const [startsNow, setStartsNow] = useState(true);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(!isEdit);

  useEffect(() => {
    if (!isEdit || !id) return;
    let cancelled = false;
    getDeal(id).then((d) => {
      if (!cancelled || d) {
        if (d) {
          setTitle(d.title);
          setDescription(d.description ?? '');
          setPrice(String(d.priceTZS));
          setOriginal(String(d.originalPriceTZS));
          setQuantity(String(d.quantity));
          setValidityDays(String(d.validityDays));
          const remaining = Math.max(1, Math.ceil((d.salesEndAt - Date.now()) / TZ_DAY));
          setDays(DAY_CHOICES.find((c) => c.days >= remaining)?.days ?? DAY_CHOICES[DAY_CHOICES.length - 1].days);
        }
        setLoaded(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [id, isEdit, getDeal]);

  const submit = async () => {
    const priceTZS = Number(price.replace(/[^\d]/g, '')) || 0;
    const originalPriceTZS = Number(original.replace(/[^\d]/g, '')) || 0;
    const qty = Number(quantity.replace(/[^\d]/g, '')) || 0;
    const validity = Number(validityDays.replace(/[^\d]/g, '')) || 0;

    if (!title.trim()) return setError(t('gb.errTitle'));
    if (priceTZS <= 0 || originalPriceTZS <= 0 || priceTZS >= originalPriceTZS) return setError(t('gb.errPrice'));
    if (qty < 1) return setError(t('gb.errQty'));
    if (validity < 1) return setError(t('gb.errValidity'));

    const start = startsNow ? Date.now() : Date.now() + TZ_DAY;
    const input: GroupBuyDealInput = {
      title: title.trim(),
      description: description.trim() ? description.trim() : undefined,
      priceTZS,
      originalPriceTZS,
      quantity: qty,
      validityDays: validity,
      salesStartAt: start,
      salesEndAt: start + days * TZ_DAY,
    };

    setBusy(true);
    const res = isEdit && id ? await updateDeal(id, input) : await createDeal(input);
    setBusy(false);
    if (res.ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } else {
      setError(res.code === 'GROUP_BUY_STATUS_CONFLICT' ? t('gb.conflict') : res.message ?? (isEdit ? t('gb.errUpdate') : t('gb.errCreate')));
    }
  };

  if (!loaded) {
    return (
      <Screen scroll>
        <Card style={{ alignItems: 'center', paddingVertical: Spacing.xl }}>
          <Icon name="time-outline" size={22} color={Colors.textTertiary} />
          <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary, marginTop: Spacing.sm }}>{t('mkt.loading')}</Text>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <Card style={{ gap: Spacing.md }}>
        <Field label={t('gb.title')} value={title} onChangeText={setTitle} placeholder={t('gb.titlePh')} maxLength={80} />
        <Field
          label={t('gb.desc')}
          value={description}
          onChangeText={setDescription}
          placeholder={t('gb.descPh')}
          multiline
          maxLength={500}
        />
        <Row gap={Spacing.md}>
          <View style={{ flex: 1 }}>
            <Field label={t('gb.priceTZS')} value={price} onChangeText={(v) => setPrice(v.replace(/[^\d]/g, ''))} keyboardType="number-pad" maxLength={7} />
          </View>
          <View style={{ flex: 1 }}>
            <Field label={t('gb.originalPriceTZS')} value={original} onChangeText={(v) => setOriginal(v.replace(/[^\d]/g, ''))} keyboardType="number-pad" maxLength={7} />
          </View>
        </Row>
        <Row gap={Spacing.md}>
          <View style={{ flex: 1 }}>
            <Field label={t('gb.quantity')} value={quantity} onChangeText={(v) => setQuantity(v.replace(/[^\d]/g, ''))} keyboardType="number-pad" maxLength={5} />
          </View>
          <View style={{ flex: 1 }}>
            <Field label={t('gb.validityDays')} value={validityDays} onChangeText={(v) => setValidityDays(v.replace(/[^\d]/g, ''))} keyboardType="number-pad" maxLength={4} />
          </View>
        </Row>
      </Card>

      <Card style={{ marginTop: Spacing.md, gap: Spacing.md }}>
        <Text style={styles.sectionLabel}>{t('gb.duration')}</Text>
        <Row gap={8} style={{ flexWrap: 'wrap' }}>
          {DAY_CHOICES.map((c) => (
            <Pressable
              key={c.days}
              onPress={() => setDays(c.days)}
              accessibilityRole="button"
              accessibilityLabel={t(c.label)}
              style={[styles.chip, days === c.days && styles.chipActive]}>
              <Text style={[styles.chipText, days === c.days && { color: Colors.text, fontWeight: '700' }]}>{t(c.label)}</Text>
            </Pressable>
          ))}
        </Row>
        <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
          {dayLabel(startsNow ? Date.now() : Date.now() + TZ_DAY)} ~ {dayLabel((startsNow ? Date.now() : Date.now() + TZ_DAY) + days * TZ_DAY)}
        </Text>
        <View style={styles.divider} />
        <ToggleRow label={t('gb.startsNow')} value={startsNow} onChange={setStartsNow} />
      </Card>

      {error ? (
        <Card style={{ backgroundColor: Colors.dangerSoft, marginTop: Spacing.md }}>
          <Row gap={Spacing.sm}>
            <Icon name="alert-circle-outline" size={18} color={Colors.danger} />
            <Text style={{ fontSize: FontSize.sm, color: Colors.danger, fontWeight: '600', flex: 1 }}>{error}</Text>
          </Row>
        </Card>
      ) : null}

      <Btn
        label={isEdit ? t('gb.save') : t('gb.create')}
        icon="checkmark"
        size="lg"
        loading={busy}
        onPress={submit}
        style={{ marginTop: Spacing.md }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
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
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border },
});