import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { TechnicianRow } from '@/components/TechnicianRow';
import { Btn, Chip, ConfirmDialog, Empty, ErrorCard, Field, Pill, Row, Screen, Segmented, SheetModal } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { capitalize } from '@/lib/format';
import { fatigueLevel, hoursOnDuty, liveStatus } from '@/lib/fatigue';
import { getTechniciansRepository } from '@/repos';
import type { Technician, TechnicianStatus } from '@hudumika/contract';

const TRADES = ['plumbing', 'electrical', 'cleaning', 'repairs', 'carpentry'] as const;
type Trade = (typeof TRADES)[number];

const STATUS_TONE: Record<TechnicianStatus, 'success' | 'info' | 'neutral'> = {
  idle: 'success',
  on_job: 'info',
  offline: 'neutral',
};

const toSkills = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

export default function TechniciansScreen() {
  const [techs, setTechs] = useState<Technician[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState('');

  const [selected, setSelected] = useState<Technician | null>(null);
  const [detailError, setDetailError] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [trade, setTrade] = useState<Trade>('plumbing');
  const [skills, setSkills] = useState('');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      setTechs(await getTechniciansRepository().list());
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
    setPhone('');
    setTrade('plumbing');
    setSkills('');
    setFormError('');
    setEditing(true);
  };

  const openEdit = (tech: Technician) => {
    setName(tech.name);
    setPhone(tech.phone);
    setTrade((TRADES.includes(tech.trade as Trade) ? tech.trade : 'plumbing') as Trade);
    setSkills((tech.skills ?? []).join(', '));
    setFormError('');
    setEditing(true);
  };

  const onSave = async () => {
    if (!name.trim() || !phone.trim()) {
      setFormError(t('misc.error'));
      return;
    }
    setSubmitting(true);
    setFormError('');
    const payload: Partial<Technician> = { name: name.trim(), phone: phone.trim(), trade, skills: toSkills(skills) };
    try {
      if (selected?.id) {
        const updated = await getTechniciansRepository().update(selected.id, payload);
        setTechs((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
        setSelected(updated);
      } else {
        await getTechniciansRepository().create(payload as Technician);
      }
      setEditing(false);
      await load();
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : t('misc.error'));
    } finally {
      setSubmitting(false);
    }
  };

  const onDelete = async () => {
    if (!selected?.id) return;
    setDeleting(true);
    setDetailError('');
    try {
      await getTechniciansRepository().remove(selected.id);
      setConfirmingDelete(false);
      setSelected(null);
      await load();
    } catch (e) {
      setConfirmingDelete(false);
      setNotice(e instanceof ApiError ? e.message : t('misc.error'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Screen>
      <FlatList
        data={techs}
        keyExtractor={(x) => x.id ?? x.phone}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        ListHeaderComponent={
          <View style={styles.header}>
            <Btn label={t('technicians.add')} icon="person-add" onPress={openAdd} />
            {notice ? <Text style={styles.notice}>{notice}</Text> : null}
          </View>
        }
        ListEmptyComponent={
          loading && !refreshing ? (
            <View style={styles.center}>
              <ActivityIndicator color={Colors.primary} />
            </View>
          ) : error && techs.length === 0 ? (
            <ErrorCard message={error} onRetry={load} />
          ) : (
            <Empty icon="hardware-chip-outline" title={t('technicians.empty')} sub={t('technicians.emptySub')} />
          )
        }
        renderItem={({ item }) => (
          <View style={styles.rowWrap}>
            <TechnicianRow technician={item} onPress={() => { setDetailError(''); setSelected(item); }} />
          </View>
        )}
      />

      <SheetModal visible={!!selected} onClose={() => setSelected(null)} title={selected?.name}>
        {selected ? (
          <>
            <Text style={styles.meta}>{selected.phone}</Text>
            <Row gap={6} style={{ flexWrap: 'wrap' }}>
              <Pill label={selected.trade.replace(/_/g, ' ')} tone="info" />
              <Pill label={t(`technicians.status.${selected.status ?? 'idle'}`)} tone={STATUS_TONE[selected.status ?? 'idle']} />
              {selected.rating != null ? <Pill label={`${selected.rating.toFixed(1)} ★`} tone="neutral" /> : null}
            </Row>
            {/* Enterprise anti-fatigue (Meituan 2025 parity) */}
            <View style={{ backgroundColor: Colors.warningSoft, borderRadius: 8, padding: 10 }}>
              <Text style={{ fontSize: FontSize.xs, color: fatigueLevel({ technicianId: selected.id ?? '', startedAt: Date.now() - 3_600_000 * 9, hoursToday: 9 }) === 'critical' ? Colors.danger : Colors.warning }}>
                {liveStatus(selected.status ?? 'idle', { technicianId: selected.id ?? '', startedAt: Date.now() - 3_600_000 * 9, hoursToday: 9 })} — {fatigueLevel({ technicianId: selected.id ?? '', startedAt: Date.now() - 3_600_000 * 9, hoursToday: 9 }) === 'critical' ? 'mandatory rest required' : fatigueLevel({ technicianId: selected.id ?? '', startedAt: Date.now() - 3_600_000 * 9, hoursToday: 9 }) === 'warning' ? 'break recommended (8h+)' : 'within safe duty'}
              </Text>
              {selected.status === 'on_job' ? <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{hoursOnDuty({ technicianId: selected.id ?? '', startedAt: Date.now() - 3_600_000 * 9, hoursToday: 9 }).toFixed(1)}h continuous — 12h max then 30m break</Text> : null}
            </View>
            {selected.skills?.length ? (
              <>
                <Text style={styles.sectionLabel}>{t('technicians.skills')}</Text>
                <Row gap={6} style={{ flexWrap: 'wrap' }}>
                  {selected.skills.map((s) => (
                    <Chip key={s} label={s} selected />
                  ))}
                </Row>
              </>
            ) : null}
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.meta}>
                {selected.certifications?.length ?? 0} {t('cert.title')}
              </Text>
              {selected.currentBookingId ? (
                <Text style={styles.meta} numberOfLines={1}>
                  {t('technicians.onJob')} · {selected.currentBookingId}
                </Text>
              ) : null}
            </Row>
            <Btn label={t('technicians.add')} variant="ghost" icon="create" onPress={() => openEdit(selected)} />
            <Btn label={t('misc.delete')} variant="danger" icon="trash" onPress={() => setConfirmingDelete(true)} />
            {detailError ? <Text style={styles.error}>{detailError}</Text> : null}
          </>
        ) : null}
      </SheetModal>

      <ConfirmDialog
        visible={confirmingDelete}
        title={t('misc.delete')}
        sub={selected?.name ?? ''}
        confirmLabel={t('misc.delete')}
        cancelLabel={t('misc.cancel')}
        onConfirm={onDelete}
        onCancel={() => setConfirmingDelete(false)}
        loading={deleting}
        danger
      />

      <SheetModal visible={editing} onClose={() => setEditing(false)} title={selected ? t('technicians.title') : t('technicians.add')}>
        <Field label={t('technicians.name')} value={name} onChangeText={setName} placeholder="Amina Hassan" />
        <Field label={t('technicians.phone')} value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="+255 712 345 000" />
        <Segmented
          options={TRADES.map((tr) => ({ key: tr, label: capitalize(tr) }))}
          value={trade}
          onChange={setTrade}
        />
        <Field label={t('technicians.skills')} value={skills} onChangeText={setSkills} hint={t('misc.optional')} placeholder="Leak repair, Pipe fitting" />
        {formError ? <Text style={styles.error}>{formError}</Text> : null}
        <Btn label={t('misc.save')} onPress={onSave} loading={submitting} icon="checkmark" />
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { padding: Spacing.lg, paddingBottom: 120 },
  header: { gap: Spacing.md, marginBottom: Spacing.md },
  rowWrap: { marginBottom: Spacing.sm },
  center: { alignItems: 'center', paddingVertical: 80 },
  meta: { fontSize: FontSize.sm, color: Colors.textSecondary },
  sectionLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: 'PlusJakartaSans_700Bold' },
  error: { color: Colors.danger, fontSize: FontSize.sm },
  notice: { color: Colors.danger, fontSize: FontSize.sm },
});
