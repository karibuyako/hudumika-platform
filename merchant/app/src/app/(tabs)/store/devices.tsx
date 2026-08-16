import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Chip, Empty, Field, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import type { IconName } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import type { MerchantDevice, MerchantDeviceInput, MerchantDeviceType } from '@/api/types';
import { useDevicesStore } from '@/store/devices';
import { useMessageStore } from '@/store/messages';

const TYPE_ICON: Record<MerchantDeviceType, IconName> = {
  printer: 'print-outline',
  pos: 'cash-outline',
  kitchen_display: 'tv-outline',
  cashier_terminal: 'card-outline',
};

const TYPE_LABEL: Record<MerchantDeviceType, I18nKey> = {
  printer: 'dev.typePrinter',
  pos: 'dev.typePos',
  kitchen_display: 'dev.typeKitchenDisplay',
  cashier_terminal: 'dev.typeCashierTerminal',
};

const DEVICE_TYPES: MerchantDeviceType[] = ['printer', 'pos', 'kitchen_display', 'cashier_terminal'];

const STATUS_PILL: Record<MerchantDevice['status'], { label: I18nKey; tone: 'neutral' | 'danger' | 'success' | 'info' | 'warning' }> = {
  online: { label: 'common.online', tone: 'success' },
  offline: { label: 'common.offline', tone: 'neutral' },
  error: { label: 'dev.statusError', tone: 'danger' },
  pairing: { label: 'common.pairing', tone: 'warning' },
};

