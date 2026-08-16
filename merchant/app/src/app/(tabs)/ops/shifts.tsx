import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Chip, Empty, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { clock } from '@/lib/format';
import type { MerchantStaff, MerchantStaffRole, StaffShift } from '@/api/types';
import { api } from '@/api/client';
import { useStaffOpsStore } from '@/store/staff-ops';
import { useMessageStore } from '@/store/messages';

const ROLE_LABEL: Record<MerchantStaffRole, I18nKey> = { owner: 'prof.roleOwner', manager: 'prof.roleManager', cashier: 'prof.roleCashier', kitchen: 'prof.roleKitchen', waiter: 'prof.roleWaiter' };
const ROLES: MerchantStaffRole[] = ['owner', 'manager', 'cashier', 'kitchen', 'waiter'];

const STATUS_PILL: Record<StaffShift['status'], { label: I18nKey; tone: 'neutral' | 'danger' | 'success' | 'info' | 'warning' }> = {
  scheduled: { label: 'so.statusScheduled', tone: 'info' },
  active: { label: 'so.statusActive', tone: 'success' },
  completed: { label: 'so.statusCompleted', tone: 'neutral' },
  cancelled: { label: 'so.statusCancelled', tone: 'danger' },
};

const DAY_CHIPS: { key: number; label: I18nKey }[] = [
  { key: 0, label: 'so.dayToday' },
  { key: 1, label: 'so.dayTomorrow' },
  { key: 2, label: 'so.dayPlus2' },
  { key: 3, label: 'so.dayPlus3' },
];

const HOURS = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00', '22:00', '23:00'];

const dayStart = (offset: number) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() + offset * 86400000;
};

const iso = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const hourTs = (dayTs: number, hhmm: string) => dayTs + Number(hhmm.slice(0, 2)) * 3600000 + Number(hhmm.slice(3)) * 60000;

