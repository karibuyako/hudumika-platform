import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Chip, Empty, Field, Icon, Pill, Row, Screen, SheetModal, ToggleRow } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';
import { api, ApiError } from '@/api/client';
import type { ContractReceiptTemplate, ReceiptTemplate, ReceiptTemplateFields, ReceiptTemplateFont, StoreListItem, StoreServer } from '@/api/types';
import { timeAgo, tzs } from '@/lib/format';
import { useStoreStore } from '@/store/store';

/* Contract GET /store/receipt-templates returns the contract shape (fields map
 * + isActive); fold it back onto the app row so the rest of the screen is
 * untouched. */
const toAppTemplate = (t: ContractReceiptTemplate): ReceiptTemplate => ({
  id: t.id,
  storeId: '',
  name: t.name,
  headerText: t.headerText,
  footerText: t.footerText ?? '',
  logoEmoji: t.logoEmoji ?? '',
  paperSize: t.paperSize ?? '80mm',
  copies: t.copies ?? 1,
  showLogo: t.fields?.logo ?? t.showLogo ?? true,
  showQRCode: t.fields?.qrCode ?? true,
  showPayment: t.fields?.paymentMethod ?? true,
  showRider: t.fields?.cashierName ?? false,
  isDefault: t.isActive ?? false,
  updatedAt: t.createdAt ?? Date.now(),
});

const DEFAULT_FIELDS: ReceiptTemplateFields = {
  logo: true,
  storeName: true,
  address: true,
  phone: true,
  orderId: true,
  date: true,
  items: true,
  subtotal: true,
  tax: true,
  total: true,
  paymentMethod: true,
  thankYou: true,
  qrCode: false,
  cashierName: false,
};

interface Draft {
  name: string;
  headerText: string;
  footerText: string;
  logoEmoji: string;
  paperSize: ReceiptTemplate['paperSize'];
  copies: number;
  font: ReceiptTemplateFont;
  fields: ReceiptTemplateFields;
}

const PAPER_SIZES: ReceiptTemplate['paperSize'][] = ['58mm', '80mm'];
const FONTS: ReceiptTemplateFont[] = ['monospace', 'sans_serif'];

const FIELD_TOGGLES: { key: keyof ReceiptTemplateFields; label: string }[] = [
  { key: 'logo', label: t('rcpt.showLogo') },
  { key: 'storeName', label: t('rcpt.showStoreName') },
  { key: 'address', label: t('rcpt.showAddress') },
  { key: 'phone', label: t('rcpt.showPhone') },
  { key: 'orderId', label: t('rcpt.showOrderId') },
  { key: 'date', label: t('rcpt.showDate') },
  { key: 'items', label: t('rcpt.showItems') },
  { key: 'subtotal', label: t('rcpt.showSubtotal') },
  { key: 'tax', label: t('rcpt.showTax') },
  { key: 'total', label: t('rcpt.showTotal') },
  { key: 'paymentMethod', label: t('rcpt.showPayment') },
  { key: 'thankYou', label: t('rcpt.showThankYou') },
  { key: 'qrCode', label: t('rcpt.showQr') },
  { key: 'cashierName', label: t('rcpt.showRider') },
];

