import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { Btn, Card, ConfirmDialog, Empty, ErrorCard, Field, Icon, Pill, Row, Screen, SectionTitle, SheetModal, ToggleRow } from '@/components/ui';
import { Colors, FontSize, NumberStyle, Spacing } from '@/constants/theme';
import { formatTZS, t } from '@/i18n';
import { capitalize, minutesLabel } from '@/lib/format';
import { getCatalogRepository, getServicesRepository } from '@/repos';
import type { BookingEstimate, ProviderService, Service } from '@hudumika/contract';

const toNum = (s: string): number | undefined => {
  const v = s.trim();
  if (v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : undefined;
};

export default function CatalogScreen() {
  const [services, setServices] = useState<ProviderService[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState('');

  const [marketServices, setMarketServices] = useState<Service[]>([]);
  const [marketLoading, setMarketLoading] = useState(false);

  const [estimateFor, setEstimateFor] = useState<ProviderService | null>(null);
  const [estimate, setEstimate] = useState<BookingEstimate | null>(null);
  const [estimateLoading, setEstimateLoading] = useState(false);
  const [estimateError, setEstimateError] = useState('');

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [duration, setDuration] = useState('');
  const [baseTZS, setBaseTZS] = useState('');
  const [perHourTZS, setPerHourTZS] = useState('');
  const [tripFeeTZS, setTripFeeTZS] = useState('');
  const [partsIncluded, setPartsIncluded] = useState(false);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [confirmingDelete, setConfirmingDelete] = useState<ProviderService | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      setServices(await getServicesRepository().list());
      setError('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('misc.error'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMarket = useCallback(async () => {
    setMarketLoading(true);
    try {
      // GET /services — the public service catalogue customers book against.
      setMarketServices(await getCatalogRepository().listServices());
    } catch {
      /* browse section is auxiliary — non-fatal */
    } finally {
      setMarketLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    loadMarket();
  }, [load, loadMarket]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const onEstimate = async (service: ProviderService) => {
    if (!service.id) return;
    setEstimateFor(service);
    setEstimate(null);
    setEstimateError('');
    setEstimateLoading(true);
    try {
      setEstimate(await getServicesRepository().getEstimate(service.id));
    } catch (e) {
      setEstimateError(e instanceof ApiError ? e.message : t('misc.error'));
    } finally {
      setEstimateLoading(false);
    }
  };

  const openAdd = () => {
    setName('');
    setDuration('');
    setBaseTZS('');
    setPerHourTZS('');
    setTripFeeTZS('');
    setPartsIncluded(false);
    setFormError('');
    setAdding(true);
  };

  const onCreate = async () => {
    const dur = toNum(duration);
    const base = toNum(baseTZS);
    if (!name.trim() || dur === undefined || dur <= 0 || base === undefined || base < 0) {
      setFormError(t('misc.error'));
      return;
    }
    setSubmitting(true);
    setFormError('');
    try {
      await getServicesRepository().create({
        name: name.trim(),
        durationMinutes: dur,
        pricing: {
          baseTZS: base,
          perHourTZS: toNum(perHourTZS) ?? null,
          tripFeeTZS: toNum(tripFeeTZS) ?? 0,
          partsIncluded,
        },
      });
      setAdding(false);
      await load();
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : t('misc.error'));
    } finally {
      setSubmitting(false);
    }
  };

  const onToggleActive = async (service: ProviderService) => {
    if (!service.id) return;
    setNotice('');
    try {
      const updated = await getServicesRepository().update(service.id, { active: !service.active });
      setServices((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : t('misc.error'));
    }
  };

  const onDelete = async () => {
    if (!confirmingDelete?.id) return;
    setDeleting(true);
    setNotice('');
    try {
      await getServicesRepository().remove(confirmingDelete.id);
      setConfirmingDelete(null);
      await load();
    } catch (e) {
      setConfirmingDelete(null);
      setNotice(e instanceof ApiError && e.code === 'SERVICE_IN_USE' ? t('catalog.inUse') : e instanceof ApiError ? e.message : t('misc.error'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Screen>
      <FlatList
        data={services}
        keyExtractor={(s) => s.id ?? s.name}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        ListHeaderComponent={
          <View style={styles.header}>
            <Btn label={t('catalog.add')} icon="add" onPress={openAdd} />
            {notice ? <Text style={styles.notice}>{notice}</Text> : null}
            <SectionTitle title={t('catalog.market')} icon="storefront-outline" />
            {marketLoading ? (
              <View style={styles.center}>
                <ActivityIndicator color={Colors.primary} />
              </View>
            ) : (
              <Card flat style={{ paddingHorizontal: Spacing.lg }}>
                {marketServices.map((s, i) => (
                  <Row key={s.id} style={[styles.marketRow, i > 0 && styles.marketRowBorder]}>
                    <Icon name="ribbon-outline" size={15} color={Colors.textTertiary} />
                    <Text style={styles.marketName}>{s.name}</Text>
                    <Text style={styles.marketMeta}>{capitalize(s.category)}</Text>
                  </Row>
                ))}
              </Card>
            )}
          </View>
        }
        ListEmptyComponent={
          loading && !refreshing ? (
            <View style={styles.center}>
              <ActivityIndicator color={Colors.primary} />
            </View>
          ) : error && services.length === 0 ? (
            <ErrorCard message={error} onRetry={load} />
          ) : (
            <Empty icon="albums-outline" title={t('catalog.empty')} sub={t('catalog.emptySub')} />
          )
        }
        renderItem={({ item }) => (
          <Card style={styles.serviceCard}>
            <Row style={{ justifyContent: 'space-between' }}>
              <View style={{ flex: 1, paddingRight: Spacing.sm }}>
                <Text style={styles.name}>{item.name}</Text>
                <Text style={styles.meta}>
                  {minutesLabel(item.durationMinutes)} · {formatTZS(item.pricing.baseTZS)}
                  {item.pricing.tripFeeTZS ? ` · +${formatTZS(item.pricing.tripFeeTZS)}` : ''}
                </Text>
              </View>
              <Pill label={t(item.active === false ? 'catalog.inactive' : 'catalog.active')} tone={item.active === false ? 'neutral' : 'success'} />
            </Row>
            <Row style={{ justifyContent: 'space-between', marginTop: Spacing.md }}>
              <Btn label={t('catalog.estimate')} variant="ghost" size="sm" icon="calculator-outline" onPress={() => onEstimate(item)} />
              <Row gap={6}>
                <Btn
                  label={t(item.active === false ? 'catalog.active' : 'catalog.inactive')}
                  variant="outline"
                  size="sm"
                  onPress={() => onToggleActive(item)}
                />
                <Btn label={t('misc.delete')} variant="danger" size="sm" icon="trash" onPress={() => setConfirmingDelete(item)} />
              </Row>
            </Row>
          </Card>
        )}
      />

      <SheetModal visible={!!estimateFor} onClose={() => setEstimateFor(null)} title={`${t('catalog.estimate')} · ${estimateFor?.name ?? ''}`}>
        {estimateLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={Colors.primary} />
          </View>
        ) : estimateError ? (
          <ErrorCard message={estimateError} onRetry={() => estimateFor && onEstimate(estimateFor)} />
        ) : estimate ? (
          <>
            <Row style={styles.estimateRow}>
              <Text style={styles.estimateLabel}>{t('catalog.estimateLow')}</Text>
              <Text style={styles.estimateValue}>{formatTZS(estimate.lowTZS)}</Text>
            </Row>
            <Row style={styles.estimateRow}>
              <Text style={styles.estimateLabel}>{t('catalog.estimateHigh')}</Text>
              <Text style={styles.estimateValue}>{formatTZS(estimate.highTZS)}</Text>
            </Row>
            <Row style={styles.estimateRow}>
              <Text style={styles.estimateLabel}>{t('catalog.tripFee')}</Text>
              <Text style={styles.estimateValue}>{formatTZS(estimate.tripFeeTZS)}</Text>
            </Row>
            {estimate.disclaimer ? <Text style={styles.disclaimer}>{estimate.disclaimer}</Text> : null}
          </>
        ) : null}
      </SheetModal>

      <SheetModal visible={adding} onClose={() => setAdding(false)} title={t('catalog.add')}>
        <Field label={t('catalog.name')} value={name} onChangeText={setName} placeholder="Tap Repair" />
        <Field label={t('catalog.duration')} value={duration} onChangeText={setDuration} keyboardType="number-pad" placeholder="45" />
        <Field label={t('catalog.basePrice')} value={baseTZS} onChangeText={setBaseTZS} keyboardType="number-pad" placeholder="25000" />
        <Field label={t('catalog.perHour')} value={perHourTZS} onChangeText={setPerHourTZS} keyboardType="number-pad" hint={t('misc.optional')} />
        <Field label={t('catalog.tripFee')} value={tripFeeTZS} onChangeText={setTripFeeTZS} keyboardType="number-pad" hint={t('misc.optional')} />
        <ToggleRow label={t('catalog.partsIncluded')} value={partsIncluded} onChange={setPartsIncluded} />
        {formError ? <Text style={styles.noticeDanger}>{formError}</Text> : null}
        <Btn label={t('catalog.save')} onPress={onCreate} loading={submitting} icon="checkmark" />
      </SheetModal>

      <ConfirmDialog
        visible={!!confirmingDelete}
        title={t('misc.delete')}
        sub={confirmingDelete?.name ?? ''}
        confirmLabel={t('misc.delete')}
        cancelLabel={t('misc.cancel')}
        onConfirm={onDelete}
        onCancel={() => setConfirmingDelete(null)}
        loading={deleting}
        danger
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { padding: Spacing.lg, paddingBottom: 120, gap: Spacing.md },
  header: { gap: Spacing.md, marginBottom: Spacing.md },
  center: { alignItems: 'center', paddingVertical: 40 },
  notice: { color: Colors.danger, fontSize: FontSize.sm },
  noticeDanger: { color: Colors.danger, fontSize: FontSize.sm },
  serviceCard: { gap: Spacing.sm },
  name: { fontSize: FontSize.md, fontFamily: 'PlusJakartaSans_700Bold', color: Colors.text },
  meta: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2, fontVariant: NumberStyle.fontVariant },
  estimateRow: { justifyContent: 'space-between' },
  estimateLabel: { fontSize: FontSize.sm, color: Colors.textSecondary },
  estimateValue: { fontSize: FontSize.md, fontFamily: 'PlusJakartaSans_700Bold', color: Colors.text, fontVariant: NumberStyle.fontVariant },
  disclaimer: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: Spacing.sm, lineHeight: 16 },
  marketRow: { paddingVertical: Spacing.md, gap: Spacing.sm },
  marketRowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border },
  marketName: { flex: 1, fontSize: FontSize.sm, color: Colors.text, fontFamily: 'PlusJakartaSans_600SemiBold' },
  marketMeta: { fontSize: FontSize.xs, color: Colors.textTertiary, textTransform: 'capitalize' },
});