export default function DevicesScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const devices = useDevicesStore((s) => s.devices);
  const addDevice = useDevicesStore((s) => s.add);
  const updateDevice = useDevicesStore((s) => s.update);
  const removeDevice = useDevicesStore((s) => s.remove);
  const hydrate = useDevicesStore((s) => s.hydrate);
  const pushMessage = useMessageStore((s) => s.push);

  const [sheet, setSheet] = useState<null | 'add' | 'edit' | 'delete'>(null);
  const [target, setTarget] = useState<MerchantDevice | null>(null);
  const [label, setLabel] = useState('');
  const [type, setType] = useState<MerchantDeviceType>('printer');
  const [purpose, setPurpose] = useState<MerchantDevice['purpose']>('receipt');
  const [paperSize, setPaperSize] = useState<MerchantDevice['paperSize']>('80mm');
  const [copies, setCopies] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    hydrate().then(() => setLoadFailed(false)).catch(() => setLoadFailed(true));
  }, [hydrate]);

  const resetForm = () => {
    setLabel('');
    setType('printer');
    setPurpose('receipt');
    setPaperSize('80mm');
    setCopies(1);
    setError('');
  };

  const openAdd = () => {
    resetForm();
    setSheet('add');
  };

  const openEdit = (d: MerchantDevice) => {
    setTarget(d);
    setLabel(d.label);
    setType(d.type);
    setPurpose(d.purpose ?? 'receipt');
    setPaperSize(d.paperSize ?? '80mm');
    setCopies(d.copies ?? 1);
    setError('');
    setSheet('edit');
  };

  const save = async () => {
    if (!label.trim()) return;
    setBusy(true);
    setError('');
    const input: MerchantDeviceInput = { type, label: label.trim(), purpose, paperSize, copies };
    const res = target ? await updateDevice(target.id, input) : await addDevice(input);
    setBusy(false);
    if (res.ok) {
      setSheet(null);
      setTarget(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({
        type: 'system',
        title: target ? t('dev.saved') : t('dev.registered'),
        body: target ? t('dev.savedSub', { name: label.trim() }) : t('dev.registeredSub', { name: label.trim() }),
      });
    } else {
      setError(res.message ?? t('dev.errSave'));
    }
  };

  const remove = async () => {
    if (!target) return;
    setBusy(true);
    setError('');
    const res = await removeDevice(target.id);
    setBusy(false);
    if (res.ok) {
      setSheet(null);
      setTarget(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      setError(res.message ?? t('dev.errDelete'));
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('dev.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <Row style={{ justifyContent: 'space-between', marginTop: Spacing.md }}>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, flex: 1 }}>{t('dev.sub')}</Text>
          <Btn label={t('dev.add')} icon="add" size="sm" onPress={openAdd} />
        </Row>

        {loadFailed ? (
          <View style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.lg }}>
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('dev.errLoad')}</Text>
            <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => hydrate()} />
          </View>
        ) : null}

        <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
          {devices.length === 0 ? <Empty icon="hardware-chip-outline" title={t('dev.empty')} sub={t('dev.emptySub')} /> : null}
          {devices.map((d) => (
            <Card key={d.id} style={{ gap: Spacing.sm }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Row gap={10} style={{ flex: 1 }}>
                  <View style={styles.iconBox}>
                    <Icon name={TYPE_ICON[d.type]} size={18} color={Colors.info} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.name} numberOfLines={1}>{d.label}</Text>
                    <Text style={styles.meta}>
                      {t(TYPE_LABEL[d.type])} · {d.purpose === 'kitchen' ? t('dev.purposeKitchen') : t('dev.purposeReceipt')} · {d.paperSize ?? '80mm'} · {t('prn.copies', { copies: d.copies ?? 1 })}
                    </Text>
                  </View>
                </Row>
                <Pill label={t(STATUS_PILL[d.status].label)} tone={STATUS_PILL[d.status].tone} />
              </Row>
              <Row gap={Spacing.sm}>
                <Btn label={t('common.edit')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => openEdit(d)} />
                <Btn
                  label={t('common.remove')}
                  variant="danger"
                  size="sm"
                  style={{ flex: 1 }}
                  onPress={() => {
                    setTarget(d);
                    setError('');
                    setSheet('delete');
                  }}
                />
              </Row>
            </Card>
          ))}
        </View>
      </Screen>

      <SheetModal
        visible={sheet === 'add' || sheet === 'edit'}
        onClose={() => setSheet(null)}
        title={sheet === 'edit' ? t('dev.editTitle') : t('dev.addTitle')}>
        <View style={{ gap: Spacing.md }}>
          <Field label={t('dev.label')} value={label} onChangeText={setLabel} placeholder={t('dev.labelPh')} maxLength={80} />
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('dev.type')}</Text>
            <Row gap={8} style={{ flexWrap: 'wrap' }}>
              {DEVICE_TYPES.map((dt) => (
                <Chip key={dt} label={t(TYPE_LABEL[dt])} selected={type === dt} onPress={() => setType(dt)} />
              ))}
            </Row>
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('dev.purpose')}</Text>
            <Row gap={8}>
              <Chip label={t('dev.purposeReceipt')} selected={purpose === 'receipt'} onPress={() => setPurpose('receipt')} />
              <Chip label={t('dev.purposeKitchen')} selected={purpose === 'kitchen'} onPress={() => setPurpose('kitchen')} />
            </Row>
          </View>
          {type === 'printer' ? (
            <>
              <View style={{ gap: Spacing.sm }}>
                <Text style={styles.fieldLabel}>{t('prn.paperSize')}</Text>
                <Row gap={8}>
                  {(['58mm', '80mm'] as const).map((s) => (
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
            </>
          ) : null}
          {error ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{error}</Text> : null}
          <Btn label={t('common.save')} size="lg" loading={busy} disabled={!label.trim()} onPress={save} />
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'delete'} onClose={() => setSheet(null)} title={t('dev.deleteTitle')}>
        <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 19 }}>
          {t('dev.deleteBody', { name: target?.label ?? '' })}
        </Text>
        {error ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs, textAlign: 'center' }}>{error}</Text> : null}
        <Row gap={Spacing.sm}>
          <Btn label={t('prn.cancel')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => setSheet(null)} />
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
    backgroundColor: Colors.infoSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flexShrink: 1 },
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
