import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Icon, ListRow, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { api, ApiError } from '@/api/client';
import type { AccountDeletionStatus, Experiment, PrivacyExportJob } from '@/api/types';
import { CURRENCIES, getLocale, onLocaleChange, setLocale, t, type Locale } from '@/i18n';
import { syncRTL } from '@/i18n/rtl';
import { useSessionStore } from '@/store/session';

export default function SettingsScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const me = useSessionStore((s) => s.me);
  const [locale, setLoc] = useState<Locale>(getLocale());
  const [currency, setCurrency] = useState(me?.merchant.currency ?? 'TZS');
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [exportJob, setExportJob] = useState<PrivacyExportJob | null>(null);
  const [exportError, setExportError] = useState('');
  const [copied, setCopied] = useState(false);
  const [confirmErase, setConfirmErase] = useState(false);
  const [deleteText, setDeleteText] = useState('');
  const [deleteReason, setDeleteReason] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [deletion, setDeletion] = useState<AccountDeletionStatus | null>(null);

  useEffect(() => {
    api.get<{ experiments: Experiment[] }>('/experiments', { retries: 1 }).then((r) => setExperiments(r.experiments)).catch(() => undefined);
    api.get<{ request: AccountDeletionStatus | null }>('/privacy/delete', { retries: 1 }).then((r) => setDeletion(r.request)).catch(() => undefined);
  }, []);

  const pickLocale = (l: Locale) => {
    setLoc(l);
    setLocale(l);
    syncRTL(l);
    // Persist per user (SETTINGS.md:52-55) — best effort, keep the local
    // switch responsive when the network is unavailable.
    api.patch('/users/me', { locale: l }).catch(() => undefined);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const pollExport = async (jobId: string) => {
    try {
      const job = await api.get<PrivacyExportJob>(`/privacy/export/${jobId}`, { retries: 1 });
      setExportJob(job);
      if (job.status === 'queued' || job.status === 'processing') {
        setTimeout(() => pollExport(jobId), 1500);
      }
    } catch {
      setExportError(t('set.exportFailed'));
    }
  };

  const exportData = async () => {
    setExportError('');
    try {
      const res = await api.post<{ jobId: string; status: string }>('/privacy/export', {}, { retries: 0 });
      const job: PrivacyExportJob = { jobId: res.jobId, status: 'queued' };
      setExportJob(job);
      pollExport(res.jobId);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (e) {
      setExportError(e instanceof ApiError ? e.message : t('set.exportInProgress'));
    }
  };

  const erase = async () => {
    if (deleteText !== 'DELETE') {
      setDeleteError(t('set.errDeleteConfirm'));
      return;
    }
    setDeleteBusy(true);
    setDeleteError('');
    try {
      const res = await api.post<AccountDeletionStatus>('/privacy/delete', { confirmation: deleteText, reason: deleteReason.trim() || undefined }, { retries: 0 });
      setDeletion(res);
      setConfirmErase(false);
      setDeleteText('');
      setDeleteReason('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setDeleteError(e instanceof ApiError ? e.message : t('set.errDeleteConfirm'));
    } finally {
      setDeleteBusy(false);
    }
  };

  const exportLabel = exportJob
    ? exportJob.status === 'ready'
      ? t('set.exportReady')
      : exportJob.status === 'processing'
        ? t('set.exportProcessing')
        : t('set.exportQueued')
    : undefined;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('set.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <Text style={styles.sectionLabel}>{t('set.langCurrency')}</Text>
        <Card style={{ paddingVertical: 0, overflow: 'hidden' }}>
          <Row style={styles.pickerRow}>
            {(['en', 'sw', 'ar'] as Locale[]).map((l) => (
              <Pressable key={l} onPress={() => pickLocale(l)} style={[styles.pill, locale === l && styles.pillActive]}>
                <Text style={[styles.pillText, locale === l && { color: Colors.text, fontWeight: '700' }]}>
                  {({ en: t('set.english'), sw: t('set.kiswahili'), ar: t('set.arabic') } as Record<Locale, string>)[l]}
                </Text>
              </Pressable>
            ))}
          </Row>
          <Row style={styles.pickerRow}>
            {Object.keys(CURRENCIES).map((c) => (
              <Pressable key={c} onPress={() => setCurrency(c)} style={[styles.pill, currency === c && styles.pillActive]}>
                <Text style={[styles.pillText, currency === c && { color: Colors.text, fontWeight: '700' }]}>{CURRENCIES[c].symbol} {c}</Text>
              </Pressable>
            ))}
          </Row>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, paddingHorizontal: Spacing.lg, paddingBottom: Spacing.md }}>
            {t('set.currencyNote')}
          </Text>
        </Card>

        <Text style={styles.sectionLabel}>{t('set.experiments')}</Text>
        <Card style={{ paddingVertical: 0, overflow: 'hidden' }}>
          {experiments.map((e) => (
            <ListRow key={e.id} icon="flask-outline" title={e.key} sub={`variant ${e.variant} · rollout ${Math.round(e.rollout * 100)}%`} value="" onPress={() => undefined} />
          ))}
        </Card>

        <Text style={styles.sectionLabel}>{t('set.privacy')}</Text>
        <Card style={{ paddingVertical: 0, overflow: 'hidden' }}>
          <ListRow
            icon="download-outline"
            title={t('set.export')}
            sub={exportJob ? exportLabel : t('set.exportSub')}
            value={exportJob && exportJob.status !== 'ready' ? t('set.exportProcessing') : undefined}
            onPress={exportData}
          />
          {exportJob?.status === 'ready' && exportJob.downloadUrl ? (
            <View style={styles.downloadBox}>
              <Text style={styles.downloadUrl} numberOfLines={2}>{exportJob.downloadUrl}</Text>
              <Btn
                label={copied ? t('common.copied') : t('set.exportDownload')}
                variant="subtle"
                size="sm"
                onPress={() => {
                  if (exportJob?.downloadUrl) {
                    Clipboard.setStringAsync(exportJob.downloadUrl).catch(() => undefined);
                  }
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              />
            </View>
          ) : null}
          <ListRow icon="trash-outline" title={t('set.deleteAccount')} danger sub={t('set.deleteSub')} value="" onPress={() => { setDeleteError(''); setConfirmErase(true); }} />
        </Card>
        {exportError ? <Text style={styles.error}>{exportError}</Text> : null}

        {deletion ? (
          <Card style={[styles.infoBox, { borderColor: Colors.warning, borderWidth: 1 }]}>
            <Row gap={8} style={{ alignItems: 'flex-start' }}>
              <Icon name="hourglass-outline" size={16} color={Colors.warning} />
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={{ fontSize: FontSize.sm, fontWeight: '800', color: Colors.text }}>{t('set.deletionTitle')}</Text>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary, lineHeight: 17 }}>
                  {t('set.deletionBody', { date: new Date(deletion.completesAt).toLocaleDateString() })}
                </Text>
                <Btn
                  label={t('set.deletionSupport')}
                  variant="outline"
                  size="sm"
                  onPress={() => router.push('/dashboard/support')}
                />
              </View>
            </Row>
          </Card>
        ) : null}

        <SheetModal visible={confirmErase} onClose={() => setConfirmErase(false)} title={t('set.deleteTitle')}>
          <View style={{ gap: Spacing.md }}>
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 }}>
              {t('set.deleteBody')}
            </Text>
            <View style={{ gap: 6 }}>
              <Text style={styles.fieldLabel}>{t('set.deleteType')}</Text>
              <TextInput
                value={deleteText}
                onChangeText={(v) => { setDeleteText(v); setDeleteError(''); }}
                placeholder="DELETE"
                placeholderTextColor={Colors.textTertiary}
                style={styles.input}
                autoCapitalize="characters"
                autoCorrect={false}
                accessibilityLabel={t('set.deleteType')}
              />
            </View>
            <View style={{ gap: 6 }}>
              <Text style={styles.fieldLabel}>{t('set.deleteReason')}</Text>
              <TextInput
                value={deleteReason}
                onChangeText={setDeleteReason}
                placeholder={t('set.deleteReason')}
                placeholderTextColor={Colors.textTertiary}
                style={styles.input}
                maxLength={500}
                accessibilityLabel={t('set.deleteReason')}
              />
            </View>
            {deleteError ? <Text style={styles.error}>{deleteError}</Text> : null}
            <Row gap={10}>
              <Btn label={t('set.cancel')} variant="outline" onPress={() => setConfirmErase(false)} style={{ flex: 1 }} />
              <Btn
                label={t('set.requestDeletion')}
                variant="danger"
                loading={deleteBusy}
                disabled={deleteText !== 'DELETE'}
                onPress={erase}
                style={{ flex: 1 }}
              />
            </Row>
          </View>
        </SheetModal>
      </Screen>
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
  sectionLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '700', marginTop: Spacing.lg, marginBottom: Spacing.sm },
  pickerRow: { flexDirection: 'row', gap: 8, padding: Spacing.lg, paddingBottom: Spacing.sm },
  pill: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
  },
  pillActive: { backgroundColor: Colors.primary, borderColor: Colors.primaryDark },
  pillText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  infoBox: { marginTop: Spacing.md },
  error: { color: Colors.danger, fontSize: FontSize.xs, marginTop: Spacing.sm },
  fieldLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 11,
    fontSize: FontSize.md,
    color: Colors.text,
    backgroundColor: Colors.card,
  },
  downloadBox: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    gap: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  downloadUrl: { fontSize: FontSize.xs, color: Colors.textSecondary },
});
