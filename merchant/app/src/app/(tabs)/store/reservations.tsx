import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Empty, Field, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import type { Reservation, ReservationStatus } from '@/api/types';
import { api, ApiError } from '@/api/client';
import { fullTime } from '@/lib/format';

const STATUS_LABEL: Record<ReservationStatus, I18nKey> = {
  pending: 'rsv.pending',
  confirmed: 'rsv.confirmed',
  seated: 'rsv.seated',
  completed: 'rsv.completed',
  cancelled: 'rsv.cancelled',
  no_show: 'rsv.noShow',
};
const STATUS_TONE: Record<ReservationStatus, 'neutral' | 'danger' | 'success' | 'info' | 'warning'> = {
  pending: 'warning',
  confirmed: 'success',
  seated: 'info',
  completed: 'neutral',
  cancelled: 'danger',
  no_show: 'danger',
};
const PARTY_SIZES = ['1', '2', '3', '4', '6', '8'];
const SLOTS: { key: string; label: I18nKey; ms: () => number }[] = [
  { key: '1h', label: 'rsv.slot1h', ms: () => Date.now() + 3600000 },
  { key: '3h', label: 'rsv.slot3h', ms: () => Date.now() + 3 * 3600000 },
  { key: 'tonight', label: 'rsv.slotTonight', ms: () => new Date().setHours(20, 0, 0, 0) },
  { key: 'tomorrow', label: 'rsv.slotTomorrow', ms: () => Date.now() + 24 * 3600000 },
];

export default function ReservationsScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [sheet, setSheet] = useState(false);
  const [partySize, setPartySize] = useState('2');
  const [slotKey, setSlotKey] = useState('1h');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sheetError, setSheetError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api.get<Reservation[]>('/reservations/me', { retries: 1 });
      setReservations(res);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('rsv.errLoad'));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    setSheetError('');
    try {
      const scheduledFor = (SLOTS.find((s) => s.key === slotKey) ?? SLOTS[0]).ms();
      await api.post<Reservation>(
        '/reservations',
        { merchantId: 'm_demo', partySize: Number(partySize), scheduledFor, note: note.trim() || undefined },
        { idempotencyKey: `rsv:${Date.now()}` },
      );
      setSheet(false);
      setNote('');
      await load();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setSheetError(e instanceof ApiError ? e.message : t('rsv.errCreate'));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (r: Reservation) => {
    setBusy(true);
    setError('');
    try {
      await api.post<Reservation>(`/reservations/${r.id}/cancel`);
      await load();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('rsv.errCancel'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('rsv.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <Text style={styles.sub}>{t('rsv.sub')}</Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Btn label={t('rsv.create')} icon="add" size="sm" style={{ alignSelf: 'flex-start', marginTop: Spacing.md }} onPress={() => { setSheetError(''); setSheet(true); }} />

        {reservations.length === 0 ? <Empty icon="calendar-outline" title={t('rsv.empty')} sub={t('rsv.emptySub')} /> : null}

        <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
          {reservations.map((r) => (
            <Card key={r.id} style={{ gap: Spacing.sm }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.name} numberOfLines={1}>{t('rsv.partyFor', { n: String(r.partySize), when: fullTime(r.scheduledFor) })}</Text>
                  {r.note ? <Text style={styles.meta} numberOfLines={1}>{r.note}</Text> : null}
                  <Text style={styles.meta}>{r.tableId ? `#${String(r.tableId).slice(-4)}` : t('rsv.slot')}</Text>
                </View>
                <Pill label={t(STATUS_LABEL[r.status])} tone={STATUS_TONE[r.status]} />
              </Row>
              {r.status === 'pending' || r.status === 'confirmed' ? (
                <Btn label={t('rsv.cancel')} variant="danger" size="sm" loading={busy} onPress={() => cancel(r)} />
              ) : null}
            </Card>
          ))}
        </View>
      </Screen>

      <SheetModal visible={sheet} onClose={() => setSheet(false)} title={t('rsv.create')}>
        <View style={{ gap: Spacing.md }}>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('rsv.party')}</Text>
            <Row gap={8} style={{ flexWrap: 'wrap' }}>
              {PARTY_SIZES.map((p) => (
                <Pressable key={p} onPress={() => setPartySize(p)} accessibilityRole="button" accessibilityLabel={p} accessibilityState={{ selected: partySize === p }} style={[styles.chip, partySize === p && styles.chipActive]}>
                  <Text style={[styles.chipText, partySize === p && { color: Colors.text, fontWeight: '700' }]}>{p}</Text>
                </Pressable>
              ))}
            </Row>
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('rsv.slot')}</Text>
            <Row gap={8} style={{ flexWrap: 'wrap' }}>
              {SLOTS.map((s) => (
                <Pressable key={s.key} onPress={() => setSlotKey(s.key)} accessibilityRole="button" accessibilityLabel={t(s.label)} accessibilityState={{ selected: slotKey === s.key }} style={[styles.chip, slotKey === s.key && styles.chipActive]}>
                  <Text style={[styles.chipText, slotKey === s.key && { color: Colors.text, fontWeight: '700' }]}>{t(s.label)}</Text>
                </Pressable>
              ))}
            </Row>
          </View>
          <Field label={t('rsv.note')} value={note} onChangeText={setNote} placeholder={t('rsv.notePh')} maxLength={300} />
          {sheetError ? <Text style={styles.error}>{sheetError}</Text> : null}
          <Btn label={t('rsv.create')} size="lg" loading={busy} onPress={create} />
        </View>
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
  sub: { fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 16, marginTop: Spacing.md },
  error: { color: Colors.danger, fontSize: FontSize.xs },
  name: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary },
  fieldLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primaryDark },
  chipText: { fontSize: FontSize.sm, color: Colors.textSecondary },
});
