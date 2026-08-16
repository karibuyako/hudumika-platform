import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Empty, Field, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import type { Supplier } from '@/api/types';
import { useSupplyChainStore } from '@/store/supply-chain';
import { useMessageStore } from '@/store/messages';
import { fullTime } from '@/lib/format';

const STATUS_PILL: Record<Supplier['status'], { label: I18nKey; tone: 'success' | 'warning' }> = {
  active: { label: 'sc.statusActive', tone: 'success' },
  suspended: { label: 'sc.statusSuspended', tone: 'warning' },
};

export default function SuppliersScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const suppliers = useSupplyChainStore((s) => s.suppliers);
  const hydrate = useSupplyChainStore((s) => s.hydrateSuppliers);
  const addSupplier = useSupplyChainStore((s) => s.addSupplier);
  const updateSupplier = useSupplyChainStore((s) => s.updateSupplier);
  const removeSupplier = useSupplyChainStore((s) => s.removeSupplier);
  const pushMessage = useMessageStore((s) => s.push);

  const [sheet, setSheet] = useState<null | 'add' | 'edit' | 'delete'>(null);
  const [target, setTarget] = useState<Supplier | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [categories, setCategories] = useState('');
  const [terms, setTerms] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    hydrate().catch(() => undefined);
  }, [hydrate]);

  const resetForm = () => {
    setName('');
    setPhone('');
    setEmail('');
    setCategories('');
    setTerms('');
    setError('');
  };

  const openAdd = () => {
    resetForm();
    setSheet('add');
  };

  const openEdit = (s: Supplier) => {
    setTarget(s);
    setName(s.name);
    setPhone(s.contactPhone);
    setEmail(s.contactEmail ?? '');
    setCategories(s.categories?.join(', ') ?? '');
    setTerms(s.paymentTerms ?? '');
    setError('');
    setSheet('edit');
  };

  const save = async () => {
    if (!name.trim() || !phone.trim()) return;
    setBusy(true);
    setError('');
    const input = {
      name: name.trim(),
      contactPhone: phone.trim(),
      contactEmail: email.trim() || undefined,
      categories: categories.split(',').map((c) => c.trim()).filter(Boolean),
      paymentTerms: terms.trim() || undefined,
    };
    const res = target ? await updateSupplier(target.id, input) : await addSupplier(input);
    setBusy(false);
    if (res.ok) {
      setSheet(null);
      setTarget(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({ type: 'system', title: target ? t('sc.supplierSaved') : t('sc.supplierAdded'), body: input.name });
    } else {
      setError(res.message ?? t('sc.errSupplier'));
    }
  };

  const remove = async () => {
    if (!target) return;
    setBusy(true);
    setError('');
    const res = await removeSupplier(target.id);
    setBusy(false);
    if (res.ok) {
      setSheet(null);
      setTarget(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({ type: 'system', title: t('sc.supplierDeleted'), body: target.name });
    } else {
      setError(res.message ?? t('sc.errSupplier'));
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('sc.suppliersTitle')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <Row style={{ justifyContent: 'space-between', marginTop: Spacing.md }}>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, flex: 1 }}>{t('sc.suppliersSub')}</Text>
          <Btn label={t('sc.addSupplier')} icon="add" size="sm" onPress={openAdd} />
        </Row>

        {suppliers.error ? (
          <View style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.lg }}>
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{suppliers.error}</Text>
            <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => hydrate()} />
          </View>
        ) : null}

        <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
          {suppliers.rows.length === 0 && !suppliers.error ? <Empty icon="people-outline" title={t('sc.noSuppliers')} sub={t('sc.noSuppliersSub')} /> : null}
          {suppliers.rows.map((s) => (
            <Card key={s.id} style={{ gap: Spacing.sm }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.name} numberOfLines={1}>{s.name}</Text>
                  <Text style={styles.meta}>
                    {s.contactPhone}{s.contactEmail ? ` · ${s.contactEmail}` : ''}
                  </Text>
                  <Text style={styles.meta}>
                    {s.categories?.length ? s.categories.join(', ') : ''}{s.paymentTerms ? ` · ${s.paymentTerms}` : ''} · {t('common.active')} since {fullTime(s.createdAt)}
                  </Text>
                </View>
                <Pill label={t(STATUS_PILL[s.status].label)} tone={STATUS_PILL[s.status].tone} />
              </Row>
              <Row gap={Spacing.sm}>
                <Btn label={t('common.edit')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => openEdit(s)} />
                <Btn
                  label={t('common.remove')}
                  variant="danger"
                  size="sm"
                  style={{ flex: 1 }}
                  onPress={() => {
                    setTarget(s);
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
        title={sheet === 'edit' ? t('sc.editSupplier') : t('sc.addSupplier')}>
        <View style={{ gap: Spacing.md }}>
          <Field label={t('sc.supplierName')} value={name} onChangeText={setName} placeholder={t('sc.supplierNamePh')} maxLength={160} />
          <Field label={t('sc.supplierPhone')} value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
          <Field label={t('sc.supplierEmail')} value={email} onChangeText={setEmail} keyboardType="email-address" />
          <Field label={t('sc.supplierCategories')} value={categories} onChangeText={setCategories} placeholder="vegetables, dairy" />
          <Field label={t('sc.supplierTerms')} value={terms} onChangeText={setTerms} placeholder={t('sc.supplierTermsPh')} maxLength={200} />
          {error ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{error}</Text> : null}
          <Btn label={t('common.save')} size="lg" loading={busy} disabled={!name.trim() || !phone.trim()} onPress={save} />
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'delete'} onClose={() => setSheet(null)} title={t('sc.deleteSupplierTitle')}>
        <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 19 }}>
          {t('sc.deleteSupplierBody', { name: target?.name ?? '' })}
        </Text>
        {error ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs, textAlign: 'center' }}>{error}</Text> : null}
        <Row gap={Spacing.sm}>
          <Btn label={t('common.cancel')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => setSheet(null)} />
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
  name: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flexShrink: 1 },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary },
});
