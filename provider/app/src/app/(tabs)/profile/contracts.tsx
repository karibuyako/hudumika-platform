import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { Btn, Card, Empty, ErrorCard, Field, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { minutesLabel } from '@/lib/format';
import { getContractsRepository } from '@/repos';
import type { ServiceContract, ServiceContractStatus } from '@hudumika/contract';

const STATUS_TONE: Record<ServiceContractStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  draft: 'neutral',
  active: 'success',
  expired: 'warning',
  cancelled: 'danger',
};

const toNum = (s: string): number | undefined => {
  const v = s.trim();
  if (v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : undefined;
};

export default function ContractsScreen() {
  const [contracts, setContracts] = useState<ServiceContract[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const [adding, setAdding] = useState(false);
  const [organization, setOrganization] = useState('');
  const [services, setServices] = useState('');
  const [slaResponse, setSlaResponse] = useState('');
  const [slaResolution, setSlaResolution] = useState('');
  const [workingHours, setWorkingHours] = useState('');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      setContracts(await getContractsRepository().list());
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
    setOrganization('');
    setServices('');
    setSlaResponse('');
    setSlaResolution('');
    setWorkingHours('');
    setFormError('');
    setAdding(true);
  };

  const onCreate = async () => {
    const covered = services.split(',').map((s) => s.trim()).filter(Boolean);
    const resp = toNum(slaResponse);
    if (!organization.trim() || covered.length === 0 || resp === undefined || resp < 0) {
      setFormError(t('misc.error'));
      return;
    }
    setSubmitting(true);
    setFormError('');
    try {
      await getContractsRepository().create({
        organizationName: organization.trim(),
        coveredServices: covered,
        slaResponseMinutes: resp,
        slaResolutionMinutes: toNum(slaResolution),
        workingHours: workingHours.trim() || undefined,
      });
      setAdding(false);
      await load();
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : t('misc.error'));
    } finally {
      setSubmitting(false);
    }
  };

  const hasInactive = contracts.some((c) => c.status !== 'active');

  return (
    <Screen>
      <FlatList
        data={contracts}
        keyExtractor={(c) => c.id ?? c.organizationName}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        ListHeaderComponent={
          <View style={styles.header}>
            <Btn label={t('contracts.add')} icon="add" onPress={openAdd} />
            {hasInactive ? (
              <Card style={styles.hintCard}>
                <Row gap={Spacing.sm}>
                  <Text style={styles.hintText}>{t('contracts.onlyActive')}</Text>
                </Row>
              </Card>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          loading && !refreshing ? (
            <View style={styles.center}>
              <ActivityIndicator color={Colors.primary} />
            </View>
          ) : error && contracts.length === 0 ? (
            <ErrorCard message={error} onRetry={load} />
          ) : (
            <Empty icon="document-text-outline" title={t('contracts.empty')} />
          )
        }
        renderItem={({ item }) => (
          <Card style={styles.contractCard}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.name}>{item.organizationName}</Text>
              {item.status ? <Pill label={t(`contracts.status.${item.status}`)} tone={STATUS_TONE[item.status]} /> : null}
            </Row>
            <Text style={styles.meta}>{item.coveredServices.join(', ')}</Text>
            <Row style={{ justifyContent: 'space-between', marginTop: Spacing.sm }}>
              <Text style={styles.meta}>
                {t('contracts.slaResponse')}: {minutesLabel(item.slaResponseMinutes)}
                {item.slaResolutionMinutes != null ? ` · ${t('contracts.slaResolution')}: ${minutesLabel(item.slaResolutionMinutes)}` : ''}
              </Text>
              {item.workingHours ? <Text style={styles.meta}>{item.workingHours}</Text> : null}
            </Row>
          </Card>
        )}
      />

      <SheetModal visible={adding} onClose={() => setAdding(false)} title={t('contracts.add')}>
        <Field label={t('contracts.organization')} value={organization} onChangeText={setOrganization} placeholder="Mlimani Towers Estate" />
        <Field label={t('contracts.services')} value={services} onChangeText={setServices} placeholder="Tap Repair, Socket Installation" />
        <Field label={t('contracts.slaResponse')} value={slaResponse} onChangeText={setSlaResponse} keyboardType="number-pad" placeholder="60" />
        <Field label={t('contracts.slaResolution')} value={slaResolution} onChangeText={setSlaResolution} keyboardType="number-pad" hint={t('misc.optional')} />
        <Field label={t('contracts.workingHours')} value={workingHours} onChangeText={setWorkingHours} hint={t('misc.optional')} placeholder="08:00-17:00 Mon-Sat" />
        {formError ? <Text style={styles.error}>{formError}</Text> : null}
        <Btn label={t('contracts.add')} onPress={onCreate} loading={submitting} icon="checkmark" />
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { padding: Spacing.lg, paddingBottom: 120, gap: Spacing.md },
  header: { gap: Spacing.md, marginBottom: Spacing.md },
  center: { alignItems: 'center', paddingVertical: 80 },
  error: { color: Colors.danger, fontSize: FontSize.sm },
  contractCard: { gap: Spacing.xs },
  name: { fontSize: FontSize.md, fontFamily: 'PlusJakartaSans_700Bold', color: Colors.text },
  meta: { fontSize: FontSize.sm, color: Colors.textSecondary },
  hintCard: { backgroundColor: Colors.primarySoft, borderColor: Colors.primary },
  hintText: { flex: 1, color: Colors.text, fontSize: FontSize.sm, lineHeight: 18 },
});
