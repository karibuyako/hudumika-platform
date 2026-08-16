import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Chip, Empty, Icon, Pill, Row, Screen, ToggleRow } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { tzs } from '@/lib/format';
import type { CommissionRuleInput, CommissionRuleType, MerchantStaff, StaffPerformance } from '@/api/types';
import { api } from '@/api/client';
import { useStaffOpsStore } from '@/store/staff-ops';
import { useMessageStore } from '@/store/messages';

const DAY = 86400000;

const TYPE_LABEL: Record<CommissionRuleType, I18nKey> = {
  per_order: 'so.commTypeOrder',
  per_service: 'so.commTypeService',
  per_revenue: 'so.commTypeRevenue',
};

const TYPES: CommissionRuleType[] = ['per_order', 'per_service', 'per_revenue'];

interface RuleDraft {
  key: string;
  staffId: string | null;
  type: CommissionRuleType;
  rateBps: string;
  active: boolean;
}

const iso = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function CommissionsScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const commissionRules = useStaffOpsStore((s) => s.commissionRules);
  const hydrateCommissionRules = useStaffOpsStore((s) => s.hydrateCommissionRules);
  const saveCommissionRules = useStaffOpsStore((s) => s.saveCommissionRules);
  const hydratePerformance = useStaffOpsStore((s) => s.hydratePerformance);
  const performance = useStaffOpsStore((s) => s.performance);
  const pushMessage = useMessageStore((s) => s.push);

  const [staffList, setStaffList] = useState<MerchantStaff[]>([]);
  const [drafts, setDrafts] = useState<RuleDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.get<MerchantStaff[]>('/merchants/me/staff', { retries: 1 }).then(setStaffList).catch(() => undefined);
    hydrateCommissionRules();
    const now = Date.now();
    hydratePerformance(iso(now - 29 * DAY), iso(now));
  }, [hydrateCommissionRules, hydratePerformance]);

  useEffect(() => {
    if (!commissionRules.loaded) return;
    setDrafts(
      commissionRules.rows.map((r, i) => ({
        key: `existing_${i}`,
        staffId: r.staffId,
        type: r.type,
        rateBps: String(r.rateBps),
        active: r.active,
      })),
    );
  }, [commissionRules.loaded]);

  const earned: StaffPerformance[] = useMemo(() => [...performance.rows].sort((a, b) => b.commissionTZS - a.commissionTZS), [performance.rows]);
  const staffName = (id: string | null) => (id ? staffList.find((s) => s.id === id)?.name ?? id : t('so.commAllStaff'));

  const updateDraft = (key: string, patch: Partial<RuleDraft>) => {
    setSaved(false);
    setError('');
    setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  };

  const addRule = () => {
    setSaved(false);
    setError('');
    setDrafts((ds) => [...ds, { key: `new_${Date.now()}`, staffId: null, type: 'per_order', rateBps: '500', active: true }]);
  };

  const save = async () => {
    const rules: CommissionRuleInput[] = [];
    for (const d of drafts) {
      const rateBps = Number(d.rateBps);
      if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000) {
        setError(t('so.commInvalid'));
        return;
      }
      rules.push({ staffId: d.staffId, type: d.type, rateBps, active: d.active });
    }
    setBusy(true);
    setError('');
    const res = await saveCommissionRules(rules);
    setBusy(false);
    if (res.ok) {
      setSaved(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({ type: 'system', title: t('so.commSaved'), body: '' });
    } else {
      setError(res.code === 'COMMISSION_RULE_INVALID' ? t('so.commInvalid') : res.message ?? t('so.commErr'));
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('so.commTitle')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <Text style={styles.sectionLabel}>{t('so.commRulesTitle')}</Text>

        {commissionRules.error ? (
          <View style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.lg }}>
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('so.commErr')}</Text>
            <Btn label={t('common.retry')} size="sm" variant="outline" onPress={hydrateCommissionRules} />
          </View>
        ) : null}

        {!commissionRules.loaded || drafts.length === 0 ? (
          <Card>
            <Empty icon="cash-outline" title={t('so.commEmpty')} sub={t('so.commEmptySub')} />
            <Btn label={t('so.commAddRule')} icon="add" size="sm" variant="outline" onPress={addRule} />
          </Card>
        ) : (
          <View style={{ gap: Spacing.md }}>
            {drafts.map((d) => (
              <Card key={d.key} style={{ gap: Spacing.md }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={styles.ruleTitle}>{staffName(d.staffId)}</Text>
                  <Pill label={d.active ? t('so.commActive') : t('common.off')} tone={d.active ? 'success' : 'neutral'} />
                </Row>
                <View style={{ gap: Spacing.sm }}>
                  <Text style={styles.fieldLabel}>{t('so.commType')}</Text>
                  <Row gap={8} style={{ flexWrap: 'wrap' }}>
                    {TYPES.map((ty) => (
                      <Chip key={ty} label={t(TYPE_LABEL[ty])} selected={d.type === ty} onPress={() => updateDraft(d.key, { type: ty })} />
                    ))}
                  </Row>
                </View>
                <View style={{ gap: Spacing.sm }}>
                  <Text style={styles.fieldLabel}>{t('so.commApplyTo')}</Text>
                  <Row gap={8} style={{ flexWrap: 'wrap' }}>
                    <Chip label={t('so.commAllStaff')} selected={d.staffId === null} onPress={() => updateDraft(d.key, { staffId: null })} />
                    {staffList.map((s) => (
                      <Chip key={s.id} label={s.name} selected={d.staffId === s.id} onPress={() => updateDraft(d.key, { staffId: s.id })} />
                    ))}
                  </Row>
                </View>
                <View style={{ gap: Spacing.sm }}>
                  <Text style={styles.fieldLabel}>{t('so.commRate')}</Text>
                  <TextInput
                    value={d.rateBps}
                    onChangeText={(v) => updateDraft(d.key, { rateBps: v })}
                    placeholder={t('so.commRatePh')}
                    placeholderTextColor={Colors.textFaint}
                    keyboardType="number-pad"
                    maxLength={5}
                    accessibilityLabel={t('so.commRate')}
                    style={styles.input}
                  />
                </View>
                <ToggleRow label={t('so.commActive')} value={d.active} onChange={(v) => updateDraft(d.key, { active: v })} />
              </Card>
            ))}
            <Btn label={t('so.commAddRule')} icon="add" variant="outline" size="sm" onPress={addRule} />
          </View>
        )}

        {error ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs, marginTop: Spacing.md }}>{error}</Text> : null}
        {saved ? <Text style={{ color: Colors.success, fontSize: FontSize.xs, marginTop: Spacing.sm }}>{t('so.commSaved')}</Text> : null}
        <Btn label={t('so.commSave')} size="lg" loading={busy} onPress={save} style={{ marginTop: Spacing.md }} />

        <Text style={styles.sectionLabel}>{t('so.commEarned')}</Text>
        {earned.length === 0 ? <Empty icon="trending-up-outline" title={t('so.commEarned')} sub={t('so.perfEmptySub')} /> : null}
        {earned.map((p) => (
          <Card key={p.staffId} style={styles.earnedRow}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.name} numberOfLines={1}>{p.name}</Text>
              <Text style={styles.meta}>
                {t('so.perfOrders')}: {p.ordersProcessed}
              </Text>
            </View>
            <Text style={styles.earnedValue}>{tzs(p.commissionTZS)}</Text>
          </Card>
        ))}
      </Screen>
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
  sectionLabel: {
    fontSize: FontSize.xs,
    color: Colors.textTertiary,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    marginTop: Spacing.lg,
    marginBottom: Spacing.sm,
  },
  fieldLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  ruleTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  input: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 11,
    fontSize: FontSize.sm,
    color: Colors.text,
    backgroundColor: Colors.card,
  },
  earnedRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  name: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flexShrink: 1 },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary },
  earnedValue: { fontSize: FontSize.md, fontWeight: '800', color: Colors.success },
});
