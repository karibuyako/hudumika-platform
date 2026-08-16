import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Chip, Empty, Field, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import type { IconName } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { api, ApiError } from '@/api/client';
import type { Printer, StoreListItem } from '@/api/types';

const TYPE_ICON: Record<Printer['type'], IconName> = { bluetooth: 'bluetooth', network: 'wifi-outline', cloud: 'cloud-outline' };
const TYPE_LABEL: Record<Printer['type'], I18nKey> = { bluetooth: 'prn.typeBluetooth', network: 'prn.typeNetwork', cloud: 'prn.typeCloud' };
const PURPOSE_LABEL: Record<Printer['purpose'], I18nKey> = { receipt: 'prn.purposeReceipt', kitchen: 'prn.purposeKitchen' };
const PRINTER_TYPES: Printer['type'][] = ['bluetooth', 'network', 'cloud'];
const PURPOSES: Printer['purpose'][] = ['receipt', 'kitchen'];
const PAPER_SIZES: Printer['paperSize'][] = ['58mm', '80mm'];

export default function PrintersScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const [stores, setStores] = useState<StoreListItem[]>([]);
  const [storeId, setStoreId] = useState('s_demo');
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [sheet, setSheet] = useState<null | 'add' | 'delete'>(null);
  const [target, setTarget] = useState<Printer | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<Printer['type']>('bluetooth');
  const [purpose, setPurpose] = useState<Printer['purpose']>('receipt');
  const [paperSize, setPaperSize] = useState<Printer['paperSize']>('80mm');
  const [copies, setCopies] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sheetError, setSheetError] = useState('');
  const [testMsg, setTestMsg] = useState('');

  useEffect(() => {
    api
      .get<{ stores: StoreListItem[] }>('/stores', { retries: 1 })
      .then((r) => setStores(r.stores))
      .catch(() => undefined);
  }, []);

  const load = useCallback(async (sid: string) => {
    setPrinters([]);
    setTestMsg('');
    setError('');
    try {
      const r = await api.get<{ printers: Printer[] }>(`/printers?storeId=${sid}`, { retries: 1 });
      setPrinters(r.printers);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('prn.errLoad'));
    }
  }, []);

  useEffect(() => {
    api
      .get<{ printers: Printer[] }>(`/printers?storeId=${storeId}`, { retries: 1 })
      .then((r) => setPrinters(r.printers))
      .catch((e) => setError(e instanceof ApiError ? e.message : t('prn.errLoad')));
  }, [storeId]);

  const onStoreChange = (sid: string) => {
    setTestMsg('');
    setStoreId(sid);
  };

  const connect = async (p: Printer) => {
    setBusy(true);
    setError('');
    setTestMsg('');
    try {
      await api.post(`/devices/${p.id}/pair`);
      await load(storeId);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('prn.errConnect'));
    } finally {
      setBusy(false);
    }
  };

  const test = async (p: Printer) => {
    setBusy(true);
    setError('');
    setTestMsg('');
    try {
      await api.post(`/devices/${p.id}/test`);
      setTestMsg(t('prn.testSent'));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('prn.errTest'));
    } finally {
      setBusy(false);
    }
  };

  const setDefault = async (p: Printer) => {
    setBusy(true);
    setError('');
    try {
      await api.patch(`/printers/${p.id}`, { isDefault: true });
      await load(storeId);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('prn.errDefault'));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setSheetError('');
    try {
      await api.post('/printers', { storeId, name: name.trim(), type, purpose, paperSize, copies });
      setSheet(null);
      setName('');
      setType('bluetooth');
      setPurpose('receipt');
      setPaperSize('80mm');
      setCopies(1);
      await load(storeId);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setSheetError(e instanceof ApiError ? e.message : t('prn.errAdd'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!target) return;
    setBusy(true);
    setSheetError('');
    try {
      await api.delete(`/printers/${target.id}`);
      setSheet(null);
      setTarget(null);
      await load(storeId);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setSheetError(e instanceof ApiError ? e.message : t('prn.errDelete'));
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
        <Text style={styles.topTitle}>{t('prn.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {stores.map((s) => (
            <Chip key={s.id} label={s.name} selected={storeId === s.id} onPress={() => onStoreChange(s.id)} />
          ))}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {testMsg ? <Text style={styles.testMsg}>{testMsg}</Text> : null}

        <Row style={{ justifyContent: 'space-between', marginTop: Spacing.md }}>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, flex: 1 }}>
            {t('prn.sub')}
          </Text>
          <Btn
            label={t('prn.add')}
            icon="add"
            size="sm"
            onPress={() => {
              setName('');
              setType('bluetooth');
              setPurpose('receipt');
              setPaperSize('80mm');
              setCopies(1);
              setSheetError('');
              setSheet('add');
            }}
          />
        </Row>

        <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
          {printers.length === 0 ? <Empty icon="print-outline" title={t('prn.empty')} sub={t('prn.emptySub')} /> : null}
          {printers.map((p) => (
            <Card key={p.id} style={{ gap: Spacing.sm }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Row gap={10} style={{ flex: 1 }}>
                  <View style={styles.iconBox}>
                    <Icon name={TYPE_ICON[p.type]} size={18} color={Colors.info} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Row gap={6}>
                      <Text style={styles.name} numberOfLines={1}>{p.name}</Text>
                      {p.isDefault ? <Text style={styles.star}>{t('prn.default')}</Text> : null}
                    </Row>
                    <Text style={styles.meta}>
                      {t(TYPE_LABEL[p.type])} · {t(PURPOSE_LABEL[p.purpose])} · {p.paperSize} · {t('prn.copies', { copies: p.copies })}
                    </Text>
                  </View>
                </Row>
                <Pill
                  label={p.status === 'connected' ? t('prn.connected') : p.status === 'pairing' ? t('prn.pairing') : t('prn.offline')}
                  tone={p.status === 'connected' ? 'success' : p.status === 'pairing' ? 'warning' : 'neutral'}
                />
              </Row>
              <Row gap={Spacing.sm}>
                {p.status === 'pairing' ? (
                  <Btn label={t('prn.connect')} variant="ghost" size="sm" style={{ flex: 1 }} loading={busy} onPress={() => connect(p)} />
                ) : null}
                {p.status === 'connected' ? (
                  <Btn label={t('prn.test')} variant="outline" size="sm" style={{ flex: 1 }} loading={busy} onPress={() => test(p)} />
                ) : null}
                {!p.isDefault ? (
                  <Btn label={t('prn.setDefault')} variant="subtle" size="sm" style={{ flex: 1 }} loading={busy} onPress={() => setDefault(p)} />
                ) : null}
                <Btn
                  label={t('prn.delete')}
                  variant="danger"
                  size="sm"
                  style={{ flex: 1 }}
                  onPress={() => {
                    setTarget(p);
                    setSheetError('');
                    setSheet('delete');
                  }}
                />
              </Row>
            </Card>
          ))}
        </View>
      </Screen>

      <SheetModal visible={sheet === 'add'} onClose={() => setSheet(null)} title={t('prn.addTitle')}>
        <View style={{ gap: Spacing.md }}>
          <Field label={t('prn.name')} value={name} onChangeText={setName} placeholder={t('prn.namePh')} maxLength={30} />
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('prn.type')}</Text>
            <Row gap={8} style={{ flexWrap: 'wrap' }}>
              {PRINTER_TYPES.map((pt) => (
                <Chip key={pt} label={t(TYPE_LABEL[pt])} selected={type === pt} onPress={() => setType(pt)} />
              ))}
            </Row>
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('prn.purpose')}</Text>
            <Row gap={8}>
              {PURPOSES.map((pu) => (
                <Chip key={pu} label={t(PURPOSE_LABEL[pu])} selected={purpose === pu} onPress={() => setPurpose(pu)} />
              ))}
            </Row>
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('prn.paperSize')}</Text>
            <Row gap={8}>
              {PAPER_SIZES.map((s) => (
                <Chip key={s} label={s} selected={paperSize === s} onPress={() => setPaperSize(s)} />
              ))}
            </Row>
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('prn.copiesLabel')}</Text>
            <Row gap={8}>
              <Pressable onPress={() => setCopies(Math.max(1, copies - 1))} style={styles.stepBtn}>
                <Text style={styles.stepText}>−</Text>
              </Pressable>
              <Text style={styles.stepValue}>{copies}</Text>
              <Pressable onPress={() => setCopies(Math.min(5, copies + 1))} style={styles.stepBtn}>
                <Text style={styles.stepText}>+</Text>
              </Pressable>
            </Row>
          </View>
          {sheetError ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{sheetError}</Text> : null}
          <Btn label={t('prn.add')} size="lg" loading={busy} disabled={!name.trim()} onPress={add} />
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'delete'} onClose={() => setSheet(null)} title={t('prn.deleteTitle')}>
        <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 19 }}>
          {t('prn.deleteBody', { name: target?.name ?? '' })}
        </Text>
        {sheetError ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs, textAlign: 'center' }}>{sheetError}</Text> : null}
        <Row gap={Spacing.sm}>
          <Btn label={t('prn.cancel')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => setSheet(null)} />
          <Btn label={t('prn.delete')} variant="danger" size="sm" style={{ flex: 1 }} loading={busy} onPress={remove} />
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
  testMsg: { color: Colors.success, fontSize: FontSize.xs, fontWeight: '700', marginTop: Spacing.sm },
  iconBox: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: Colors.infoSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flexShrink: 1 },
  star: { fontSize: FontSize.xs, color: Colors.gold, fontWeight: '700' },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary },
  fieldLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  stepBtn: {
    width: 36,
    height: 36,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.card,
  },
  stepText: { fontSize: 20, color: Colors.text },
  stepValue: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.text, minWidth: 40, textAlign: 'center' },
});
