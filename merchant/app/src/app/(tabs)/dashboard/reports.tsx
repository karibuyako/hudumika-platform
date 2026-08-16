import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import type { ReportCadence, ReportFormat, ReportType, ScheduledReport, UpdateScheduledReportBody } from '@/api/types';
import { Btn, Card, Empty, Field, Icon, Pill, Row, Screen, Segmented, SheetModal } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { timeAgo } from '@/lib/format';
import { useReportsStore } from '@/store/reports';

type Sheet = null | 'add' | 'edit' | 'delete';

const TYPE_OPTIONS: { key: ReportType; label: I18nKey }[] = [
  { key: 'revenue', label: 'rpt.typeRevenue' },
  { key: 'orders', label: 'rpt.typeOrders' },
  { key: 'products', label: 'rpt.typeProducts' },
  { key: 'traffic', label: 'rpt.typeTraffic' },
  { key: 'inventory', label: 'rpt.typeInventory' },
  { key: 'financial', label: 'rpt.typeFinancial' },
];

const CADENCE_OPTIONS: { key: ReportCadence; label: I18nKey }[] = [
  { key: 'daily', label: 'rpt.cadenceDaily' },
  { key: 'weekly', label: 'rpt.cadenceWeekly' },
  { key: 'monthly', label: 'rpt.cadenceMonthly' },
];

const FORMAT_OPTIONS: { key: ReportFormat; label: string }[] = [
  { key: 'csv', label: 'CSV' },
  { key: 'xlsx', label: 'XLSX' },
  { key: 'pdf', label: 'PDF' },
];

