import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Empty, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import type { PrintJob, PrintJobStatus, PrintJobType } from '@/api/types';
import { fullTime } from '@/lib/format';
import { usePrintJobsStore } from '@/store/print-jobs';

const TYPE_LABEL: Record<PrintJobType, I18nKey> = {
  receipt: 'pjob.receipt',
  kitchen_ticket: 'pjob.kitchenTicket',
  label: 'pjob.label',
  voucher: 'pjob.voucher',
};
const STATUS_LABEL: Record<PrintJobStatus, I18nKey> = {
  queued: 'pjob.queued',
  printing: 'pjob.printing',
  done: 'pjob.done',
  failed: 'pjob.failed',
};
const STATUS_TONE: Record<PrintJobStatus, 'neutral' | 'danger' | 'success' | 'info' | 'warning'> = {
  queued: 'warning',
  printing: 'info',
  done: 'success',
  failed: 'danger',
};

/** Pending create payload while the DEVICE_OFFLINE dialog is open. */
interface PendingCreate {
  input: Parameters<ReturnType<typeof usePrintJobsStore.getState>['createJob']>[0];
  deviceId: string | null;
}

/** Module-scope backoff clock — keeps Date.now() out of the component body
 * (react-hooks/purity) while the PRINT_QUEUE_FULL dialog counts down. */
const backoffUntil = (waitSeconds: number): { until: number; label: string } => ({
  until: Date.now() + waitSeconds * 1000,
  label: `${waitSeconds}s`,
});

export default function PrintJobsScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const jobs = usePrintJobsStore((s) => s.jobs);
  const error = usePrintJobsStore((s) => s.error);
  const lastError = usePrintJobsStore((s) => s.lastError);
  const hydrate = usePrintJobsStore((s) => s.hydrate);
  const createJob = usePrintJobsStore((s) => s.createJob);
  const retryJob = usePrintJobsStore((s) => s.retryJob);
  const clearError = usePrintJobsStore((s) => s.clearError);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingCreate | null>(null);
  const [backoff, setBackoff] = useState<{ until: number; label: string } | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => hydrate(), 0);
    return () => clearTimeout(timer);
  }, [hydrate]);

  const doCreate = async (input: Parameters<ReturnType<typeof usePrintJobsStore.getState>['createJob']>[0]) => {
    setBusy(true);
    clearError();
    const job = await createJob(input);
    setBusy(false);
    if (job) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    return job;
  };

  const createTestJob = async () => {
    const job = await doCreate({ jobType: 'receipt', label: t('pjob.testLabel'), copies: 1, orderIds: ['o_seed_0'] });
    if (!job && lastError) openFailureDialog({ jobType: 'receipt', label: t('pjob.testLabel'), copies: 1, orderIds: ['o_seed_0'] });
  };

  /** DEVICE_OFFLINE / PRINT_QUEUE_FULL → dialog with the documented options
   * (queue-until-online / fallback; retry with backoff). */
  const openFailureDialog = (input: Parameters<ReturnType<typeof usePrintJobsStore.getState>['createJob']>[0]) => {
    if (!lastError) return;
    if (lastError.code === 'DEVICE_OFFLINE') {
      setPending({ input, deviceId: (input.deviceId as string | null) ?? null });
      return;
    }
    if (lastError.code === 'PRINT_QUEUE_FULL') {
      const wait = lastError.retryAfterSeconds ?? 15;
      setBackoff(backoffUntil(wait));
      setTimeout(() => setBackoff((b) => (b ? { ...b, label: t('pjob.readyNow') } : b)), wait * 1000);
    }
  };

  const queueUntilOnline = async () => {
    if (!pending) return;
    const input = pending.input;
    setPending(null);
    await doCreate({ ...input, queueIfOffline: true });
  };

  const fallbackPrint = async () => {
    if (!pending) return;
    const { deviceId: _d, ...rest } = pending.input;
    setPending(null);
    await doCreate(rest);
  };

  const retry = async (job: PrintJob) => {
    setBusy(true);
    const input = {
      jobType: job.jobType,
      orderIds: job.orderIds,
      tableId: job.tableId,
      deviceId: job.deviceId,
      copies: job.copies,
      label: job.label,
    };
    const reQueued = await retryJob(job);
    setBusy(false);
    if (!reQueued && lastError) openFailureDialog(input);
    if (reQueued) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const retryAfterFull = async () => {
    setBackoff(null);
    const job = jobs.find((j) => j.status === 'queued');
    const input = {
      jobType: (job?.jobType ?? 'receipt') as PrintJobType,
      orderIds: job?.orderIds,
      tableId: job?.tableId ?? null,
      deviceId: job?.deviceId ?? null,
      copies: job?.copies ?? 1,
      label: job?.label,
    };
    await doCreate(input);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('pjob.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <Text style={styles.sub}>{t('pjob.sub')}</Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Btn label={t('pjob.createTest')} icon="print-outline" size="sm" loading={busy} style={{ alignSelf: 'flex-start', marginTop: Spacing.md }} onPress={createTestJob} />

        {jobs.length === 0 && !error ? <Empty icon="print-outline" title={t('pjob.empty')} sub={t('pjob.emptySub')} /> : null}

        <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
          {jobs.map((j) => (
            <Card key={j.id} style={{ gap: Spacing.sm }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Row gap={8} style={{ flex: 1 }}>
                  <Icon name="print-outline" size={15} color={Colors.textSecondary} />
                  <Text style={styles.name} numberOfLines={1}>
                    {t(TYPE_LABEL[j.jobType])}
                  </Text>
                  <Pill label={t(STATUS_LABEL[j.status])} tone={STATUS_TONE[j.status]} />
                </Row>
              </Row>
              <Text style={styles.meta} numberOfLines={1}>
                {j.label ? `${j.label} · ` : ''}
                {j.copies !== undefined ? t('pjob.copies', { n: String(j.copies) }) : ''}
                {j.orderIds && j.orderIds.length ? ` · ${t('pjob.orders', { n: String(j.orderIds.length) })}` : ''}
                {j.error ? ` · ${j.error}` : ''}
              </Text>
              <Text style={styles.meta}>{fullTime(j.createdAt)}</Text>
              {j.status === 'failed' ? (
                <Btn label={t('pjob.retry')} icon="refresh" variant="outline" size="sm" loading={busy} onPress={() => retry(j)} />
              ) : null}
            </Card>
          ))}
        </View>
      </Screen>

      <SheetModal visible={pending !== null} onClose={() => setPending(null)} title={t('pjob.offlineTitle')}>
        <View style={{ gap: Spacing.md }}>
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 19 }}>
            {t('pjob.offlineBody')}
          </Text>
          <Btn label={t('pjob.queueUntilOnline')} size="lg" loading={busy} onPress={queueUntilOnline} />
          <Btn label={t('pjob.fallbackPrint')} variant="outline" size="lg" loading={busy} onPress={fallbackPrint} />
          <Btn label={t('common.cancel')} variant="ghost" size="sm" onPress={() => setPending(null)} />
        </View>
      </SheetModal>

      <SheetModal visible={backoff !== null} onClose={() => setBackoff(null)} title={t('pjob.queueFullTitle')}>
        <View style={{ gap: Spacing.md }}>
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 19 }}>
            {t('pjob.queueFullBody', { wait: backoff?.label ?? '' })}
          </Text>
          <Btn label={t('pjob.retryNow')} size="lg" loading={busy} disabled={!backoff} onPress={retryAfterFull} />
          <Btn label={t('common.cancel')} variant="ghost" size="sm" onPress={() => setBackoff(null)} />
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
  name: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flexShrink: 1 },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary },
});
