import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Empty, Field, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';
import type { MembershipTier } from '@/api/types';
import { tzs } from '@/lib/format';
import { useLoyaltyStore } from '@/store/loyalty';

interface DraftTier {
  key: string;
  name: string;
  threshold: string;
  ratePct: string;
  discountPct: string;
  benefits: string;
}

function toDraft(t: MembershipTier, key: string): DraftTier {
  return {
    key,
    name: t.name,
    threshold: String(t.thresholdTZS),
    ratePct: String(t.bonusRateBps / 100),
    discountPct: t.discountBps !== undefined ? String(t.discountBps / 100) : '',
    benefits: t.benefits.join(', '),
  };
}

export default function TiersScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const error = useLoyaltyStore((s) => s.error);
  const hydrateTiers = useLoyaltyStore((s) => s.hydrateTiers);
  const updateTiers = useLoyaltyStore((s) => s.updateTiers);

  const [drafts, setDrafts] = useState<DraftTier[]>([]);
  const [sheet, setSheet] = useState<null | 'edit' | 'delete'>(null);
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    await hydrateTiers();
    setDrafts(useLoyaltyStore.getState().tiers.map((t) => toDraft(t, t.id)));
  }, [hydrateTiers]);

  useEffect(() => {
    const t = setTimeout(() => load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const sorted = useMemo(() => [...drafts].sort((a, b) => Number(a.threshold) - Number(b.threshold)), [drafts]);

  const editTarget = targetKey === null ? null : sorted.find((d) => d.key === targetKey) ?? null;

  const openEdit = (key: string | null) => {
    setTargetKey(key);
    setSheet('edit');
  };

  const patchDraft = (key: string, patch: Partial<DraftTier>) => {
    setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  };

  const save = async () => {
    const clean = sorted
      .filter((d) => d.name.trim())
      .map((d) => ({
        name: d.name.trim(),
        thresholdTZS: Number(d.threshold),
        bonusRateBps: Math.round(Number(d.ratePct) * 100),
        discountBps: d.discountPct.trim() ? Math.round(Number(d.discountPct) * 100) : undefined,
        benefits: d.benefits.split(',').map((b) => b.trim()).filter(Boolean),
      }));
    if (!clean.length) return;
    setBusy(true);
    await updateTiers(clean);
    await hydrateTiers();
    setBusy(false);
    setDrafts(useLoyaltyStore.getState().tiers.map((t) => toDraft(t, t.id)));
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const remove = () => {
    if (targetKey === null) return;
    setDrafts((ds) => ds.filter((d) => d.key !== targetKey));
    setSheet(null);
    setTargetKey(null);
  };

  const add = () => {
    const key = `draft_${Date.now()}`;
    setDrafts((ds) => [...ds, { key, name: '', threshold: '', ratePct: '2.5', discountPct: '', benefits: '' }]);
    openEdit(key);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('loy.tiers')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <View style={{ gap: Spacing.md }}>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Text style={styles.tip}>{t('loy.thresholdSub')}</Text>

          {sorted.length === 0 ? <Empty icon="medal-outline" title={t('loy.tiersEmpty')} /> : null}

          <View style={{ gap: Spacing.md }}>
            {sorted.map((d, i) => (
              <Card key={d.key} style={{ gap: Spacing.sm }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.name} numberOfLines={1}>{d.name || `#${i + 1}`}</Text>
                    <Text style={styles.meta}>{t('loy.threshold')}: {tzs(Number(d.threshold) || 0)}</Text>
                  </View>
                  <Row gap={6}>
                    <Pill label={`${d.ratePct}%`} tone="info" />
                    {d.discountPct.trim() ? <Pill label={t('loy.discount') + ` ${d.discountPct}%`} tone="success" /> : null}
                  </Row>
                </Row>
                {d.benefits.trim() ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {d.benefits.split(',').map((b) => b.trim()).filter(Boolean).map((b) => (
                      <Pill key={b} label={b} tone="neutral" />
                    ))}
                  </View>
                ) : null}
                <Row gap={Spacing.sm}>
                  <Btn label={t('loy.editTier')} icon="create-outline" variant="outline" size="sm" style={{ flex: 1 }} onPress={() => openEdit(d.key)} />
                  <Btn label={t('loy.deleteTier')} icon="trash-outline" variant="danger" size="sm" style={{ flex: 1 }} onPress={() => { setTargetKey(d.key); setSheet('delete'); }} />
                </Row>
              </Card>
            ))}
          </View>

          <Btn label={t('loy.addTier')} icon="add" variant="ghost" size="sm" onPress={add} />
          <Btn label={t('loy.saveTiers')} size="lg" loading={busy} disabled={!sorted.some((d) => d.name.trim())} onPress={save} />
          <Text style={styles.tip}>{t('loy.tiersTip')}</Text>
        </View>
      </Screen>

      <SheetModal visible={sheet === 'edit'} onClose={() => setSheet(null)} title={t('loy.editTier')}>
        {editTarget ? (
          <View style={{ gap: Spacing.md }}>
            <Field label={t('loy.tierName')} value={editTarget.name} onChangeText={(v) => patchDraft(editTarget.key, { name: v })} maxLength={40} />
            <Field label={t('loy.threshold')} value={editTarget.threshold} onChangeText={(v) => patchDraft(editTarget.key, { threshold: v })} keyboardType="number-pad" maxLength={9} />
            <Field label={t('loy.rate')} value={editTarget.ratePct} onChangeText={(v) => patchDraft(editTarget.key, { ratePct: v })} keyboardType="decimal-pad" maxLength={5} />
            <Field label={t('loy.discount')} value={editTarget.discountPct} onChangeText={(v) => patchDraft(editTarget.key, { discountPct: v })} placeholder={t('loy.discountPh')} keyboardType="decimal-pad" maxLength={5} />
            <Field label={t('loy.benefits')} value={editTarget.benefits} onChangeText={(v) => patchDraft(editTarget.key, { benefits: v })} maxLength={200} />
            <Btn label={t('loy.save')} size="lg" onPress={() => setSheet(null)} />
          </View>
        ) : null}
      </SheetModal>

      <SheetModal visible={sheet === 'delete'} onClose={() => setSheet(null)} title={t('loy.deleteTier')}>
        <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 19 }}>
          {t('loy.deleteTierBody', { name: editTarget?.name ?? '' })}
        </Text>
        <Row gap={Spacing.sm}>
          <Btn label={t('common.cancel')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => setSheet(null)} />
          <Btn label={t('loy.deleteTier')} variant="danger" size="sm" style={{ flex: 1 }} onPress={remove} />
        </Row>
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
  error: { color: Colors.danger, fontSize: FontSize.xs },
  tip: { fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 16 },
  name: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary },
});