export default function ReportsScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const reports = useReportsStore((s) => s.reports);
  const hydrate = useReportsStore((s) => s.hydrate);
  const createReport = useReportsStore((s) => s.createReport);
  const updateReport = useReportsStore((s) => s.updateReport);
  const deleteReport = useReportsStore((s) => s.deleteReport);

  const [sheet, setSheet] = useState<Sheet>(null);
  const [target, setTarget] = useState<ScheduledReport | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<ReportType>('revenue');
  const [cadence, setCadence] = useState<ReportCadence>('daily');
  const [format, setFormat] = useState<ReportFormat>('csv');
  const [recipients, setRecipients] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const onRefresh = async () => {
    setRefreshing(true);
    await hydrate();
    setRefreshing(false);
  };

  const openAdd = () => {
    setName('');
    setType('revenue');
    setCadence('daily');
    setFormat('csv');
    setRecipients('');
    setErr('');
    setSheet('add');
  };

  const openEdit = (r: ScheduledReport) => {
    setTarget(r);
    setName(r.name);
    setType(r.reportType);
    setCadence(r.cadence);
    setFormat(r.format);
    setRecipients((r.recipients ?? []).join(', '));
    setErr('');
    setSheet('edit');
  };

  const splitRecipients = () =>
    recipients
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  const save = async () => {
    if (!name.trim()) {
      setErr(t('rpt.errName'));
      return;
    }
    const emails = splitRecipients();
    if (emails.some((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) {
      setErr(t('rpt.errEmails'));
      return;
    }
    const ok = await createReport({ name: name.trim(), reportType: type, cadence, format, recipients: emails });
    if (ok.ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSheet(null);
    } else setErr(t('rpt.errCreate'));
  };

  const saveEdit = async () => {
    if (!target) return;
    if (!name.trim()) {
      setErr(t('rpt.errName'));
      return;
    }
    const patch: UpdateScheduledReportBody = { name: name.trim(), reportType: type, cadence, format, recipients: splitRecipients() };
    const ok = await updateReport(target.id, patch);
    if (ok.ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSheet(null);
    } else setErr(t('rpt.errUpdate'));
  };

  const toggleEnabled = async (r: ScheduledReport) => {
    const ok = await updateReport(r.id, { enabled: !r.enabled });
    if (!ok.ok) setErr(t('rpt.errUpdate'));
  };

  const confirmDelete = async () => {
    if (!target) return;
    const ok = await deleteReport(target.id);
    if (ok.ok) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setSheet(null);
  };

  const typeLabel = (rt: ReportType) => TYPE_OPTIONS.find((o) => o.key === rt)?.label ?? 'rpt.typeRevenue';
  const cadenceLabel = (c: ReportCadence) => CADENCE_OPTIONS.find((o) => o.key === c)?.label ?? 'rpt.cadenceDaily';

  return (
    <Screen>
      <FlatList
        data={reports}
        keyExtractor={(r) => r.id}
        contentContainerStyle={{ padding: Spacing.md, gap: 10, paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        ListEmptyComponent={<Empty icon="document-text-outline" title={t('rpt.empty')} sub={t('rpt.emptySub')} />}
        renderItem={({ item }) => (
          <Card>
            <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <View style={{ flex: 1, gap: 6 }}>
                <Row gap={6}>
                  <Icon name="document-text-outline" size={16} color={Colors.primaryDark} />
                  <Text style={{ flex: 1, fontSize: FontSize.md, fontWeight: '700', color: Colors.text }} numberOfLines={1}>
                    {item.name}
                  </Text>
                </Row>
                <Row gap={6} style={{ flexWrap: 'wrap' }}>
                  <Pill label={t(typeLabel(item.reportType))} tone="info" />
                  <Pill label={t(cadenceLabel(item.cadence))} tone="neutral" />
                  <Pill label={item.format.toUpperCase()} tone="neutral" />
                  <Pill label={t(item.enabled ? 'rpt.enabled' : 'rpt.disabled')} tone={item.enabled ? 'success' : 'warning'} />
                </Row>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                  {item.lastRunAt ? t('rpt.lastRun', { when: timeAgo(new Date(item.lastRunAt).getTime()) }) : t('rpt.neverRun')}
                  {item.recipients?.length ? ` · ${item.recipients.length} ${t('rpt.recipientShort')}` : ''}
                </Text>
              </View>
              <Row gap={6}>
                <Pressable hitSlop={8} onPress={() => toggleEnabled(item)} accessibilityRole="button" accessibilityLabel={t('rpt.toggle')}>
                  <Icon name={item.enabled ? 'pause-circle-outline' : 'play-circle-outline'} size={22} color={item.enabled ? Colors.warning : Colors.success} />
                </Pressable>
                <Pressable hitSlop={8} onPress={() => openEdit(item)} accessibilityRole="button" accessibilityLabel={t('common.edit')}>
                  <Icon name="create-outline" size={20} color={Colors.textSecondary} />
                </Pressable>
                <Pressable
                  hitSlop={8}
                  onPress={() => { setTarget(item); setErr(''); setSheet('delete'); }}
                  accessibilityRole="button"
                  accessibilityLabel={t('common.delete')}>
                  <Icon name="trash-outline" size={20} color={Colors.danger} />
                </Pressable>
              </Row>
            </Row>
          </Card>
        )}
      />

      <View style={styles.footer}>
        <Btn label={t('rpt.add')} size="lg" icon="add" onPress={openAdd} />
      </View>

      <SheetModal visible={sheet === 'add'} onClose={() => setSheet(null)} title={t('rpt.add')}>
        <View style={{ gap: Spacing.md }}>
          <Field label={t('rpt.name')} value={name} onChangeText={setName} placeholder={t('rpt.namePh')} maxLength={160} />
          <Text style={styles.label}>{t('rpt.type')}</Text>
          <Segmented options={TYPE_OPTIONS} value={type} onChange={setType} />
          <Text style={styles.label}>{t('rpt.cadence')}</Text>
          <Segmented options={CADENCE_OPTIONS} value={cadence} onChange={setCadence} />
          <Text style={styles.label}>{t('rpt.format')}</Text>
          <Segmented options={FORMAT_OPTIONS} value={format} onChange={setFormat} equal />
          <Field label={t('rpt.recipients')} value={recipients} onChangeText={setRecipients} />
          {err ? <Text style={{ fontSize: FontSize.sm, color: Colors.danger }}>{err}</Text> : null}
          <Row gap={Spacing.md}>
            <Btn label={t('common.cancel')} size="lg" variant="subtle" style={{ flex: 1 }} onPress={() => setSheet(null)} />
            <Btn label={t('common.add')} size="lg" style={{ flex: 1 }} onPress={save} />
          </Row>
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'edit'} onClose={() => setSheet(null)} title={t('rpt.editTitle')}>
        <View style={{ gap: Spacing.md }}>
          <Field label={t('rpt.name')} value={name} onChangeText={setName} maxLength={160} />
          <Text style={styles.label}>{t('rpt.cadence')}</Text>
          <Segmented options={CADENCE_OPTIONS} value={cadence} onChange={setCadence} />
          <Text style={styles.label}>{t('rpt.format')}</Text>
          <Segmented options={FORMAT_OPTIONS} value={format} onChange={setFormat} equal />
          <Field label={t('rpt.recipients')} value={recipients} onChangeText={setRecipients} />
          {err ? <Text style={{ fontSize: FontSize.sm, color: Colors.danger }}>{err}</Text> : null}
          <Row gap={Spacing.md}>
            <Btn label={t('common.cancel')} size="lg" variant="subtle" style={{ flex: 1 }} onPress={() => setSheet(null)} />
            <Btn label={t('common.save')} size="lg" style={{ flex: 1 }} onPress={saveEdit} />
          </Row>
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'delete'} onClose={() => setSheet(null)} title={t('rpt.deleteTitle')}>
        <Text style={{ fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22 }}>
          {t('rpt.deleteSub', { name: target?.name ?? '' })}
        </Text>
        <Row gap={Spacing.md}>
          <Btn label={t('common.cancel')} size="lg" variant="subtle" style={{ flex: 1 }} onPress={() => setSheet(null)} />
          <Btn label={t('common.delete')} size="lg" variant="danger" style={{ flex: 1 }} onPress={confirmDelete} />
        </Row>
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  footer: {
    padding: Spacing.lg,
    paddingBottom: 28,
    backgroundColor: Colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
});