export default function ReceiptScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const [stores, setStores] = useState<StoreListItem[]>([]);
  const [storeId, setStoreId] = useState('s_demo');
  const [templates, setTemplates] = useState<ReceiptTemplate[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const [sheet, setSheet] = useState<null | 'new' | 'edit' | 'delete'>(null);
  const [editing, setEditing] = useState<ReceiptTemplate | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sheetError, setSheetError] = useState('');

  const updateReceiptTemplate = useStoreStore((s) => s.updateReceiptTemplate);
  const activateReceiptTemplate = useStoreStore((s) => s.activateReceiptTemplate);

  useEffect(() => {
    api
      .get<{ stores: StoreListItem[] }>('/stores', { retries: 1 })
      .then((r) => setStores(r.stores))
      .catch(() => undefined);
  }, []);

  const load = useCallback(async (sid: string) => {
    setTemplates([]);
    setActiveId(undefined);
    setDraft(null);
    setEditing(null);
    setSheet(null);
    setError('');
    try {
      const r = await api.get<ContractReceiptTemplate[]>(`/store/receipt-templates?storeId=${sid}`, { retries: 1 });
      setTemplates(r.map(toAppTemplate));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('rcpt.errLoad'));
    }
    try {
      const s = await api.get<{ store: StoreServer }>(`/stores/${sid}`, { retries: 1 });
      setActiveId(s.store.receiptTemplateId);
    } catch {
      setActiveId(undefined);
    }
  }, []);

  useEffect(() => {
    api
      .get<ContractReceiptTemplate[]>(`/store/receipt-templates?storeId=${storeId}`, { retries: 1 })
      .then((r) => setTemplates(r.map(toAppTemplate)))
      .catch((e) => setError(e instanceof ApiError ? e.message : t('rcpt.errLoad')));
    api
      .get<{ store: StoreServer }>(`/stores/${storeId}`, { retries: 1 })
      .then((r) => setActiveId(r.store.receiptTemplateId))
      .catch(() => setActiveId(undefined));
  }, [storeId]);

  const onStoreChange = (sid: string) => {
    setDraft(null);
    setEditing(null);
    setSheet(null);
    setStoreId(sid);
  };

  const patchDraft = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const patchField = (key: keyof ReceiptTemplateFields, value: boolean) =>
    setDraft((d) => (d ? { ...d, fields: { ...d.fields, [key]: value } } : d));

  const openEdit = (t: ReceiptTemplate) => {
    setEditing(t);
    setDraft({
      name: t.name,
      headerText: t.headerText,
      footerText: t.footerText,
      logoEmoji: t.logoEmoji,
      paperSize: t.paperSize,
      copies: t.copies,
      font: 'monospace',
      fields: {
        ...DEFAULT_FIELDS,
        logo: t.showLogo,
        qrCode: t.showQRCode,
        paymentMethod: t.showPayment,
        cashierName: t.showRider,
      },
    });
    setSheetError('');
    setSheet('edit');
  };

  const save = async () => {
    if (!editing || !draft) return;
    setBusy(true);
    setSheetError('');
    try {
      // Contract PUT /store/receipt-templates/{templateId} — sends the full
      // 14-field toggle set + font; the mock validates font/paperSize/copies.
      // The active flag is never changed by an update, so the assigned
      // default stays put.
      const ok = await updateReceiptTemplate(editing.id, {
        name: draft.name,
        headerText: draft.headerText,
        footerText: draft.footerText,
        logoEmoji: draft.logoEmoji,
        paperSize: draft.paperSize,
        copies: draft.copies,
        font: draft.font,
        fields: draft.fields,
      });
      if (!ok) throw new Error('update failed');
      setSheet(null);
      await load(storeId);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setSheetError(e instanceof ApiError ? e.message : t('rcpt.errUpdate'));
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    setSheetError('');
    try {
      await api.post('/store/receipt-templates', { name: newName.trim(), headerText: stores.find((s) => s.id === storeId)?.name ?? newName.trim() });
      setSheet(null);
      setNewName('');
      await load(storeId);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setSheetError(e instanceof ApiError ? e.message : t('rcpt.errCreate'));
    } finally {
      setBusy(false);
    }
  };

  const setActive = async () => {
    if (!editing) return;
    setBusy(true);
    setSheetError('');
    try {
      // Contract POST /store/receipt-templates/{templateId}/activate — flips the
      // default on for this template and off for every other one.
      const ok = await activateReceiptTemplate(editing.id);
      if (!ok) throw new Error('activate failed');
      setActiveId(editing.id);
      await load(storeId);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setSheetError(e instanceof ApiError ? e.message : t('rcpt.errActive'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing) return;
    setBusy(true);
    setSheetError('');
    try {
      await api.delete(`/store/receipt-templates/${editing.id}`);
      setSheet(null);
      setEditing(null);
      await load(storeId);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setSheetError(e instanceof ApiError ? e.message : t('rcpt.errDelete'));
    } finally {
      setBusy(false);
    }
  };

  const preview: Draft | null = draft;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('rcpt.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {stores.map((s) => (
            <Chip key={s.id} label={s.name} selected={storeId === s.id} onPress={() => onStoreChange(s.id)} />
          ))}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Row style={{ justifyContent: 'space-between', marginTop: Spacing.md }}>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, flex: 1 }}>
            {t('rcpt.sub')}
          </Text>
          <Btn
            label={t('rcpt.new')}
            icon="add"
            size="sm"
            onPress={() => {
              setNewName('');
              setSheetError('');
              setSheet('new');
            }}
          />
        </Row>

        <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
          {templates.length === 0 ? <Empty icon="receipt-outline" title={t('rcpt.empty')} sub={t('rcpt.emptySub')} /> : null}
          {templates.map((tb) => (
            <Card key={tb.id} style={{ gap: Spacing.sm }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Row gap={8} style={{ flex: 1 }}>
                  <Icon name="receipt-outline" size={15} color={Colors.textSecondary} />
                  <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.text }} numberOfLines={1}>{tb.name}</Text>
                  {tb.id === activeId ? <Pill label={t('rcpt.active')} tone="success" /> : null}
                </Row>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                  {t('rcpt.sizeCopies', { size: tb.paperSize, copies: tb.copies })}
                </Text>
              </Row>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }} numberOfLines={1}>
                {t('rcpt.header', { text: tb.headerText || '—', time: timeAgo(tb.updatedAt) })}
              </Text>
              <Row gap={Spacing.sm}>
                <Btn label={t('rcpt.edit')} size="sm" style={{ flex: 1 }} onPress={() => openEdit(tb)} />
                <Btn
                  label={t('rcpt.deleteBtn')}
                  variant="danger"
                  size="sm"
                  style={{ flex: 1 }}
                  onPress={() => {
                    setEditing(tb);
                    setSheetError('');
                    setSheet('delete');
                  }}
                />
              </Row>
            </Card>
          ))}
        </View>

        {preview ? (
          <View style={{ gap: Spacing.sm, marginTop: Spacing.lg }}>
            <Text style={styles.sectionLabel}>{t('rcpt.preview', { size: preview.paperSize })}</Text>
            <View style={styles.receipt}>
              {preview.fields.logo && preview.logoEmoji ? <Text style={styles.receiptEmoji}>{preview.logoEmoji}</Text> : null}
              <Text style={styles.receiptStore}>{preview.headerText || t('rcpt.storeName')}</Text>
              {preview.fields.address ? <Text style={styles.receiptMetaCenter}>Kariakoo, Dar es Salaam</Text> : null}
              {preview.fields.phone ? <Text style={styles.receiptMetaCenter}>+255 700 000 000</Text> : null}
              <View style={styles.dashDivider} />
              {preview.fields.orderId || preview.fields.date ? (
                <Row style={{ justifyContent: 'space-between', paddingVertical: 2 }}>
                  {preview.fields.orderId ? <Text style={styles.receiptMeta}>NO. 123456</Text> : <Text />}
                  {preview.fields.date ? <Text style={styles.receiptMeta}>2026-08-16</Text> : null}
                </Row>
              ) : null}
              {preview.fields.items ? (
                <>
                  <Row style={{ justifyContent: 'space-between', paddingVertical: 2 }}>
                    <Text style={styles.receiptItem}>Lamb Skewer ×2</Text>
                    <Text style={styles.receiptItem}>{tzs(12000)}</Text>
                  </Row>
                  <Row style={{ justifyContent: 'space-between', paddingVertical: 2 }}>
                    <Text style={styles.receiptItem}>Beef Noodles ×1</Text>
                    <Text style={styles.receiptItem}>{tzs(9500)}</Text>
                  </Row>
                </>
              ) : null}
              <View style={styles.dashDivider} />
              {preview.fields.subtotal ? (
                <Row style={{ justifyContent: 'space-between', paddingVertical: 2 }}>
                  <Text style={styles.receiptMeta}>{t('rcpt.subtotal')}</Text>
                  <Text style={styles.receiptMeta}>{tzs(21500)}</Text>
                </Row>
              ) : null}
              {preview.fields.tax ? (
                <Row style={{ justifyContent: 'space-between', paddingVertical: 2 }}>
                  <Text style={styles.receiptMeta}>{t('rcpt.showTax')}</Text>
                  <Text style={styles.receiptMeta}>{tzs(1290)}</Text>
                </Row>
              ) : null}
              {preview.fields.total ? (
                <Row style={{ justifyContent: 'space-between', paddingVertical: 4 }}>
                  <Text style={styles.receiptTotal}>{t('rcpt.total')}</Text>
                  <Text style={styles.receiptTotal}>{tzs(22790)}</Text>
                </Row>
              ) : null}
              {preview.fields.paymentMethod ? <Text style={styles.receiptMeta}>Paid via M-PESA · CAPTURED</Text> : null}
              {preview.fields.cashierName ? <Text style={styles.receiptMeta}>Cashier: Juma M.</Text> : null}
              {preview.fields.qrCode ? (
                <View style={styles.qrBox}>
                  <Text style={styles.qrText}>QR</Text>
                </View>
              ) : null}
              <View style={styles.dashDivider} />
              {preview.fields.thankYou ? <Text style={[styles.receiptMeta, { textAlign: 'center' }]}>{preview.footerText || t('rcpt.thanks')}</Text> : null}
              <View style={styles.receiptBarcode}>
                <Text style={styles.receiptBarcodeText}>{'||||||||||||||||||||||||'}</Text>
              </View>
            </View>
          </View>
        ) : null}
      </Screen>

      <SheetModal visible={sheet === 'new'} onClose={() => setSheet(null)} title={t('rcpt.new')}>
        <View style={{ gap: Spacing.md }}>
          <Field label={t('rcpt.name')} value={newName} onChangeText={setNewName} placeholder={t('rcpt.namePh')} maxLength={30} />
          {sheetError ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{sheetError}</Text> : null}
          <Btn label={t('rcpt.create')} size="lg" loading={busy} disabled={!newName.trim()} onPress={create} />
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'edit'} onClose={() => setSheet(null)} title={t('rcpt.editTitle', { name: editing?.name ?? '' })}>
        {draft ? (
          <View style={{ gap: Spacing.md }}>
            <Field label={t('rcpt.fieldName')} value={draft.name} onChangeText={(v) => patchDraft({ name: v })} maxLength={30} />
            <Field label={t('rcpt.headerText')} value={draft.headerText} onChangeText={(v) => patchDraft({ headerText: v })} placeholder={t('rcpt.storeNameLine')} maxLength={60} />
            <Field label={t('rcpt.footerText')} value={draft.footerText} onChangeText={(v) => patchDraft({ footerText: v })} placeholder={t('rcpt.thanks')} multiline maxLength={120} />
            <Field label={t('rcpt.logoEmoji')} value={draft.logoEmoji} onChangeText={(v) => patchDraft({ logoEmoji: v })} placeholder="🍢" maxLength={4} />
            <View style={{ gap: Spacing.sm }}>
              <Text style={styles.fieldLabel}>{t('rcpt.paperSize')}</Text>
              <Row gap={8}>
                {PAPER_SIZES.map((s) => (
                  <Chip key={s} label={s} selected={draft.paperSize === s} onPress={() => patchDraft({ paperSize: s })} />
                ))}
              </Row>
            </View>
            <View style={{ gap: Spacing.sm }}>
              <Text style={styles.fieldLabel}>{t('rcpt.font')}</Text>
              <Row gap={8}>
                {FONTS.map((f) => (
                  <Chip key={f} label={f === 'monospace' ? t('rcpt.fontMono') : t('rcpt.fontSans')} selected={draft.font === f} onPress={() => patchDraft({ font: f })} />
                ))}
              </Row>
            </View>
            <View style={{ gap: Spacing.sm }}>
              <Text style={styles.fieldLabel}>{t('rcpt.copies')}</Text>
              <Row gap={8}>
                <Pressable onPress={() => patchDraft({ copies: Math.max(1, draft.copies - 1) })} style={styles.stepBtn}>
                  <Text style={styles.stepText}>−</Text>
                </Pressable>
                <Text style={styles.stepValue}>{draft.copies}</Text>
                <Pressable onPress={() => patchDraft({ copies: Math.min(5, draft.copies + 1) })} style={styles.stepBtn}>
                  <Text style={styles.stepText}>+</Text>
                </Pressable>
              </Row>
            </View>
            <View style={{ gap: Spacing.sm }}>
              <Text style={styles.fieldLabel}>{t('rcpt.fields')}</Text>
              <View style={{ gap: Spacing.xs }}>
                {FIELD_TOGGLES.map((f) => (
                  <ToggleRow key={f.key} label={f.label} value={draft.fields[f.key]} onChange={(v) => patchField(f.key, v)} />
                ))}
              </View>
            </View>
            {sheetError ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{sheetError}</Text> : null}
            <Btn label={t('rcpt.save')} size="lg" loading={busy} disabled={!draft.name.trim()} onPress={save} />
            <Btn
              label={editing?.id === activeId ? t('rcpt.active') : t('rcpt.setActive')}
              variant={editing?.id === activeId ? 'subtle' : 'outline'}
              size="lg"
              disabled={editing?.id === activeId}
              loading={busy}
              onPress={setActive}
            />
          </View>
        ) : null}
      </SheetModal>

      <SheetModal visible={sheet === 'delete'} onClose={() => setSheet(null)} title={t('rcpt.deleteTitle')}>
        <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 19 }}>
          {t('rcpt.deleteBody', { name: editing?.name ?? '' })}
        </Text>
        {sheetError ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs, textAlign: 'center' }}>{sheetError}</Text> : null}
        <Row gap={Spacing.sm}>
          <Btn label={t('rcpt.cancel')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => setSheet(null)} />
          <Btn label={t('rcpt.deleteBtn')} variant="danger" size="sm" style={{ flex: 1 }} loading={busy} onPress={remove} />
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
  sectionLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '700', letterSpacing: 0.5 },
  receipt: {
    backgroundColor: Colors.white,
    borderRadius: Radius.md,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  receiptEmoji: { fontSize: 24, textAlign: 'center' },
  receiptStore: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text, textAlign: 'center' },
  receiptMetaCenter: { fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'center', marginTop: 2 },
  dashDivider: {
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    borderStyle: 'dashed',
    marginVertical: 8,
  },
  receiptItem: { fontSize: FontSize.sm, color: Colors.textSecondary, flexShrink: 1 },
  receiptMeta: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 },
  receiptTotal: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text },
  qrBox: {
    alignSelf: 'center',
    marginTop: 8,
    width: 44,
    height: 44,
    borderWidth: 1.5,
    borderColor: Colors.text,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrText: { fontSize: FontSize.xs, fontWeight: '800', color: Colors.text },
  receiptBarcode: { alignItems: 'center', marginTop: 10, gap: 2 },
  receiptBarcodeText: { fontSize: 10, letterSpacing: 1, color: Colors.text, fontWeight: '700' },
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
