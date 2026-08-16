import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { t, onLocaleChange } from '@/i18n';
import type { BrandDisplayCampaign, BrandDisplayCampaignInput } from '@/api/types';
import { Btn, Card, Empty, Field, Icon, Row, Screen, ToggleRow } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { dayLabel } from '@/lib/format';
import { usePromotionStore } from '@/store/promotions';

const TZ_DAY = 86400000;
const DAY_CHOICES = [
  { days: 7, label: 'mktb.day7' },
  { days: 14, label: 'mktb.day14' },
  { days: 30, label: 'gb.day30' },
] as const;

/** Form fields are initialised from the loaded campaign; the parent remounts
 *  this component (via key) when a different campaign arrives, so no effect
 *  syncing is needed. */
function BrandForm({ campaign, onDone }: { campaign: BrandDisplayCampaign | null; onDone: () => void }) {
  const saveBrandDisplay = usePromotionStore((s) => s.saveBrandDisplay);
  const [name, setName] = useState(campaign?.name ?? '');
  const [budget, setBudget] = useState(campaign ? String(campaign.budgetTZS) : '');
  const [active, setActive] = useState(campaign?.active ?? true);
  const [days, setDays] = useState(() => {
    if (!campaign) return 7;
    const planned = Math.max(1, Math.ceil((campaign.endsAt - campaign.startsAt) / TZ_DAY));
    return DAY_CHOICES.find((c) => c.days >= planned)?.days ?? 30;
  });
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async () => {
    const budgetTZS = budget ? Math.round(Number(budget.replace(/[^\d]/g, ''))) : 0;
    if (!name.trim()) return setFormError(t('bd.errName'));
    if (budgetTZS <= 0) return setFormError(t('bd.errBudget'));
    const start = campaign?.startsAt ?? Date.now();
    const input: BrandDisplayCampaignInput = {
      name: name.trim(),
      budgetTZS,
      startsAt: start,
      endsAt: start + days * TZ_DAY,
      active,
    };
    setBusy(true);
    const res = await saveBrandDisplay(input);
    setBusy(false);
    if (res.ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onDone();
    } else {
      setFormError(res.message ?? t('bd.errSave'));
    }
  };

  return (
    <View style={{ gap: Spacing.md }}>
      <Card style={{ gap: Spacing.md }}>
        <Field label={t('bd.name')} value={name} onChangeText={setName} placeholder={t('bd.namePh')} maxLength={120} />
        <Field label={t('bd.budget')} value={budget} onChangeText={(v) => setBudget(v.replace(/[^\d]/g, ''))} keyboardType="number-pad" maxLength={9} />
        <Row gap={8} style={{ flexWrap: 'wrap' }}>
          {DAY_CHOICES.map((c) => (
            <Btn key={c.days} label={t(c.label)} variant={days === c.days ? 'primary' : 'outline'} size="sm" onPress={() => setDays(c.days)} />
          ))}
        </Row>
        <ToggleRow label={t('bd.activeToggle')} value={active} onChange={setActive} />
      </Card>

      {formError ? (
        <Card style={{ backgroundColor: Colors.dangerSoft }}>
          <Row gap={Spacing.sm}>
            <Icon name="alert-circle-outline" size={18} color={Colors.danger} />
            <Text style={{ fontSize: FontSize.sm, color: Colors.danger, fontWeight: '600', flex: 1 }}>{formError}</Text>
          </Row>
        </Card>
      ) : null}

      <Btn label={t('bd.save')} icon="checkmark" size="lg" loading={busy} onPress={submit} />
    </View>
  );
}

export default function BrandScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const campaign = usePromotionStore((s) => s.brandDisplay);
  const brandLoading = usePromotionStore((s) => s.brandLoading);
  const brandError = usePromotionStore((s) => s.brandError);
  const hydrateBrandDisplay = usePromotionStore((s) => s.hydrateBrandDisplay);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    hydrateBrandDisplay();
  }, [hydrateBrandDisplay, reload]);

  return (
    <Screen scroll>
      {brandLoading && !campaign ? (
        <Card style={{ alignItems: 'center', paddingVertical: Spacing.xl }}>
          <Icon name="time-outline" size={22} color={Colors.textTertiary} />
          <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary, marginTop: Spacing.sm }}>{t('mkt.loading')}</Text>
        </Card>
      ) : (
        <View style={{ gap: Spacing.md }}>
          {campaign ? (
            <Card style={{ gap: Spacing.sm }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={styles.dealTitle} numberOfLines={2}>{campaign.name}</Text>
                <Icon name={campaign.active ? 'checkmark-circle-outline' : 'pause-circle-outline'} size={20} color={campaign.active ? Colors.success : Colors.textTertiary} />
              </Row>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 16 }}>
                {dayLabel(campaign.startsAt)} ~ {dayLabel(campaign.endsAt)} · {t('bd.impressions', { n: campaign.impressions.toLocaleString() })}
              </Text>
            </Card>
          ) : null}

          {brandError && !campaign ? (
            <Card style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.xl }}>
              <Icon name="cloud-offline-outline" size={22} color={Colors.textTertiary} />
              <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('bd.errLoad')}</Text>
              <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => setReload((n) => n + 1)} />
            </Card>
          ) : !campaign ? (
            <Empty icon="diamond-outline" title={t('bd.empty')} sub={t('bd.emptySub')} />
          ) : null}

          <BrandForm key={campaign?.id ?? 'new'} campaign={campaign} onDone={() => setReload((n) => n + 1)} />
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  dealTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flex: 1, paddingRight: Spacing.md },
});
