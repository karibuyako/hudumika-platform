import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { FlatList, Linking, Platform, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import type { DataExportFormat, DataExportJob, DataExportScope, DataExportStatus } from '@/api/types';
import { Btn, Card, Empty, Icon, Pill, Row, Screen, Segmented, SheetModal } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { timeAgo } from '@/lib/format';
import { useReportsStore } from '@/store/reports';

type Sheet = null | 'add';

const SCOPE_OPTIONS: { key: DataExportScope; label: I18nKey }[] = [
  { key: 'all', label: 'dex.scopeAll' },
  { key: 'orders', label: 'dex.scopeOrders' },
  { key: 'customers', label: 'dex.scopeCustomers' },
  { key: 'catalogue', label: 'dex.scopeCatalogue' },
  { key: 'financial', label: 'dex.scopeFinancial' },
];

const FORMAT_OPTIONS: { key: DataExportFormat; label: string }[] = [
  { key: 'csv', label: 'CSV' },
  { key: 'xlsx', label: 'XLSX' },
  { key: 'json', label: 'JSON' },
];

const STATUS_META: Record<DataExportStatus, { label: I18nKey; tone: 'neutral' | 'info' | 'success' | 'danger' }> = {
  queued: { label: 'dex.statusQueued', tone: 'neutral' },
  processing: { label: 'dex.statusProcessing', tone: 'info' },
  ready: { label: 'dex.statusReady', tone: 'success' },
  failed: { label: 'dex.statusFailed', tone: 'danger' },
};

export default function ExportsScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const dataExports = useReportsStore((s) => s.dataExports);
  const hydrate = useReportsStore((s) => s.hydrate);
  const createDataExport = useReportsStore((s) => s.createDataExport);

  const [sheet, setSheet] = useState<Sheet>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [scope, setScope] = useState<DataExportScope>('all');
  const [format, setFormat] = useState<DataExportFormat>('csv');
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
    setScope('all');
    setFormat('csv');
    setErr('');
    setSheet('add');
  };

  const save = async () => {
    const ok = await createDataExport({ scope, format });
    if (ok.ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSheet(null);
      hydrate();
    } else setErr(t('dex.errCreate'));
  };

  const openDownload = (job: DataExportJob) => {
    if (!job.downloadUrl) return;
    if (Platform.OS === 'web') {
      const a = document.createElement('a');
      a.href = job.downloadUrl;
      a.download = `export-${job.scope}-${job.id}.${job.format}`;
      a.click();
    } else {
      Linking.openURL(job.downloadUrl).catch(() => undefined);
    }
  };

  const scopeLabel = (s: DataExportScope) => SCOPE_OPTIONS.find((o) => o.key === s)?.label ?? 'dex.scopeAll';

  return (
    <Screen>
      <FlatList
        data={dataExports}
        keyExtractor={(j) => j.id}
        contentContainerStyle={{ padding: Spacing.md, gap: 10, paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        ListEmptyComponent={<Empty icon="download-outline" title={t('dex.empty')} sub={t('dex.emptySub')} />}
        renderItem={({ item }) => (
          <Card>
            <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <View style={{ flex: 1, gap: 6 }}>
                <Row gap={6}>
                  <Icon name="archive-outline" size={16} color={Colors.primaryDark} />
                  <Text style={{ flex: 1, fontSize: FontSize.md, fontWeight: '700', color: Colors.text }} numberOfLines={1}>
                    {t(scopeLabel(item.scope))} · {item.format.toUpperCase()}
                  </Text>
                  <Pill label={t(STATUS_META[item.status].label)} tone={STATUS_META[item.status].tone} />
                </Row>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                  {t('dex.requestedAt', { when: timeAgo(item.createdAt) })}
                  {item.completedAt ? ` · ${t('dex.completedAt', { when: timeAgo(item.completedAt) })}` : ''}
                  {item.expiresInSeconds ? ` · ${t('dex.expires', { sec: item.expiresInSeconds })}` : ''}
                </Text>
              </View>
              {item.status === 'ready' && item.downloadUrl ? (
                <Pressable hitSlop={8} onPress={() => openDownload(item)} accessibilityRole="button" accessibilityLabel={t('dex.download')}>
                  <Icon name="download-outline" size={22} color={Colors.success} />
                </Pressable>
              ) : null}
            </Row>
          </Card>
        )}
      />

      <View style={styles.footer}>
        <Btn label={t('dex.add')} size="lg" icon="add" onPress={openAdd} />
      </View>

      <SheetModal visible={sheet === 'add'} onClose={() => setSheet(null)} title={t('dex.add')}>
        <View style={{ gap: Spacing.md }}>
          <Text style={styles.label}>{t('dex.scope')}</Text>
          <Segmented options={SCOPE_OPTIONS} value={scope} onChange={setScope} />
          <Text style={styles.label}>{t('rpt.format')}</Text>
          <Segmented options={FORMAT_OPTIONS} value={format} onChange={setFormat} equal />
          {err ? <Text style={{ fontSize: FontSize.sm, color: Colors.danger }}>{err}</Text> : null}
          <Row gap={Spacing.md}>
            <Btn label={t('common.cancel')} size="lg" variant="subtle" style={{ flex: 1 }} onPress={() => setSheet(null)} />
            <Btn label={t('dex.add')} size="lg" style={{ flex: 1 }} onPress={save} />
          </Row>
        </View>
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
