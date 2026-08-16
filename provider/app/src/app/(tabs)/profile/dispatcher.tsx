import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { OfferCard } from '@/components/OfferCard';
import { Btn, Empty, ErrorCard, Icon, ListRow, Pill, Row, Screen, SectionTitle, SheetModal } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { dateISO } from '@/lib/format';
import { getDispatchRepository } from '@/repos';
import { useSessionStore } from '@/store/session';
import type { GetProviderDispatchConsole200 } from '@hudumika/contract';

export default function DispatcherScreen() {
  const capabilities = useSessionStore((s) => s.capabilities);
  const canDispatch = capabilities.includes('assign_technician') || capabilities.includes('view_all_jobs');

  const [consoleData, setConsoleData] = useState<GetProviderDispatchConsole200 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [noAccess, setNoAccess] = useState(!canDispatch);

  const [assignFor, setAssignFor] = useState<string | null>(null);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [assignError, setAssignError] = useState('');

  const load = useCallback(async () => {
    if (!canDispatch) {
      setNoAccess(true);
      setLoading(false);
      return;
    }
    setNoAccess(false);
    try {
      setConsoleData(await getDispatchRepository().getConsole());
      setError('');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CAPABILITY_FORBIDDEN') {
        setNoAccess(true);
      } else {
        setError(e instanceof ApiError ? e.message : t('misc.error'));
      }
    } finally {
      setLoading(false);
    }
  }, [canDispatch]);

  useEffect(() => {
    load();
  }, [load]);

  const onAssign = async (bookingId: string, technicianId: string) => {
    setAssigningId(technicianId);
    setAssignError('');
    try {
      await getDispatchRepository().assignTechnician(bookingId, technicianId);
      setAssignFor(null);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'TECHNICIAN_BUSY') {
        setAssignError(t('dispatcher.assignError'));
      } else {
        setAssignError(e instanceof ApiError ? e.message : t('misc.error'));
      }
    } finally {
      setAssigningId(null);
    }
  };

  const picker = consoleData?.technicianSchedule ?? [];
  const pickerOrdered = [...picker].sort((a, b) => (a.status === 'on_job' ? 1 : 0) - (b.status === 'on_job' ? 1 : 0));
  const unassigned = consoleData?.unassignedJobs ?? [];

  return (
    <Screen scroll>
      {noAccess ? (
        <View style={styles.noAccess}>
          <Icon name="lock-closed" size={28} color={Colors.textTertiary} />
          <Text style={styles.noAccessText}>{t('dispatcher.noAccess')}</Text>
        </View>
      ) : loading && !consoleData ? (
        <View style={styles.center}>
          <ActivityIndicator color={Colors.primary} />
        </View>
      ) : error && !consoleData ? (
        <ErrorCard message={error} onRetry={load} />
      ) : consoleData ? (
        <>
          {error ? <ErrorCard message={error} onRetry={load} /> : null}

          <SectionTitle title={t('dispatcher.unassigned')} icon="git-network-outline" />
          {unassigned.length === 0 ? (
            <Empty icon="checkmark-done" title={t('dispatcher.none')} />
          ) : (
            unassigned.map((offer) => (
              <View key={offer.bookingId} style={{ marginBottom: Spacing.md }}>
                <OfferCard offer={offer} onPress={() => router.push(`/jobs/${offer.bookingId}` as never)} />
                <Btn
                  label={t('dispatcher.assign')}
                  icon="person-add"
                  style={{ marginTop: Spacing.sm }}
                  onPress={() => { setAssignError(''); setAssignFor(offer.bookingId); }}
                />
              </View>
            ))
          )}

          <SectionTitle title={t('dispatcher.schedule')} icon="calendar-outline" />
          {consoleData.technicianSchedule.map((tech) => (
            <ListRow
              key={tech.technicianId}
              title={tech.name}
              sub={`${tech.currentBookingId ? `${t('technicians.onJob')} · ${tech.currentBookingId}` : ''}${tech.nextBookingAt ? ` · ${t('booking.scheduledFor')}: ${dateISO(tech.nextBookingAt)}` : ''}`}
              trailing={<Pill label={t(`technicians.status.${tech.status}`)} tone={tech.status === 'idle' ? 'success' : tech.status === 'on_job' ? 'info' : 'neutral'} />}
              chevron={false}
            />
          ))}
        </>
      ) : null}

      <SheetModal visible={!!assignFor} onClose={() => setAssignFor(null)} title={t('dispatcher.assign')}>
        {pickerOrdered.length === 0 ? (
          <Empty icon="hardware-chip-outline" title={t('technicians.empty')} />
        ) : (
          pickerOrdered.map((tech) => (
            <Pressable
              key={tech.technicianId}
              accessibilityRole="button"
              accessibilityLabel={tech.name}
              accessibilityState={{ disabled: tech.status === 'on_job' }}
              disabled={tech.status === 'on_job'}
              onPress={() => assignFor && onAssign(assignFor, tech.technicianId)}
              style={({ pressed }) => [{ paddingVertical: Spacing.sm }, pressed && { opacity: 0.7 }]}>
              <Row style={{ justifyContent: 'space-between' }}>
                <View style={{ flex: 1, paddingRight: Spacing.sm }}>
                  <Text style={styles.techName}>{tech.name}</Text>
                  {tech.currentBookingId ? (
                    <Text style={styles.meta} numberOfLines={1}>
                      {t('technicians.onJob')} · {tech.currentBookingId}
                    </Text>
                  ) : null}
                </View>
                <Pill
                  label={tech.status === 'on_job' ? t('dispatcher.busy') : t(`technicians.status.${tech.status}`)}
                  tone={tech.status === 'on_job' ? 'warning' : 'success'}
                />
              </Row>
            </Pressable>
          ))
        )}
        {assignError ? <Text style={styles.error}>{assignError}</Text> : null}
        {assigningId ? (
          <View style={styles.center}>
            <ActivityIndicator color={Colors.primary} />
          </View>
        ) : null}
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', paddingVertical: 60 },
  noAccess: { alignItems: 'center', paddingVertical: 80, gap: Spacing.md },
  noAccessText: { color: Colors.textSecondary, fontSize: FontSize.sm },
  error: { color: Colors.danger, fontSize: FontSize.sm },
  techName: { fontSize: FontSize.md, fontFamily: 'PlusJakartaSans_600SemiBold', color: Colors.text },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 },
});