export default function ShiftsScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const shifts = useStaffOpsStore((s) => s.shifts);
  const hydrateShifts = useStaffOpsStore((s) => s.hydrateShifts);
  const createShift = useStaffOpsStore((s) => s.createShift);
  const updateShift = useStaffOpsStore((s) => s.updateShift);
  const deleteShift = useStaffOpsStore((s) => s.deleteShift);
  const pushMessage = useMessageStore((s) => s.push);

  const [staffList, setStaffList] = useState<MerchantStaff[]>([]);
  const [day, setDay] = useState(0);
  const [roleFilter, setRoleFilter] = useState<MerchantStaffRole | null>(null);
  const [sheet, setSheet] = useState<null | 'add' | 'edit' | 'delete'>(null);
  const [target, setTarget] = useState<StaffShift | null>(null);
  const [staffId, setStaffId] = useState('');
  const [role, setRole] = useState<MerchantStaffRole>('waiter');
  const [startHour, setStartHour] = useState('09:00');
  const [endHour, setEndHour] = useState('17:00');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const range = useMemo(() => ({ from: iso(dayStart(0)), to: iso(dayStart(3)) }), []);

  useEffect(() => {
    hydrateShifts(range.from, range.to);
    api.get<MerchantStaff[]>('/merchants/me/staff', { retries: 1 }).then(setStaffList).catch(() => undefined);
  }, [hydrateShifts, range]);

  const dayShifts = shifts.rows.filter((s) => s.startAt >= dayStart(day) && s.startAt < dayStart(day + 1));
  const visible = roleFilter ? dayShifts.filter((s) => s.role === roleFilter) : dayShifts;
  const staffName = (id: string) => staffList.find((s) => s.id === id)?.name ?? id;

  const openAdd = () => {
    setTarget(null);
    setStaffId(staffList[0]?.id ?? '');
    setRole('waiter');
    setStartHour('09:00');
    setEndHour('17:00');
    setError('');
    setSheet('add');
  };

  const openEdit = (s: StaffShift) => {
    setTarget(s);
    setStaffId(s.staffId);
    setRole(s.role);
    setStartHour(clock(s.startAt).padStart(5, '0'));
    setEndHour(clock(s.endAt).padStart(5, '0'));
    setError('');
    setSheet('edit');
  };

  const save = async () => {
    if (!staffId) return;
    setBusy(true);
    setError('');
    const baseTs = target
      ? (() => {
          const d = new Date(target.startAt);
          d.setHours(0, 0, 0, 0);
          return d.getTime();
        })()
      : dayStart(day);
    const startAt = hourTs(baseTs, startHour);
    const endAt = hourTs(baseTs, endHour);
    const res = target
      ? await updateShift(target.id, { startAt, endAt, staffId, role })
      : await createShift({ staffId, role, startAt, endAt, storeId: null });
    setBusy(false);
    if (res.ok) {
      setSheet(null);
      setTarget(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({ type: 'system', title: target ? t('so.shiftUpdated') : t('so.shiftCreated'), body: staffName(staffId) });
    } else {
      setError(res.code === 'SHIFT_OVERLAP' ? t('so.overlap') : res.message ?? t('so.errSave'));
    }
  };

  const remove = async () => {
    if (!target) return;
    setBusy(true);
    setError('');
    const res = await deleteShift(target.id);
    setBusy(false);
    if (res.ok) {
      setSheet(null);
      setTarget(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({ type: 'system', title: t('so.shiftDeleted'), body: staffName(target.staffId) });
    } else {
      setError(res.message ?? t('so.errDelete'));
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('so.shiftsTitle')}</Text>
        <Btn label={t('so.addShift')} icon="add" size="sm" onPress={openAdd} />
      </View>

      <Screen scroll>
        <Row gap={8} style={{ flexWrap: 'wrap', marginTop: Spacing.md }}>
          {DAY_CHIPS.map((d) => (
            <Chip key={d.key} label={t(d.label)} selected={day === d.key} onPress={() => setDay(d.key)} />
          ))}
        </Row>
        <Row gap={8} style={{ flexWrap: 'wrap', marginTop: Spacing.sm }}>
          <Chip label={t('so.roleAll')} selected={roleFilter === null} onPress={() => setRoleFilter(null)} />
          {ROLES.map((r) => (
            <Chip key={r} label={t(ROLE_LABEL[r])} selected={roleFilter === r} onPress={() => setRoleFilter(r)} />
          ))}
        </Row>

        {shifts.error ? (
          <View style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.lg }}>
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('so.errLoad')}</Text>
            <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => hydrateShifts(range.from, range.to)} />
          </View>
        ) : null}

        <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
          {!shifts.loading && visible.length === 0 ? <Empty icon="calendar-outline" title={t('so.emptyShifts')} sub={t('so.emptyShiftsSub')} /> : null}
          {visible.map((s) => (
            <Card key={s.id} style={{ gap: Spacing.sm }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Row gap={10} style={{ flex: 1 }}>
                  <View style={styles.iconBox}>
                    <Icon name="person-outline" size={18} color={Colors.primary} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.name} numberOfLines={1}>{staffName(s.staffId)}</Text>
                    <Text style={styles.meta}>
                      {t(ROLE_LABEL[s.role])} · {clock(s.startAt)} – {clock(s.endAt)}
                    </Text>
                  </View>
                </Row>
                <Pill label={t(STATUS_PILL[s.status].label)} tone={STATUS_PILL[s.status].tone} />
              </Row>
              <Row gap={Spacing.sm}>
                <Btn label={t('common.edit')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => openEdit(s)} />
                <Btn
                  label={t('common.delete')}
                  variant="danger"
                  size="sm"
                  style={{ flex: 1 }}
                  onPress={() => {
                    setTarget(s);
                    setError('');
                    setSheet('delete');
                  }}
                />
              </Row>
            </Card>
          ))}
        </View>
      </Screen>

      <SheetModal visible={sheet === 'add' || sheet === 'edit'} onClose={() => setSheet(null)} title={sheet === 'edit' ? t('so.editShift') : t('so.addShift')}>
        <View style={{ gap: Spacing.md }}>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('so.staff')}</Text>
            <Row gap={8} style={{ flexWrap: 'wrap' }}>
              {staffList.map((s) => (
                <Chip key={s.id} label={s.name} selected={staffId === s.id} onPress={() => setStaffId(s.id)} />
              ))}
            </Row>
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('so.role')}</Text>
            <Row gap={8} style={{ flexWrap: 'wrap' }}>
              {ROLES.map((r) => (
                <Chip key={r} label={t(ROLE_LABEL[r])} selected={role === r} onPress={() => setRole(r)} />
              ))}
            </Row>
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('so.start')} · {iso(target ? target.startAt : dayStart(day))}</Text>
            <Row gap={6} style={{ flexWrap: 'wrap' }}>
              {HOURS.map((h) => (
                <Chip key={h} label={h} selected={startHour === h} onPress={() => setStartHour(h)} />
              ))}
            </Row>
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('so.end')}</Text>
            <Row gap={6} style={{ flexWrap: 'wrap' }}>
              {HOURS.map((h) => (
                <Chip key={h} label={h} selected={endHour === h} onPress={() => setEndHour(h)} />
              ))}
            </Row>
          </View>
          {error ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{error}</Text> : null}
          <Btn label={t('common.save')} size="lg" loading={busy} disabled={!staffId} onPress={save} />
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'delete'} onClose={() => setSheet(null)} title={t('so.deleteTitle')}>
        <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 19 }}>
          {t('so.deleteBody', { name: target ? staffName(target.staffId) : '' })}
        </Text>
        {error ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs, textAlign: 'center' }}>{error}</Text> : null}
        <Row gap={Spacing.sm}>
          <Btn label={t('common.cancel')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => setSheet(null)} />
          <Btn label={t('common.delete')} variant="danger" size="sm" style={{ flex: 1 }} loading={busy} onPress={remove} />
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
  iconBox: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: Colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flexShrink: 1 },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary },
  fieldLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
});
