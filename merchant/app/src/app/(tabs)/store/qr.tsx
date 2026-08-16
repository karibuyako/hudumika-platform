import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Chip, Empty, Icon, Pill, Row, Screen, SheetModal, ToggleRow } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { api, ApiError } from '@/api/client';
import type { StoreListItem, StoreQrCode, StoreQrCodeKindInput, StoreServer, TableRow } from '@/api/types';
import { useStoreStore } from '@/store/store';

type QrOrdering = StoreServer['qrOrdering'];

const QR_KINDS: StoreQrCodeKindInput[] = ['ordering', 'collection', 'download', 'review'];
const KIND_LABEL: Record<StoreQrCodeKindInput, I18nKey> = {
  ordering: 'qr.kindOrdering',
  collection: 'qr.kindCollection',
  download: 'qr.kindDownload',
  review: 'qr.kindReview',
};

export default function QrScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const [stores, setStores] = useState<StoreListItem[]>([]);
  const [storeId, setStoreId] = useState('s_demo');
  const [qrOrdering, setQrOrdering] = useState<QrOrdering>({ enabled: false, type: 'table', urlPattern: 'https://order.example.com/q' });
  const [tables, setTables] = useState<TableRow[]>([]);
  const [urlDraft, setUrlDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyQr, setBusyQr] = useState('');
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState('');
  const [copiedStore, setCopiedStore] = useState(false);
  const [busyStoreQr, setBusyStoreQr] = useState(false);
  const [qrPayloads, setQrPayloads] = useState<Record<string, { qrPayload: string; menuUrl: string }>>({});

  const qrCodes = useStoreStore((s) => s.qrCodes);
  const loadQrCodes = useStoreStore((s) => s.loadQrCodes);
  const createQrCode = useStoreStore((s) => s.createQrCode);
  const deleteQrCode = useStoreStore((s) => s.deleteQrCode);
  const [qrKind, setQrKind] = useState<StoreQrCodeKindInput>('ordering');
  const [busyQrCode, setBusyQrCode] = useState(false);
  const [delQrTarget, setDelQrTarget] = useState<StoreQrCode | null>(null);
  const [busyDelQr, setBusyDelQr] = useState(false);

  /* Store QR card — sourced from the contract QR list (GET /store/qr-codes):
   * the ordering-kind code is the store's scan-to-order QR. */
  const orderingQr = qrCodes.find((q) => q.kind === 'ordering') ?? null;
  const storeQr = qrOrdering.type === 'counter' && orderingQr ? { qrUrl: orderingQr.qrPayload, qrToken: '' } : null;

  useEffect(() => {
    api
      .get<{ stores: StoreListItem[] }>('/stores', { retries: 1 })
      .then((r) => setStores(r.stores))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    api
      .get<{ qrOrdering: QrOrdering }>(`/stores/${storeId}/qr-ordering`, { retries: 1 })
      .then((r) => {
        setQrOrdering(r.qrOrdering);
        setUrlDraft(r.qrOrdering.urlPattern);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : t('qr.errLoad')));
    api
      .get<{ tables: TableRow[] }>(`/dine-in/tables?storeId=${storeId}`, { retries: 1 })
      .then(async (r) => {
        setTables(r.tables);
        /* Contract QR (DINE-IN.md): payload + menu URL come from the API. */
        const payloads: Record<string, { qrPayload: string; menuUrl: string }> = {};
        await Promise.all(
          r.tables.map(async (tb) => {
            try {
              const qr = await api.get<{ qrPayload: string; menuUrl: string }>(`/dine-in/tables/${tb.id}/qr`, { retries: 1 });
              payloads[tb.id] = qr;
            } catch {
              /* table without a QR payload — the row url is shown instead */
            }
          }),
        );
        setQrPayloads(payloads);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : t('tbl.errLoad')));
  }, [storeId]);

  useEffect(() => {
    loadQrCodes(storeId);
  }, [storeId, loadQrCodes]);

  const generateQrCode = async () => {
    setBusyQrCode(true);
    setError('');
    const created = await createQrCode(qrKind, storeId);
    setBusyQrCode(false);
    if (created) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      setError(t('qr.errCreateCode'));
    }
  };

  const confirmDeleteQr = async () => {
    if (!delQrTarget) return;
    setBusyDelQr(true);
    setError('');
    const ok = await deleteQrCode(delQrTarget.id, storeId);
    setBusyDelQr(false);
    if (ok) {
      setDelQrTarget(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      setError(t('qr.errDelete'));
    }
  };

  const onStoreChange = (sid: string) => {
    setCopiedId('');
    setCopiedStore(false);
    setStoreId(sid);
  };

  const patch = async (body: Partial<QrOrdering>) => {
    setBusy(true);
    setError('');
    try {
      const r = await api.patch<{ qrOrdering: QrOrdering }>(`/stores/${storeId}/qr-ordering`, body);
      setQrOrdering(r.qrOrdering);
      setUrlDraft(r.qrOrdering.urlPattern);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('qr.errSave'));
    } finally {
      setBusy(false);
    }
  };

  const saveUrl = async () => {
    if (!urlDraft.trim()) return;
    await patch({ urlPattern: urlDraft.trim() });
  };

  const copy = async (t: TableRow) => {
    await Clipboard.setStringAsync(qrPayloads[t.id]?.qrPayload ?? t.qrUrl);
    setCopiedId(t.id);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const regen = async (tb: TableRow) => {
    setBusyQr(tb.id);
    setError('');
    try {
      const r = await api.post<{ table: TableRow }>(`/tables/${tb.id}/qr`);
      setTables((list) => list.map((x) => (x.id === r.table.id ? r.table : x)));
      const qr = await api.get<{ qrPayload: string; menuUrl: string }>(`/dine-in/tables/${tb.id}/qr`, { retries: 1 });
      setQrPayloads((p) => ({ ...p, [tb.id]: qr }));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('qr.errAdd'));
    } finally {
      setBusyQr('');
    }
  };

  const copyStoreQr = async () => {
    if (!storeQr) return;
    await Clipboard.setStringAsync(storeQr.qrUrl);
    setCopiedStore(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const regenStoreQr = async () => {
    setBusyStoreQr(true);
    setError('');
    try {
      const previous = qrCodes.find((q) => q.kind === 'ordering') ?? null;
      const created = await createQrCode('ordering', storeId);
      if (!created) throw new Error('create failed');
      if (previous) await deleteQrCode(previous.id, storeId);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('qr.errAdd'));
    } finally {
      setBusyStoreQr(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('qr.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {stores.map((s) => (
            <Chip key={s.id} label={s.name} selected={storeId === s.id} onPress={() => onStoreChange(s.id)} />
          ))}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {qrOrdering.type === 'counter' && storeQr ? (
          <Card style={{ gap: Spacing.sm, marginTop: Spacing.md }}>
            <Row gap={10}>
              <View style={styles.storeQrIcon}>
                <Icon name="qr-code-outline" size={18} color={Colors.success} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.tableName} numberOfLines={1}>{t('qr.storeQr')}</Text>
                <Text style={styles.qrUrl} numberOfLines={1}>{storeQr.qrUrl}</Text>
              </View>
            </Row>
            <Row gap={Spacing.sm}>
              <Btn label={copiedStore ? t('qr.copied') : t('qr.copy')} variant="outline" size="sm" style={{ flex: 1 }} onPress={copyStoreQr} />
              <Btn label={t('qr.regenerate')} variant="subtle" size="sm" style={{ flex: 1 }} loading={busyStoreQr} onPress={regenStoreQr} />
            </Row>
          </Card>
        ) : null}

        <Card style={{ paddingVertical: 0, overflow: 'hidden', paddingHorizontal: Spacing.lg, marginTop: Spacing.md }}>
          <ToggleRow label={t('qr.title')} sub={t('qr.sub')} value={qrOrdering.enabled} onChange={(v) => patch({ enabled: v })} />
          <View style={styles.divider} />
          <View style={{ paddingVertical: Spacing.md, gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('qr.mode')}</Text>
            <Row gap={8}>
              <Chip label={t('qr.table')} selected={qrOrdering.type === 'table'} onPress={() => patch({ type: 'table' })} tone="info" />
              <Chip label={t('qr.counter')} selected={qrOrdering.type === 'counter'} onPress={() => patch({ type: 'counter' })} tone="info" />
            </Row>
          </View>
          <View style={styles.divider} />
          <View style={{ paddingVertical: Spacing.md, gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('qr.urlPattern')}</Text>
            <TextInput
              value={urlDraft}
              onChangeText={setUrlDraft}
              placeholder="https://order.example.com/q"
              placeholderTextColor={Colors.textTertiary}
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              maxLength={120}
            />
            <Row style={{ justifyContent: 'flex-end' }}>
              <Btn label={t('qr.saveUrl')} size="sm" loading={busy} disabled={urlDraft.trim() === qrOrdering.urlPattern || !urlDraft.trim()} onPress={saveUrl} />
            </Row>
            <Text style={styles.hint}>{t('qr.urlHint')}</Text>
          </View>
        </Card>

        <View style={{ gap: Spacing.sm, marginTop: Spacing.lg }}>
          <Text style={styles.sectionLabel}>{t('qr.tableCodes', { n: tables.length })}</Text>
          {tables.length === 0 ? <Empty icon="qr-code-outline" title={t('qr.empty')} sub={t('qr.emptySub')} /> : null}
          {tables.map((tb) => (
            <Card key={tb.id} style={{ gap: Spacing.sm }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.tableName} numberOfLines={1}>{tb.label ?? tb.name}{tb.zone ? ` · ${tb.zone}` : ''}</Text>
                  <Text style={styles.qrUrl} numberOfLines={1}>{qrPayloads[tb.id]?.qrPayload ?? tb.qrUrl}</Text>
                </View>
                <Pill
                  label={tb.disabled ? t('tbl.disabled') : tb.status === 'idle' ? t('tbl.idle') : tb.status === 'occupied' ? t('tbl.occupied') : t('tbl.reserved')}
                  tone={tb.disabled ? 'neutral' : tb.status === 'idle' ? 'success' : tb.status === 'occupied' ? 'danger' : 'warning'}
                />
              </Row>
              <Row gap={Spacing.sm}>
                <Btn label={copiedId === tb.id ? t('qr.copied') : t('qr.copy')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => copy(tb)} />
                <Btn label={t('qr.newQr')} variant="subtle" size="sm" style={{ flex: 1 }} loading={busyQr === tb.id} onPress={() => regen(tb)} />
              </Row>
            </Card>
          ))}
          <Text style={styles.note}>{t('qr.demoNote')}</Text>
        </View>

        {/* Store QR codes (contract /store/qr-codes) */}
        <View style={{ gap: Spacing.sm, marginTop: Spacing.lg }}>
          <Text style={styles.sectionLabel}>{t('qr.storeCodes', { n: qrCodes.length })}</Text>
          <Card style={{ paddingVertical: Spacing.md, gap: Spacing.sm, paddingHorizontal: Spacing.lg }}>
            <Text style={styles.fieldLabel}>{t('qr.mode')}</Text>
            <Row gap={8} style={{ flexWrap: 'wrap' }}>
              {QR_KINDS.map((k) => (
                <Chip key={k} label={t(KIND_LABEL[k])} selected={qrKind === k} onPress={() => setQrKind(k)} tone="info" />
              ))}
            </Row>
            <Row style={{ justifyContent: 'flex-end' }}>
              <Btn label={t('qr.generate')} icon="qr-code-outline" size="sm" loading={busyQrCode} onPress={generateQrCode} />
            </Row>
          </Card>
          {qrCodes.length === 0 ? <Empty icon="qr-code-outline" title={t('qr.emptyCodes')} sub={t('qr.emptyCodesSub')} /> : null}
          {qrCodes.map((qr) => (
            <Card key={qr.id} style={{ gap: Spacing.sm }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Row gap={8} style={{ flex: 1 }}>
                  <Icon name="qr-code-outline" size={15} color={Colors.textSecondary} />
                  <Text style={styles.tableName} numberOfLines={1}>{t(KIND_LABEL[qr.kind as StoreQrCodeKindInput] ?? 'qr.kindOrdering')}</Text>
                  <Pill label={qr.kind} tone="neutral" />
                </Row>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                  {qr.createdBy ? t('qr.createdBy', { who: qr.createdBy }) : ''}
                </Text>
              </Row>
              <Text style={styles.qrUrl} numberOfLines={1}>{qr.qrPayload}</Text>
              <Row style={{ justifyContent: 'flex-end' }}>
                <Btn label={t('qr.deleteCode')} variant="danger" size="sm" onPress={() => setDelQrTarget(qr)} />
              </Row>
            </Card>
          ))}
        </View>
      </Screen>

      <SheetModal visible={delQrTarget !== null} onClose={() => setDelQrTarget(null)} title={t('qr.deleteCode')}>
        <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 19 }}>
          {t('qr.deleteBody', { kind: delQrTarget ? t(KIND_LABEL[delQrTarget.kind as StoreQrCodeKindInput] ?? 'qr.kindOrdering') : '' })}
        </Text>
        <Row gap={Spacing.sm}>
          <Btn label={t('common.cancel')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => setDelQrTarget(null)} />
          <Btn label={t('qr.deleteCode')} variant="danger" size="sm" style={{ flex: 1 }} loading={busyDelQr} onPress={confirmDeleteQr} />
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
  error: { color: Colors.danger, fontSize: FontSize.xs, marginTop: Spacing.sm },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border },
  fieldLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 11,
    fontSize: FontSize.sm,
    color: Colors.text,
    backgroundColor: Colors.card,
  },
  hint: { fontSize: FontSize.xs, color: Colors.textTertiary },
  storeQrIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: Colors.successSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '700', letterSpacing: 0.5 },
  tableName: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flexShrink: 1 },
  qrUrl: { fontSize: FontSize.xs, color: Colors.textTertiary },
  note: { fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'center', lineHeight: 16, paddingTop: Spacing.sm },
});
