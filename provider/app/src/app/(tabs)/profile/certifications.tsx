import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { Btn, Card, Empty, ErrorCard, Field, Icon, ListRow, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { dateISO } from '@/lib/format';
import { getCertificationsRepository } from '@/repos';
import type { Certification, CertificationStatus } from '@hudumika/contract';

const STATUS_TONE: Record<CertificationStatus, 'info' | 'success' | 'danger' | 'warning'> = {
  pending: 'info',
  verified: 'success',
  rejected: 'danger',
  expired: 'warning',
};

const toISO = (s: string): string | undefined => {
  const v = s.trim();
  if (!v) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00Z`).toISOString();
  return v;
};

export default function CertificationsScreen() {
  const [certs, setCerts] = useState<Certification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const [adding, setAdding] = useState(false);
  const [type, setType] = useState('');
  const [number, setNumber] = useState('');
  const [issuer, setIssuer] = useState('');
  const [issuedAt, setIssuedAt] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [renewingId, setRenewingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setCerts(await getCertificationsRepository().list());
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
    setType('');
    setNumber('');
    setIssuer('');
    setIssuedAt('');
    setExpiryDate('');
    setFormError('');
    setAdding(true);
  };

  const onCreate = async () => {
    if (!type.trim() || !number.trim()) {
      setFormError(t('misc.error'));
      return;
    }
    setSubmitting(true);
    setFormError('');
    try {
      await getCertificationsRepository().create({
        type: type.trim(),
        number: number.trim(),
        issuer: issuer.trim() || undefined,
        issuedAt: toISO(issuedAt),
        expiryDate: toISO(expiryDate),
      });
      setAdding(false);
      await load();
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : t('misc.error'));
    } finally {
      setSubmitting(false);
    }
  };

  const onRenew = async (cert: Certification) => {
    if (!cert.id) return;
    setRenewingId(cert.id);
    try {
      const updated = await getCertificationsRepository().update(cert.id, { status: 'pending' });
      setCerts((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('misc.error'));
    } finally {
      setRenewingId(null);
    }
  };

  const hasExpired = certs.some((c) => c.status === 'expired');

  return (
    <Screen>
      <FlatList
        data={certs}
        keyExtractor={(c) => c.id ?? `${c.type}-${c.number}`}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        ListHeaderComponent={
          <View style={styles.header}>
            <Btn label={t('cert.add')} icon="add" onPress={openAdd} />
            {hasExpired ? (
              <Card style={styles.warnCard}>
                <Row gap={Spacing.sm}>
                  <Icon name="alert-circle" size={16} color={Colors.warning} />
                  <Text style={styles.warnText}>{t('cert.expiredBlock')}</Text>
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
          ) : error && certs.length === 0 ? (
            <ErrorCard message={error} onRetry={load} />
          ) : (
            <Empty icon="ribbon-outline" title={t('cert.empty')} />
          )
        }
        renderItem={({ item }) => (
          <View style={styles.rowWrap}>
            <ListRow
              title={item.type}
              sub={`${item.number}${item.issuer ? ` · ${item.issuer}` : ''}${item.expiryDate ? ` · ${t('cert.expiry')}: ${dateISO(item.expiryDate)}` : ''}`}
              onPress={item.status === 'expired' ? () => onRenew(item) : undefined}
              trailing={
                renewingId === item.id ? (
                  <ActivityIndicator size="small" color={Colors.primary} />
                ) : item.status ? (
                  <Pill label={t(`cert.status.${item.status}`)} tone={STATUS_TONE[item.status]} />
                ) : null
              }
            />
          </View>
        )}
      />

      <SheetModal visible={adding} onClose={() => setAdding(false)} title={t('cert.add')}>
        <Field label={t('cert.type')} value={type} onChangeText={setType} placeholder="Plumbing License" />
        <Field label={t('cert.number')} value={number} onChangeText={setNumber} placeholder="TPL-2024-1187" />
        <Field label={t('cert.issuer')} value={issuer} onChangeText={setIssuer} hint={t('misc.optional')} placeholder="NACTE" />
        <Field label={t('cert.issuedAt')} value={issuedAt} onChangeText={setIssuedAt} hint={t('misc.optional')} placeholder="2024-03-01" />
        <Field label={t('cert.expiry')} value={expiryDate} onChangeText={setExpiryDate} hint={t('misc.optional')} placeholder="2027-03-01" />
        {formError ? <Text style={styles.error}>{formError}</Text> : null}
        <Btn label={t('cert.add')} onPress={onCreate} loading={submitting} icon="checkmark" />
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { padding: Spacing.lg, paddingBottom: 120 },
  header: { gap: Spacing.md, marginBottom: Spacing.md },
  rowWrap: { marginBottom: Spacing.sm },
  center: { alignItems: 'center', paddingVertical: 80 },
  error: { color: Colors.danger, fontSize: FontSize.sm },
  warnCard: { backgroundColor: Colors.warningSoft, borderColor: Colors.warning },
  warnText: { flex: 1, color: Colors.text, fontSize: FontSize.sm, lineHeight: 18 },
});
