import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import type { JourneyAction, JourneyActionType, JourneyStatus } from '@/api/types';
import { Btn, Card, Empty, Field, Icon, Pill, Row, Screen, Segmented, SheetModal } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { timeAgo } from '@/lib/format';
import { useReportsStore } from '@/store/reports';

type Sheet = null | 'add';

const TRIGGERS: { key: string; label: I18nKey }[] = [
  { key: 'order.completed', label: 'jrn.triggerCompleted' },
  { key: 'order.placed', label: 'jrn.triggerPlaced' },
  { key: 'first_order', label: 'jrn.triggerFirstOrder' },
  { key: 'customer.inactive', label: 'jrn.triggerInactive' },
  { key: 'review.rated', label: 'jrn.triggerReview' },
  { key: 'loyalty.tier_up', label: 'jrn.triggerTierUp' },
];

const ACTION_TYPES: { key: JourneyActionType; label: I18nKey }[] = [
  { key: 'push', label: 'jrn.typePush' },
  { key: 'sms', label: 'jrn.typeSms' },
  { key: 'coupon', label: 'jrn.typeCoupon' },
  { key: 'email', label: 'jrn.typeEmail' },
];

const STATUS_META: Record<JourneyStatus, { label: I18nKey; tone: 'neutral' | 'success' | 'warning' }> = {
  draft: { label: 'jrn.statusDraft', tone: 'neutral' },
  active: { label: 'jrn.statusActive', tone: 'success' },
  paused: { label: 'jrn.statusPaused', tone: 'warning' },
};

const TYPE_LABEL: Record<JourneyActionType, I18nKey> = {
  push: 'jrn.typePush',
  sms: 'jrn.typeSms',
  coupon: 'jrn.typeCoupon',
  email: 'jrn.typeEmail',
};

export default function JourneysScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const journeys = useReportsStore((s) => s.journeys);
  const hydrate = useReportsStore((s) => s.hydrate);
  const createJourney = useReportsStore((s) => s.createJourney);

  const [sheet, setSheet] = useState<Sheet>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState('order.completed');
  const [actions, setActions] = useState<JourneyAction[]>([{ type: 'push', delayHours: 24, template: '' }]);
  const [err, setErr] = useState('');

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const onRefresh = async () => {
    setRefreshing(true);
    await hydrate();
    setRefreshing(false);
  };

  const openAdd = () => {
    setName('');
    setTrigger('order.completed');
    setActions([{ type: 'push', delayHours: 24, template: '' }]);
    setErr('');
    setSheet('add');
  };

  const patchAction = (i: number, patch: Partial<JourneyAction>) => {
    setActions((list) => list.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  };

  const save = async () => {
    if (!name.trim()) {
      setErr(t('jrn.errName'));
      return;
    }
    const trimmed = actions.map((a) => ({ ...a, template: a.template?.trim() || undefined }));
    const ok = await createJourney({ name: name.trim(), trigger, actions: trimmed });
    if (ok.ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSheet(null);
    } else setErr(t('jrn.errCreate'));
  };

  const actionTypesSummary = (list: JourneyAction[]) => {
    const counts = new Map<JourneyActionType, number>();
    for (const a of list) counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
    return [...counts.entries()].map(([type]) => t(TYPE_LABEL[type])).join(' + ');
  };

  return (
    <Screen>
      <FlatList
        data={journeys}
        keyExtractor={(j) => j.id}
        contentContainerStyle={{ padding: Spacing.md, gap: 10, paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        ListEmptyComponent={<Empty icon="git-branch-outline" title={t('jrn.empty')} sub={t('jrn.emptySub')} />}
        renderItem={({ item }) => (
          <Card>
            <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <View style={{ flex: 1, gap: 6 }}>
                <Row gap={6}>
                  <Icon name="git-branch-outline" size={16} color={Colors.primaryDark} />
                  <Text style={{ flex: 1, fontSize: FontSize.md, fontWeight: '700', color: Colors.text }} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Pill label={t(STATUS_META[item.status].label)} tone={STATUS_META[item.status].tone} />
                </Row>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                  {t('jrn.trigger')}: <Text style={{ color: Colors.textSecondary, fontWeight: '600' }}>{item.trigger}</Text>
                </Text>
                <Row gap={6} style={{ flexWrap: 'wrap' }}>
                  <Pill label={t('jrn.actionSummary', { n: item.actions.length, types: actionTypesSummary(item.actions) })} tone="neutral" />
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('jrn.createdAt', { when: timeAgo(item.createdAt) })}</Text>
                </Row>
              </View>
            </Row>
          </Card>
        )}
      />

      <View style={styles.footer}>
        <Btn label={t('jrn.add')} size="lg" icon="add" onPress={openAdd} />
      </View>

      <SheetModal visible={sheet === 'add'} onClose={() => setSheet(null)} title={t('jrn.add')}>
        <View style={{ gap: Spacing.md }}>
          <Field label={t('jrn.name')} value={name} onChangeText={setName} placeholder={t('jrn.namePh')} maxLength={80} />
          <Text style={styles.label}>{t('jrn.trigger')}</Text>
          <Segmented options={TRIGGERS} value={trigger} onChange={setTrigger} />
          <Text style={styles.label}>{t('jrn.actions')}</Text>
          {actions.map((a, i) => (
            <View key={i} style={styles.actionCard}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Segmented
                  options={ACTION_TYPES}
                  value={a.type}
                  onChange={(type) => patchAction(i, { type })}
                  equal
                />
                <Pressable
                  hitSlop={8}
                  onPress={() => setActions((list) => list.filter((_, idx) => idx !== i))}
                  accessibilityRole="button"
                  accessibilityLabel={t('common.remove')}>
                  <Icon name="trash-outline" size={18} color={Colors.danger} />
                </Pressable>
              </Row>
              <Field
                label={t('jrn.delayHours')}
                value={String(a.delayHours)}
                onChangeText={(v) => patchAction(i, { delayHours: Number(v) || 0 })}
                keyboardType="number-pad"
              />
              <Field label={t('jrn.template')} value={a.template ?? ''} onChangeText={(v) => patchAction(i, { template: v })} placeholder={t('jrn.templatePh')} maxLength={200} />
            </View>
          ))}
          <Btn
            label={t('jrn.addAction')}
            size="sm"
            variant="outline"
            icon="add"
            onPress={() => setActions((list) => [...list, { type: 'push', delayHours: 24, template: '' }])}
          />
          {err ? <Text style={{ fontSize: FontSize.sm, color: Colors.danger }}>{err}</Text> : null}
          <Row gap={Spacing.md}>
            <Btn label={t('common.cancel')} size="lg" variant="subtle" style={{ flex: 1 }} onPress={() => setSheet(null)} />
            <Btn label={t('common.add')} size="lg" style={{ flex: 1 }} onPress={save} />
          </Row>
        </View>
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  actionCard: {
    gap: Spacing.sm,
    padding: Spacing.md,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  footer: {
    padding: Spacing.lg,
    paddingBottom: 28,
    backgroundColor: Colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
});
