/* Reservations — GET /reservations/me + create form (POST /reservations).
 * Party size 1–50 (contract bound); the server window is enforced
 * (RESERVATION_TIME_IN_PAST / RESERVATION_TABLE_FULL render inline).
 * Opens with the merchant pre-selected when the merchant screen links in
 * via /reservations?merchantId={id}. */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { Btn, Card, EmptyState, ErrorState, Field, Icon, Row, Screen, SheetModal, SkeletonCard, StatusPill } from '@/components/ui';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { toast } from '@/store/ui';
import { getMerchantsRepository, getReservationsRepository } from '@/repos';
import { idempotencyKey } from '@/lib/idempotency';
import { dateISO, fullTimeISO } from '@/lib/dates';
import type { MerchantPublic, Reservation } from '@hudumika/contract';
import { ApiError } from '@/api/client';

export default function ReservationsScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ merchantId?: string }>();
  const [reservations, setReservations] = useState<Reservation[] | null>(null);
  const [merchants, setMerchants] = useState<MerchantPublic[]>([]);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [merchantId, setMerchantId] = useState('');
  const [partySize, setPartySize] = useState('2');
  const [slot, setSlot] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setReservations(await getReservationsRepository().list());
      if (merchants.length === 0) setMerchants(await getMerchantsRepository().list());
    } catch {
      setError(t('common.error'));
    }
  }, [merchants.length]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Deep link from the merchant page: pre-select the merchant and open the
  // create sheet. The merchant may not be in the first page of the list, so
  // fetch it explicitly and prepend it.
  useEffect(() => {
    const linkMerchantId = params.merchantId;
    if (!linkMerchantId) return;
    setMerchantId(linkMerchantId);
    setCreateOpen(true);
    (async () => {
      try {
        const all = await getMerchantsRepository().list();
        if (!all.some((m) => m.id === linkMerchantId)) {
          const m = await getMerchantsRepository().get(linkMerchantId!);
          setMerchants((prev) => (prev.some((x) => x.id === m.id) ? prev : [m, ...prev]));
        }
      } catch {
        // list() already failed — the screen shows its own error state.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const slots = [
    { key: 't1900', label: t('reservation.today', { t: '19:00' }), iso: (() => { const d = new Date(Date.now() + 60 * 60_000); d.setHours(19, 0, 0, 0); return d.getTime() > Date.now() ? d.toISOString() : new Date(Date.now() + 3 * 3600_000).toISOString(); })() },
    { key: 't2000', label: t('reservation.today', { t: '20:00' }), iso: (() => { const d = new Date(Date.now() + 60 * 60_000); d.setHours(20, 0, 0, 0); return d.getTime() > Date.now() ? d.toISOString() : new Date(Date.now() + 4 * 3600_000).toISOString(); })() },
    { key: 'tm13', label: t('reservation.tomorrow', { t: '13:00' }), iso: (() => { const d = new Date(Date.now() + 24 * 3600_000); d.setHours(13, 0, 0, 0); return d.toISOString(); })() },
    { key: 'tm20', label: t('reservation.tomorrow', { t: '20:00' }), iso: (() => { const d = new Date(Date.now() + 24 * 3600_000); d.setHours(20, 0, 0, 0); return d.toISOString(); })() },
  ];

  const create = async () => {
    const size = Number.parseInt(partySize, 10);
    if (!merchantId) {
      setFormError(t('reservation.pickRestaurant'));
      return;
    }
    if (!Number.isInteger(size) || size < 1 || size > 50) {
      setFormError(t('reservation.partySizeError'));
      return;
    }
    if (!slot) {
      setFormError(t('reservation.pickSlot'));
      return;
    }
    setBusy(true);
    setFormError('');
    try {
      await getReservationsRepository().create({ merchantId, partySize: size, scheduledFor: slot, note: note.trim() || undefined }, idempotencyKey('cus_1', 'reservation'));
      setCreateOpen(false);
      setSlot(null);
      setNote('');
      toast(t('reservation.created'));
      load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'RESERVATION_TIME_IN_PAST') {
        setFormError(t('reservation.timeInPast'));
      } else if (e instanceof ApiError && e.code === 'RESERVATION_TABLE_FULL') {
        setFormError(t('reservation.tableFull'));
      } else {
        setFormError(e instanceof ApiError ? e.message : t('common.error'));
      }
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: string) => {
    try {
      await getReservationsRepository().cancel(id, idempotencyKey('cus_1', 'reservation.cancel'));
      toast(t('reservation.cancelled'));
      load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'RESERVATION_NOT_CANCELLABLE') {
        toast(t('reservation.notCancellable'), 'info');
        load();
      } else {
        toast(t('common.error'), 'error');
      }
    }
  };

  const merchantName = (id: string) => merchants.find((m) => m.id === id)?.businessName ?? id;

  return (
    <Screen>
      <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg }}>
        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <Text style={styles.title}>{t('reservation.title')}</Text>
          <Btn label={t('reservation.add')} size="sm" onPress={() => setCreateOpen(true)} icon="add" />
        </Row>
      </View>
      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !reservations ? (
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={2} />
        </View>
      ) : reservations.length === 0 ? (
        <EmptyState icon="restaurant-outline" title={t('reservation.empty')} actionLabel={t('reservation.add')} onAction={() => setCreateOpen(true)} />
      ) : (
        <FlatList
          data={reservations}
          keyExtractor={(r) => r.id}
          onRefresh={load}
          refreshing={false}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }}
          renderItem={({ item }) => (
            <Card style={styles.card}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={styles.name} numberOfLines={1}>{merchantName(item.merchantId)}</Text>
                <StatusPill status={item.status} />
              </Row>
              <Text style={styles.meta}>
                {dateISO(item.scheduledFor)} · {t('reservation.party', { n: item.partySize })}
              </Text>
              {item.note ? <Text style={styles.meta}>{item.note}</Text> : null}
              {item.status === 'confirmed' || item.status === 'pending' ? (
                <Btn label={t('reservation.cancelAction')} variant="outline" size="sm" onPress={() => cancel(item.id)} style={{ marginTop: Spacing.md, alignSelf: 'flex-start' }} />
              ) : null}
            </Card>
          )}
        />
      )}

      <SheetModal visible={createOpen} onClose={() => setCreateOpen(false)} title={t('reservation.add')}>
        {merchants.length === 0 ? (
          <Text style={styles.meta}>{t('common.error')}</Text>
        ) : (
          <View style={{ gap: Spacing.md }}>
            <Text style={styles.sectionLabel}>{t('reservation.restaurant')}</Text>
            {merchants.slice(0, 6).map((m) => (
              <Pressable
                key={m.id}
                onPress={() => setMerchantId(m.id)}
                accessibilityRole="button"
                accessibilityState={{ selected: merchantId === m.id }}
                style={[styles.optionRow, merchantId === m.id && styles.optionSelected]}>
                <Text style={[styles.value, { flex: 1 }]}>{m.businessName}</Text>
                <Icon name={merchantId === m.id ? 'radio-button-on' : 'radio-button-off'} size={17} color={merchantId === m.id ? Colors.primary : Colors.borderStrong} />
              </Pressable>
            ))}
            <Field label={t('reservation.partySize')} value={partySize} onChangeText={setPartySize} keyboardType="number-pad" maxLength={2} />
            <Text style={styles.sectionLabel}>{t('reservation.slotLabel')}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm }}>
              {slots.map((s) => (
                <Pressable
                  key={s.key}
                  onPress={() => setSlot(s.iso)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: slot === s.iso }}
                  style={[styles.slotChip, slot === s.iso && styles.slotChipSelected]}>
                  <Text style={[styles.slotText, slot === s.iso && { color: Colors.white, fontFamily: Fonts.sansBold }]}>{s.label}</Text>
                </Pressable>
              ))}
            </View>
            {slot ? <Text style={styles.meta}>{t('reservation.picked', { t: fullTimeISO(slot) })}</Text> : null}
            <Field label={t('reservation.note')} value={note} onChangeText={setNote} placeholder={t('reservation.notePlaceholder')} maxLength={300} />
            {formError ? <Text style={styles.errorText}>{formError}</Text> : null}
            <Btn label={t('reservation.confirm')} onPress={create} loading={busy} />
          </View>
        )}
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text, flex: 1, textAlign: 'center' },
  card: { marginBottom: Spacing.md },
  name: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text, flex: 1, paddingRight: Spacing.md },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  sectionLabel: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sansSemibold },
  value: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansMedium },
  optionRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, padding: Spacing.md, borderRadius: 12, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.card },
  optionSelected: { borderColor: Colors.primary, backgroundColor: Colors.primarySoft },
  slotChip: { paddingHorizontal: Spacing.md, paddingVertical: 8, borderRadius: 12, borderWidth: 1, borderColor: Colors.borderStrong, backgroundColor: Colors.card },
  slotChipSelected: { borderColor: Colors.ink, backgroundColor: Colors.ink },
  slotText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sansMedium },
  errorText: { color: Colors.danger, fontSize: FontSize.xs, fontFamily: Fonts.sansSemibold },
});