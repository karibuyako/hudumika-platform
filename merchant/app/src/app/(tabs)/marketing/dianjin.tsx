import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { t, onLocaleChange } from '@/i18n';
import type { DianjinCampaign, DianjinCampaignInput } from '@/api/types';
import { Btn, Card, Empty, Field, Icon, Pill, Row, Screen, SheetModal, ToggleRow } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { tzs } from '@/lib/format';
import { useMarketingStore } from '@/store/marketing';

export default function DianjinScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const dianjin = useMarketingStore((s) => s.dianjin);
  const loading = useMarketingStore((s) => s.loading);
  const error = useMarketingStore((s) => s.error);
  const hydrateDianjin = useMarketingStore((s) => s.hydrateDianjin);
  const createDianjin = useMarketingStore((s) => s.createDianjin);
  const toggleDianjin = useMarketingStore((s) => s.toggleDianjin);

  const [editing, setEditing] = useState<DianjinCampaign | 'new' | null>(null);
  const [name, setName] = useState('');
  const [budget, setBudget] = useState('');
  const [bidBps, setBidBps] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    hydrateDianjin();
  }, [hydrateDianjin]);

  const openNew = () => {
    setName('');
    setBudget('');
    setBidBps('');
    setFormError(null);
    setEditing('new');
  };

  const submit = async () => {
    const budgetTZS = budget ? Math.round(Number(budget.replace(/[^\d]/g, ''))) : 0;
    const bid = bidBps ? Math.round(Number(bidBps.replace(/[^\d]/g, ''))) : 0;
    if (!name.trim()) return setFormError(t('dj.errName'));
    if (budgetTZS <= 0) return setFormError(t('dj.errBudget'));
    if (!bid || bid < 1 || bid > 10000) return setFormError(t('dj.errBid'));
    const input: DianjinCampaignInput = { name: name.trim(), budgetTZS, bidBps: bid };
    setBusy(true);
    const res = await createDianjin(input);
    setBusy(false);
    if (res.ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setEditing(null);
    } else {
      setFormError(res.message ?? t('dj.errCreate'));
    }
  };

  return (
    <Screen scroll>
      <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.sm }}>
        <Text style={styles.subtitle}>{t('dj.subtitle')}</Text>
        <Btn label={t('dj.new')} icon="add" size="sm" onPress={openNew} />
      </Row>

      {error ? (
        <Card style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.xl }}>
          <Icon name="cloud-offline-outline" size={22} color={Colors.textTertiary} />
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('dj.errLoad')}</Text>
          <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => hydrateDianjin()} />
        </Card>
      ) : loading && dianjin.length === 0 ? (
        <Card style={{ alignItems: 'center', paddingVertical: Spacing.xl }}>
          <Icon name="time-outline" size={22} color={Colors.textTertiary} />
          <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary, marginTop: Spacing.sm }}>{t('mkt.loading')}</Text>
        </Card>
      ) : dianjin.length === 0 ? (
        <Empty icon="search-outline" title={t('dj.empty')} sub={t('dj.emptySub')} />
      ) : (
        <View style={{ gap: Spacing.md }}>
          {dianjin.map((c) => (
            <Card key={c.id} style={{ gap: Spacing.sm }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={styles.dealTitle} numberOfLines={2}>{c.name}</Text>
                <Pill label={c.active ? t('dj.active') : t('dj.inactive')} tone={c.active ? 'success' : 'neutral'} />
              </Row>
              {c.stoppedReason === 'DIANJIN_BUDGET_EXCEEDED' ? (
                <Card style={{ backgroundColor: Colors.warningSoft, gap: Spacing.xs, paddingVertical: 8 }}>
                  <Row gap={Spacing.sm}>
                    <Icon name="information-circle-outline" size={15} color={Colors.warning} />
                    <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '600', flex: 1 }}>{t('dj.budgetExceeded')}</Text>
                  </Row>
                  <Btn label={t('dj.raiseBudget')} size="sm" variant="outline" onPress={() => toggleDianjin(c.id, true)} />
                </Card>
              ) : null}
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                  {t('dj.spendBudget', { a: tzs(c.spendTZS), b: tzs(c.budgetTZS) })}
                </Text>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                  {t('dj.clicks', { n: c.clicks })} · {t('dj.bid', { bps: c.bidBps })}
                </Text>
              </Row>
              <ToggleRow label={c.active ? t('dj.active') : t('dj.inactive')} value={c.active} onChange={(v) => toggleDianjin(c.id, v)} />
            </Card>
          ))}
        </View>
      )}

      <SheetModal visible={editing !== null} onClose={() => setEditing(null)} title={t('dj.newTitle')}>
        <View style={{ gap: Spacing.md }}>
          <Field label={t('dj.name')} value={name} onChangeText={setName} placeholder={t('dj.namePh')} maxLength={120} />
          <Field label={t('dj.budget')} value={budget} onChangeText={(v) => setBudget(v.replace(/[^\d]/g, ''))} keyboardType="number-pad" maxLength={9} />
          <Field label={t('dj.bidBps')} value={bidBps} onChangeText={(v) => setBidBps(v.replace(/[^\d]/g, ''))} keyboardType="number-pad" maxLength={5} />
          {formError ? (
            <Card style={{ backgroundColor: Colors.dangerSoft }}>
              <Row gap={Spacing.sm}>
                <Icon name="alert-circle-outline" size={18} color={Colors.danger} />
                <Text style={{ fontSize: FontSize.sm, color: Colors.danger, fontWeight: '600', flex: 1 }}>{formError}</Text>
              </Row>
            </Card>
          ) : null}
          <Btn label={t('dj.create')} icon="checkmark" size="lg" loading={busy} onPress={submit} />
        </View>
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  subtitle: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600', flex: 1, paddingRight: Spacing.md },
  dealTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flex: 1, paddingRight: Spacing.md },
});
