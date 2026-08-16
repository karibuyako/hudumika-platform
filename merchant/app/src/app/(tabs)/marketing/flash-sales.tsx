import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { t, onLocaleChange, type I18nKey } from '@/i18n';
import type { FlashSale, FlashSaleInput, FlashSaleStatus } from '@/api/types';
import { Btn, Card, Empty, Field, Icon, Pill, Row, Screen, SheetModal, ToggleRow } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { dayLabel } from '@/lib/format';
import { useMarketingStore } from '@/store/marketing';

const STATUS_META: Record<FlashSaleStatus, { label: I18nKey; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  draft: { label: 'fs.statusDraft', tone: 'neutral' },
  scheduled: { label: 'fs.statusScheduled', tone: 'info' },
  live: { label: 'fs.statusLive', tone: 'success' },
  ended: { label: 'fs.statusEnded', tone: 'neutral' },
  cancelled: { label: 'fs.statusCancelled', tone: 'danger' },
};

const DAY_CHOICES = [
  { days: 1, label: 'mktb.day1' },
  { days: 3, label: 'mktb.day3' },
  { days: 7, label: 'mktb.day7' },
  { days: 14, label: 'mktb.day14' },
] as const;
const TZ_DAY = 86400000;
const NOW = Date.now();

export default function FlashSalesScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const flashSales = useMarketingStore((s) => s.flashSales);
  const loading = useMarketingStore((s) => s.loading);
  const error = useMarketingStore((s) => s.error);
  const hydrateFlashSales = useMarketingStore((s) => s.hydrateFlashSales);
  const createFlashSale = useMarketingStore((s) => s.createFlashSale);
  const updateFlashSale = useMarketingStore((s) => s.updateFlashSale);

  const [editing, setEditing] = useState<FlashSale | 'new' | null>(null);
  const [itemIds, setItemIds] = useState('');
  const [discountBps, setDiscountBps] = useState('');
  const [quantityLimit, setQuantityLimit] = useState('');
  const [startsNow, setStartsNow] = useState(true);
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    hydrateFlashSales();
  }, [hydrateFlashSales]);

  const openNew = () => {
    setItemIds('');
    setDiscountBps('');
    setQuantityLimit('');
    setStartsNow(true);
    setDays(7);
    setFormError(null);
    setEditing('new');
  };

  const openEdit = (f: FlashSale) => {
    setItemIds(f.itemIds.join(', '));
    setDiscountBps(String(f.discountBps));
    setQuantityLimit(f.quantityLimit != null ? String(f.quantityLimit) : '');
    setStartsNow(f.startsAt <= NOW);
    const remaining = Math.max(1, Math.ceil((f.endsAt - f.startsAt) / TZ_DAY));
    setDays(DAY_CHOICES.find((c) => c.days >= remaining)?.days ?? 14);
    setFormError(null);
    setEditing(f);
  };

  const submit = async () => {
    const ids = itemIds
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const bps = Math.round(Number(discountBps.replace(/[^\d]/g, '')));
    const qty = quantityLimit ? Math.round(Number(quantityLimit.replace(/[^\d]/g, ''))) : 0;
    if (ids.length === 0) return setFormError(t('fs.errItems'));
    if (!bps || bps < 1 || bps > 10000) return setFormError(t('fs.errDiscount'));
    const start = startsNow ? Date.now() : Date.now() + TZ_DAY;
    const input: FlashSaleInput = {
      itemIds: ids,
      discountBps: bps,
      quantityLimit: qty > 0 ? qty : null,
      startsAt: start,
      endsAt: start + days * TZ_DAY,
    };
    setBusy(true);
    const res = editing !== 'new' && editing ? await updateFlashSale(editing.id, input) : await createFlashSale(input);
    setBusy(false);
    if (res.ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setEditing(null);
      hydrateFlashSales();
    } else {
      setFormError(res.message ?? t('fs.errCreate'));
    }
  };

  return (
    <Screen scroll>
      <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.sm }}>
        <Text style={styles.subtitle}>{t('fs.subtitle')}</Text>
        <Btn label={t('fs.new')} icon="add" size="sm" onPress={openNew} />
      </Row>

      {error ? (
        <Card style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.xl }}>
          <Icon name="cloud-offline-outline" size={22} color={Colors.textTertiary} />
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('fs.errLoad')}</Text>
          <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => hydrateFlashSales()} />
        </Card>
      ) : loading && flashSales.length === 0 ? (
        <Card style={{ alignItems: 'center', paddingVertical: Spacing.xl }}>
          <Icon name="time-outline" size={22} color={Colors.textTertiary} />
          <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary, marginTop: Spacing.sm }}>{t('mkt.loading')}</Text>
        </Card>
      ) : flashSales.length === 0 ? (
        <Empty icon="flash-outline" title={t('fs.empty')} sub={t('fs.emptySub')} />
      ) : (
        <View style={{ gap: Spacing.md }}>
          {flashSales.map((f) => {
            const meta = STATUS_META[f.status];
            const progress = f.quantityLimit ? Math.min(1, f.soldCount / f.quantityLimit) : 0;
            return (
              <Card key={f.id} onPress={() => openEdit(f)} style={{ gap: Spacing.sm }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={styles.dealTitle} numberOfLines={2}>{t('fs.itemCount', { n: f.itemIds.length })}</Text>
                  <Pill label={t(meta.label)} tone={meta.tone} />
                </Row>
                <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
                  <View style={{ gap: 2 }}>
                    <Text style={styles.price}>{t('fs.discount', { bps: (f.discountBps / 100).toFixed(1) })}</Text>
                    <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                      {dayLabel(f.startsAt)} ~ {dayLabel(f.endsAt)}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end', gap: 4 }}>
                    <Text style={{ fontSize: FontSize.xs, fontWeight: '700', color: Colors.textSecondary }}>
                      {t('fs.sold', { sold: f.soldCount })}
                    </Text>
                    {f.quantityLimit ? (
                      <View style={styles.progressTrack}>
                        <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
                      </View>
                    ) : null}
                  </View>
                </Row>
              </Card>
            );
          })}
        </View>
      )}

      <SheetModal visible={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? t('fs.newTitle') : t('fs.editTitle')}>
        <View style={{ gap: Spacing.md }}>
          <Field label={t('fs.itemIds')} value={itemIds} onChangeText={setItemIds} placeholder={t('fs.itemIdsPh')} maxLength={200} />
          <Row gap={Spacing.md}>
            <View style={{ flex: 1 }}>
              <Field label={t('fs.discountBps')} value={discountBps} onChangeText={(v) => setDiscountBps(v.replace(/[^\d]/g, ''))} keyboardType="number-pad" maxLength={5} />
            </View>
            <View style={{ flex: 1 }}>
              <Field label={t('fs.qtyLimit')} value={quantityLimit} onChangeText={(v) => setQuantityLimit(v.replace(/[^\d]/g, ''))} keyboardType="number-pad" maxLength={6} />
            </View>
          </Row>
          <Row gap={8} style={{ flexWrap: 'wrap' }}>
            {DAY_CHOICES.map((c) => (
              <Btn
                key={c.days}
                label={t(c.label)}
                variant={days === c.days ? 'primary' : 'outline'}
                size="sm"
                onPress={() => setDays(c.days)}
              />
            ))}
          </Row>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
            {dayLabel(startsNow ? NOW : NOW + TZ_DAY)} ~ {dayLabel((startsNow ? NOW : NOW + TZ_DAY) + days * TZ_DAY)}
          </Text>
          <ToggleRow label={t('fs.startsNow')} value={startsNow} onChange={setStartsNow} />
          {formError ? (
            <Card style={{ backgroundColor: Colors.dangerSoft }}>
              <Row gap={Spacing.sm}>
                <Icon name="alert-circle-outline" size={18} color={Colors.danger} />
                <Text style={{ fontSize: FontSize.sm, color: Colors.danger, fontWeight: '600', flex: 1 }}>{formError}</Text>
              </Row>
            </Card>
          ) : null}
          <Btn label={editing === 'new' ? t('fs.create') : t('fs.save')} icon="checkmark" size="lg" loading={busy} onPress={submit} />
        </View>
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  subtitle: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600', flex: 1, paddingRight: Spacing.md },
  dealTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flex: 1, paddingRight: Spacing.md },
  price: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  progressTrack: {
    height: 5,
    width: 84,
    borderRadius: 3,
    backgroundColor: Colors.surface,
    overflow: 'hidden',
  },
  progressFill: { height: 5, borderRadius: 3, backgroundColor: Colors.primary },
});
