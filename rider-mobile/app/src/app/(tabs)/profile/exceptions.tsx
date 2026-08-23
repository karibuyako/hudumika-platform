import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { ApiError } from '@/api/client';
import { Btn, Card, Empty, Pill, Screen, Spinner } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { dateISO } from '@/lib/format';
import { DELIVERY_EXCEPTION_KINDS, exceptionKindLabel, exceptionStatusTone } from '@/lib/logistics';
import { getLogisticsRepository } from '@/repos';
import type { DeliveryException } from '@hudumika/contract';

const logistics = getLogisticsRepository();

export default function ExceptionsScreen() {
  const [list, setList] = useState<DeliveryException[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filterKind, setFilterKind] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string | null>(null);
  const [selected, setSelected] = useState<DeliveryException | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  // create form
  const [kind, setKind] = useState<string>(DELIVERY_EXCEPTION_KINDS[4]);
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [created, setCreated] = useState<DeliveryException | null>(null);

  // weight/volume context (demo)
  const [weightKg] = useState<string>('12');
  const [volumeL] = useState<string>('45');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await logistics.listExceptions({
        ...(filterKind ? { kind: filterKind } : {}),
        ...(filterStatus ? { status: filterStatus } : {}),
      });
      setList(res);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('logistics.exceptionLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [filterKind, filterStatus]);

  useEffect(() => {
    load();
  }, [load]);

  const onCreate = async () => {
    if (!kind || !description.trim()) {
      setCreateError(t('logistics.exceptionCreateFailed'));
      return;
    }
    setCreating(true);
    setCreateError('');
    setCreated(null);
    try {
      const ex = await logistics.createException({ kind: kind as never, description: description.trim() });
      setCreated(ex);
      setDescription('');
      await load();
    } catch (e) {
      if (e instanceof ApiError) {
        setCreateError(e.message);
      } else {
        setCreateError(t('logistics.exceptionCreateFailed'));
      }
    } finally {
      setCreating(false);
    }
  };

  const openDetail = async (id: string) => {
    setDetailLoading(true);
    setDetailError('');
    try {
      const ex = await logistics.getException(id);
      setSelected(ex);
    } catch (e) {
      setDetailError(e instanceof ApiError ? e.message : t('logistics.exceptionLoadFailed'));
    } finally {
      setDetailLoading(false);
    }
  };

  const updateStatus = async (status: DeliveryException['status']) => {
    if (!selected) return;
    setDetailLoading(true);
    setDetailError('');
    try {
      const outcome = status === 'resolved' ? 'Resolved by ops' : status === 'escalated' ? 'Escalated to ops manager' : undefined;
      const updated = await logistics.updateException(selected.id, { status, ...(outcome ? { outcome } : {}) });
      setSelected(updated);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'EXCEPTION_ALREADY_RESOLVED') {
        setDetailError(t('logistics.exceptionAlreadyResolved'));
        try {
          const fresh = await logistics.getException(selected.id);
          setSelected(fresh);
        } catch {
          // ignore
        }
      } else {
        setDetailError(e instanceof ApiError ? e.message : t('logistics.exceptionLoadFailed'));
      }
    } finally {
      setDetailLoading(false);
    }
  };

  if (loading) {
    return (
      <Screen>
        <View style={styles.center}>
          <Spinner color={Colors.primary} />
        </View>
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen>
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
          <Btn label={t('common.retry')} variant="ghost" onPress={load} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <Card style={styles.formCard}>
        <Text style={styles.formTitle}>{t('logistics.exceptionReport')}</Text>
        <Text style={styles.label}>{t('logistics.exceptionKind')}</Text>
        <View style={styles.chips}>
          {DELIVERY_EXCEPTION_KINDS.map((k) => {
            const active = k === kind;
            return (
              <Pressable
                key={k}
                onPress={() => setKind(k)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={({ pressed }) => [styles.chip, active && styles.chipActive, pressed && { opacity: 0.7 }]}>
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{exceptionKindLabel(k)}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.label}>{t('logistics.exceptionDescription')}</Text>
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder={t('logistics.exceptionDescriptionPlaceholder')}
          placeholderTextColor={Colors.textTertiary}
          multiline
          maxLength={1000}
          accessibilityLabel={t('logistics.exceptionDescription')}
          style={styles.input}
        />
        <View style={styles.contextRow}>
          <Text style={styles.contextText}>Weight {weightKg} kg · Volume {volumeL} L</Text>
        </View>
        {createError ? <Text style={styles.error}>{createError}</Text> : null}
        {created ? (
          <Card style={styles.createdCard}>
            <Text style={styles.createdTitle}>{t('logistics.exceptionCreated')}</Text>
            <Text style={styles.meta}>{created.id} · {exceptionKindLabel(created.kind)}</Text>
            <Pill label={t(`logistics.exceptionStatus.${created.status}` as never)} tone={exceptionStatusTone(created.status)} />
          </Card>
        ) : null}
        <Btn label={t('logistics.exceptionCreate')} onPress={onCreate} loading={creating} disabled={!description.trim()} />
      </Card>

      <View style={styles.filters}>
        <Text style={styles.filterLabel}>Filter kind</Text>
        <View style={styles.filterChips}>
          <Pressable onPress={() => setFilterKind(null)} style={({ pressed }) => [styles.filterChip, !filterKind && styles.chipActive, pressed && { opacity: 0.7 }]}>
            <Text style={[styles.chipText, !filterKind && styles.chipTextActive]}>All</Text>
          </Pressable>
          {DELIVERY_EXCEPTION_KINDS.slice(0, 6).map((k) => (
            <Pressable key={k} onPress={() => setFilterKind(k)} style={({ pressed }) => [styles.filterChip, filterKind === k && styles.chipActive, pressed && { opacity: 0.7 }]}>
              <Text style={[styles.chipText, filterKind === k && styles.chipTextActive]}>{k}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.filterLabel}>Filter status</Text>
        <View style={styles.filterChips}>
          {['open', 'resolving', 'resolved', 'escalated'].map((s) => (
            <Pressable key={s} onPress={() => setFilterStatus(s === filterStatus ? null : s)} style={({ pressed }) => [styles.filterChip, filterStatus === s && styles.chipActive, pressed && { opacity: 0.7 }]}>
              <Text style={[styles.chipText, filterStatus === s && styles.chipTextActive]}>{s}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {list && list.length === 0 ? (
        <Empty icon="warning-outline" title={t('logistics.exceptionEmpty')} />
      ) : (
        list?.map((ex) => (
          <Pressable key={ex.id} onPress={() => openDetail(ex.id)} style={({ pressed }) => [pressed && { opacity: 0.7 }]}>
            <Card style={styles.itemCard}>
              <View style={styles.itemHeader}>
                <Pill label={exceptionKindLabel(ex.kind)} tone="neutral" />
                <Pill label={t(`logistics.exceptionStatus.${ex.status}` as never)} tone={exceptionStatusTone(ex.status)} />
              </View>
              <Text style={styles.itemDesc} numberOfLines={2}>{ex.description}</Text>
              <View style={styles.itemMeta}>
                <Text style={styles.meta}>{dateISO(ex.createdAt)}</Text>
                {ex.autoReplanned ? <Pill label={t('logistics.exceptionAutoReplanned')} tone="info" /> : null}
              </View>
              {ex.autoReplanned ? <Text style={styles.replanBanner}>{t('logistics.exceptionReplanBanner')}</Text> : null}
            </Card>
          </Pressable>
        ))
      )}

      {selected ? (
        <Card style={styles.detailCard}>
          <Text style={styles.detailTitle}>Exception {selected.id.slice(0, 8)}</Text>
          <View style={styles.itemHeader}>
            <Pill label={exceptionKindLabel(selected.kind)} tone="neutral" />
            <Pill label={t(`logistics.exceptionStatus.${selected.status}` as never)} tone={exceptionStatusTone(selected.status)} />
          </View>
          <Text style={styles.itemDesc}>{selected.description}</Text>
          {selected.outcome ? <Text style={styles.outcome}>{t('logistics.exceptionOutcome')}: {selected.outcome}</Text> : null}
          {selected.resolvedAt ? <Text style={styles.meta}>Resolved {dateISO(selected.resolvedAt)}</Text> : null}
          {selected.autoReplanned ? <Text style={styles.replanBanner}>{t('logistics.exceptionReplanBanner')}</Text> : null}
          {detailError ? <Text style={styles.error}>{detailError}</Text> : null}
          {detailLoading ? <Spinner color={Colors.primary} /> : null}
          <View style={styles.actions}>
            <Btn label="Set resolving" variant="ghost" size="sm" onPress={() => updateStatus('resolving')} disabled={detailLoading} />
            <Btn label="Resolve" variant="ghost" size="sm" onPress={() => updateStatus('resolved')} disabled={detailLoading} />
            <Btn label="Escalate" variant="ghost" size="sm" onPress={() => updateStatus('escalated')} disabled={detailLoading} />
          </View>
          <Btn label={t('common.close')} variant="outline" onPress={() => setSelected(null)} style={{ marginTop: Spacing.sm }} />
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', gap: Spacing.md, paddingTop: 80 },
  error: { color: Colors.danger, fontSize: FontSize.sm },
  formCard: { gap: Spacing.sm },
  formTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  label: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600', marginTop: Spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  chip: { paddingHorizontal: Spacing.md, paddingVertical: 8, borderRadius: Radius.pill, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.borderStrong },
  chipActive: { backgroundColor: Colors.ink, borderColor: Colors.ink },
  chipText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '600' },
  chipTextActive: { color: Colors.white },
  input: { borderWidth: 1, borderColor: Colors.borderStrong, borderRadius: Radius.md, padding: Spacing.md, fontSize: FontSize.sm, color: Colors.text, backgroundColor: Colors.card, minHeight: 80, textAlignVertical: 'top' },
  contextRow: { backgroundColor: Colors.surface, borderRadius: Radius.sm, padding: Spacing.sm },
  contextText: { fontSize: FontSize.xs, color: Colors.textTertiary },
  createdCard: { backgroundColor: Colors.successSoft, borderWidth: 1, borderColor: Colors.success, gap: Spacing.xs },
  createdTitle: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.success },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary },
  filters: { gap: Spacing.sm, marginVertical: Spacing.sm },
  filterLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '700' },
  filterChips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  filterChip: { paddingHorizontal: Spacing.sm, paddingVertical: 6, borderRadius: Radius.pill, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.borderStrong },
  itemCard: { gap: Spacing.sm },
  itemHeader: { flexDirection: 'row', gap: Spacing.sm, flexWrap: 'wrap' },
  itemDesc: { fontSize: FontSize.sm, color: Colors.text },
  itemMeta: { flexDirection: 'row', gap: Spacing.sm, alignItems: 'center', flexWrap: 'wrap' },
  replanBanner: { fontSize: FontSize.xs, color: Colors.info, fontWeight: '700', backgroundColor: Colors.infoSoft, padding: Spacing.xs, borderRadius: Radius.sm },
  detailCard: { gap: Spacing.sm, borderWidth: 1, borderColor: Colors.borderStrong },
  detailTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  outcome: { fontSize: FontSize.sm, color: Colors.textSecondary },
  actions: { flexDirection: 'row', gap: Spacing.sm, flexWrap: 'wrap' },
});
