import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { Btn, Card, Chip, Empty, ErrorCard, Field, Pill, Row, Screen, Segmented, SheetModal, ToggleRow } from '@/components/ui';
import { Colors, FontSize, NumberStyle, Spacing } from '@/constants/theme';
import { formatTZS, t } from '@/i18n';
import { getPlansRepository, getServicesRepository } from '@/repos';
import type { ProviderService, ServicePlan, ServicePlanFrequency } from '@hudumika/contract';

const FREQUENCIES: ServicePlanFrequency[] = ['weekly', 'biweekly', 'monthly', 'quarterly', 'annually'];

const FREQUENCY_TONE: Record<ServicePlanFrequency, 'info' | 'neutral' | 'success' | 'warning' | 'danger'> = {
  weekly: 'info',
  biweekly: 'neutral',
  monthly: 'success',
  quarterly: 'warning',
  annually: 'danger',
};

const toNum = (s: string): number | undefined => {
  const v = s.trim();
  if (v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : undefined;
};

export default function PlansScreen() {
  const [plans, setPlans] = useState<ServicePlan[]>([]);
  const [services, setServices] = useState<ProviderService[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState('');

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [frequency, setFrequency] = useState<ServicePlanFrequency>('monthly');
  const [price, setPrice] = useState('');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, sv] = await Promise.all([getPlansRepository().list(), getServicesRepository().list()]);
      setPlans(p);
      setServices(sv);
      setError('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('misc.error'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const openAdd = () => {
    setName('');
    setServiceId('');
    setFrequency('monthly');
    setPrice('');
    setFormError('');
    setAdding(true);
  };

  const onCreate = async () => {
    const priceNum = toNum(price);
    if (!name.trim() || !serviceId || priceNum === undefined || priceNum < 0) {
      setFormError(t('misc.error'));
      return;
    }
    setSubmitting(true);
    setFormError('');
    try {
      await getPlansRepository().create({ name: name.trim(), serviceId, frequency, priceTZS: priceNum });
      setAdding(false);
      await load();
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : t('misc.error'));
    } finally {
      setSubmitting(false);
    }
  };

  const onToggleActive = async (plan: ServicePlan) => {
    if (!plan.id) return;
    setNotice('');
    try {
      const updated = await getPlansRepository().update(plan.id, { active: !plan.active });
      setPlans((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    } catch (e) {
      setNotice(e instanceof ApiError && e.code === 'PLAN_IN_USE' ? t('plans.inUse') : e instanceof ApiError ? e.message : t('misc.error'));
    }
  };

  return (
    <Screen>
      <FlatList
        data={plans}
        keyExtractor={(p) => p.id ?? p.name}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        ListHeaderComponent={
          <View style={styles.header}>
            <Btn label={t('plans.add')} icon="add" onPress={openAdd} />
            {notice ? <Text style={styles.notice}>{notice}</Text> : null}
          </View>
        }
        ListEmptyComponent={
          loading && !refreshing ? (
            <View style={styles.center}>
              <ActivityIndicator color={Colors.primary} />
            </View>
          ) : error && plans.length === 0 ? (
            <ErrorCard message={error} onRetry={load} />
          ) : (
            <Empty icon="repeat-outline" title={t('plans.empty')} />
          )
        }
        renderItem={({ item }) => (
          <Card flat>
            <Row style={styles.planRow}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.name}>{item.name}</Text>
                <Text style={styles.meta}>
                  {formatTZS(item.priceTZS)} · {(item.customerCount ?? 0)} {t('plans.customers')}
                </Text>
              </View>
              <Pill label={t(`plans.frequency.${item.frequency}`)} tone={FREQUENCY_TONE[item.frequency]} />
            </Row>
            <View style={styles.toggleWrap}>
              <ToggleRow label={t(item.active === false ? 'catalog.inactive' : 'catalog.active')} value={item.active !== false} onChange={() => onToggleActive(item)} />
            </View>
          </Card>
        )}
      />

      <SheetModal visible={adding} onClose={() => setAdding(false)} title={t('plans.add')}>
        <Field label={t('plans.name')} value={name} onChangeText={setName} placeholder="Monthly maintenance" />
        <Text style={styles.sectionLabel}>{t('plans.service')}</Text>
        <Row gap={6} style={{ flexWrap: 'wrap' }}>
          {services.map((s) => (
            <Chip key={s.id} label={s.name} selected={serviceId === s.id} onPress={() => setServiceId(s.id ?? '')} />
          ))}
        </Row>
        <Segmented
          options={FREQUENCIES.map((f) => ({ key: f, label: t(`plans.frequency.${f}`) }))}
          value={frequency}
          onChange={setFrequency}
        />
        <Field label={t('plans.price')} value={price} onChangeText={setPrice} keyboardType="number-pad" placeholder="80000" />
        {formError ? <Text style={styles.error}>{formError}</Text> : null}
        <Btn label={t('plans.add')} onPress={onCreate} loading={submitting} icon="checkmark" />
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { padding: Spacing.lg, paddingBottom: 120, gap: Spacing.md },
  header: { gap: Spacing.md, marginBottom: Spacing.md },
  center: { alignItems: 'center', paddingVertical: 80 },
  notice: { color: Colors.danger, fontSize: FontSize.sm },
  error: { color: Colors.danger, fontSize: FontSize.sm },
  planRow: { justifyContent: 'space-between', padding: Spacing.lg },
  name: { fontSize: FontSize.md, fontFamily: 'PlusJakartaSans_700Bold', color: Colors.text },
  meta: { fontSize: FontSize.sm, color: Colors.textSecondary, fontVariant: NumberStyle.fontVariant },
  sectionLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: 'PlusJakartaSans_700Bold' },
  toggleWrap: { paddingHorizontal: Spacing.lg },
});
