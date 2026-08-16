import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { StaffRow } from '@/components/StaffRow';
import { Btn, Chip, ConfirmDialog, Empty, ErrorCard, Field, Pill, Row, Screen, Segmented, SheetModal } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { capitalize } from '@/lib/format';
import { getStaffRepository } from '@/repos';
import type { ProviderStaff, ProviderStaffRole } from '@hudumika/contract';

const INVITE_CAPABILITIES = [
  'view_all_jobs',
  'view_own_jobs',
  'assign_technician',
  'reassign_job',
  'view_schedule',
  'contact_customer',
  'monitor_live_jobs',
  'manage_staff',
];

const ROLES: ProviderStaffRole[] = ['owner', 'dispatcher', 'technician', 'supervisor'];

const capLabel = (cap: string) => cap.split('_').map(capitalize).join(' ');

export default function StaffScreen() {
  const [members, setMembers] = useState<ProviderStaff[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState('');

  const [selected, setSelected] = useState<ProviderStaff | null>(null);
  const [acting, setActing] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [inviting, setInviting] = useState(false);
  const [inviteName, setInviteName] = useState('');
  const [invitePhone, setInvitePhone] = useState('');
  const [inviteRole, setInviteRole] = useState<ProviderStaffRole>('dispatcher');
  const [inviteCaps, setInviteCaps] = useState<string[]>([]);
  const [inviteError, setInviteError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      setMembers(await getStaffRepository().list());
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

  const toggleCap = (cap: string) =>
    setInviteCaps((prev) => (prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap]));

  const onInvite = async () => {
    if (!inviteName.trim() || !invitePhone.trim()) {
      setInviteError(t('misc.error'));
      return;
    }
    setSubmitting(true);
    setInviteError('');
    try {
      await getStaffRepository().invite({ name: inviteName.trim(), phone: invitePhone.trim(), role: inviteRole, capabilities: inviteCaps });
      setInviting(false);
      setInviteName('');
      setInvitePhone('');
      setInviteRole('dispatcher');
      setInviteCaps([]);
      setNotice(t('staff.inviteSent'));
      await load();
    } catch (e) {
      setInviteError(e instanceof ApiError ? e.message : t('misc.error'));
    } finally {
      setSubmitting(false);
    }
  };

  const onToggleStatus = async () => {
    if (!selected?.id) return;
    setActing(true);
    setDetailError('');
    const next = selected.status === 'suspended' ? 'active' : 'suspended';
    try {
      const updated = await getStaffRepository().update(selected.id, { status: next });
      setSelected(updated);
      setMembers((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
    } catch (e) {
      setDetailError(e instanceof ApiError ? e.message : t('misc.error'));
    } finally {
      setActing(false);
    }
  };

  const onDelete = async () => {
    if (!selected?.id) return;
    setDeleting(true);
    setDetailError('');
    try {
      await getStaffRepository().remove(selected.id);
      setConfirmingDelete(false);
      setSelected(null);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PROVIDER_STAFF_LAST_OWNER') {
        setConfirmingDelete(false);
        setDetailError(t('staff.lastOwner'));
      } else {
        setDetailError(e instanceof ApiError ? e.message : t('misc.error'));
      }
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Screen>
      <FlatList
        data={members}
        keyExtractor={(m) => m.id ?? m.phone}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        ListHeaderComponent={
          <View style={styles.header}>
            {notice ? <Text style={styles.notice}>{notice}</Text> : null}
            <Btn label={t('staff.invite')} icon="person-add" onPress={() => { setInviteError(''); setInviting(true); }} />
          </View>
        }
        ListEmptyComponent={
          loading && !refreshing ? (
            <View style={styles.center}>
              <ActivityIndicator color={Colors.primary} />
            </View>
          ) : error && members.length === 0 ? (
            <ErrorCard message={error} onRetry={load} />
          ) : (
            <Empty icon="people-outline" title={t('staff.empty')} />
          )
        }
        renderItem={({ item }) => (
          <View style={styles.rowWrap}>
            <StaffRow staff={item} onPress={() => { setDetailError(''); setSelected(item); }} />
          </View>
        )}
      />

      <SheetModal visible={!!selected} onClose={() => setSelected(null)} title={selected?.name}>
        {selected ? (
          <>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.meta}>{selected.phone}</Text>
              <Row gap={6}>
                <Pill label={t(`staff.role.${selected.role}`)} tone="info" />
                {selected.status ? <Pill label={t(`staff.status.${selected.status}`)} tone={selected.status === 'active' ? 'success' : selected.status === 'suspended' ? 'danger' : 'neutral'} /> : null}
              </Row>
            </Row>
            <Text style={styles.sectionLabel}>{t('staff.capabilities')}</Text>
            <Row gap={6} style={{ flexWrap: 'wrap' }}>
              {(selected.capabilities ?? []).map((cap) => (
                <Chip key={cap} label={capLabel(cap)} selected />
              ))}
              {(selected.capabilities ?? []).length === 0 ? <Text style={styles.meta}>{t('misc.noData')}</Text> : null}
            </Row>
            <Btn
              label={selected.status === 'suspended' ? t('staff.reactivate') : t('staff.suspend')}
              variant="ghost"
              onPress={onToggleStatus}
              loading={acting}
              icon={selected.status === 'suspended' ? 'refresh' : 'pause'}
            />
            <Btn label={t('staff.delete')} variant="danger" onPress={() => setConfirmingDelete(true)} icon="trash" />
            {detailError ? <Text style={styles.error}>{detailError}</Text> : null}
          </>
        ) : null}
      </SheetModal>

      <ConfirmDialog
        visible={confirmingDelete}
        title={t('staff.delete')}
        sub={`${t('staff.delete')}: ${selected?.name ?? ''}?`}
        confirmLabel={t('staff.delete')}
        cancelLabel={t('misc.cancel')}
        onConfirm={onDelete}
        onCancel={() => setConfirmingDelete(false)}
        loading={deleting}
        danger
      />

      <SheetModal visible={inviting} onClose={() => setInviting(false)} title={t('staff.invite')}>
        <Field label={t('staff.name')} value={inviteName} onChangeText={setInviteName} placeholder="Amina Hassan" />
        <Field label={t('staff.phone')} value={invitePhone} onChangeText={setInvitePhone} keyboardType="phone-pad" placeholder="+255 700 000 000" />
        <Segmented
          options={ROLES.map((r) => ({ key: r, label: t(`staff.role.${r}`) }))}
          value={inviteRole}
          onChange={setInviteRole}
        />
        <Text style={styles.sectionLabel}>{t('staff.capabilities')}</Text>
        <Row gap={6} style={{ flexWrap: 'wrap' }}>
          {INVITE_CAPABILITIES.map((cap) => (
            <Chip key={cap} label={capLabel(cap)} selected={inviteCaps.includes(cap)} onPress={() => toggleCap(cap)} />
          ))}
        </Row>
        {inviteError ? <Text style={styles.error}>{inviteError}</Text> : null}
        <Btn label={t('staff.invite')} onPress={onInvite} loading={submitting} icon="send" />
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
  notice: { color: Colors.success, fontSize: FontSize.sm },
});
