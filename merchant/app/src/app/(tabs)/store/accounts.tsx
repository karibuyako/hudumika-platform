import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Chip, Empty, Field, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import type { IconName } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { api, ApiError } from '@/api/client';
import type { PaymentAccount, PaymentProvider, StoreListItem } from '@/api/types';

const TYPE_ICON: Record<PaymentAccount['type'], IconName> = { bank: 'card-outline', mobile_money: 'wallet-outline' };
const TYPE_LABEL: Record<PaymentAccount['type'], I18nKey> = { bank: 'acc.typeBank', mobile_money: 'acc.typeMobile' };
const PROVIDER_LABEL: Record<PaymentProvider, I18nKey> = {
  mpesa: 'acc.mpesa',
  tigo_pesa: 'acc.tigoPesa',
  airtel_money: 'acc.airtelMoney',
  ezy_pesa: 'acc.ezyPesa',
  halotel: 'acc.halotel',
  card: 'acc.bankCard',
  cod: 'acc.cod',
  bank: 'acc.typeBank',
};
const ACCOUNT_TYPES: PaymentAccount['type'][] = ['bank', 'mobile_money'];

export default function AccountsScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const [stores, setStores] = useState<StoreListItem[]>([]);
  const [storeId, setStoreId] = useState('s_demo');
  const [accounts, setAccounts] = useState<PaymentAccount[]>([]);
  const [sheet, setSheet] = useState<null | 'add' | 'delete'>(null);
  const [target, setTarget] = useState<PaymentAccount | null>(null);
  const [type, setType] = useState<PaymentAccount['type']>('bank');
  const [name, setName] = useState('');
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sheetError, setSheetError] = useState('');

  useEffect(() => {
    api
      .get<{ stores: StoreListItem[] }>('/stores', { retries: 1 })
      .then((r) => setStores(r.stores))
      .catch(() => undefined);
  }, []);

  const load = useCallback(async (sid: string) => {
    setAccounts([]);
    setError('');
    try {
      const r = await api.get<{ accounts: PaymentAccount[] }>(`/store/payment-accounts?storeId=${sid}`, { retries: 1 });
      setAccounts(r.accounts);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('acc.errLoad'));
    }
  }, []);

  useEffect(() => {
    api
      .get<{ accounts: PaymentAccount[] }>(`/store/payment-accounts?storeId=${storeId}`, { retries: 1 })
      .then((r) => setAccounts(r.accounts))
      .catch((e) => setError(e instanceof ApiError ? e.message : t('acc.errLoad')));
  }, [storeId]);

  const verify = async (a: PaymentAccount) => {
    setBusy(true);
    setError('');
    try {
      await api.post(`/store/payment-accounts/${a.id}/verify`);
      await load(storeId);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('acc.errVerify'));
    } finally {
      setBusy(false);
    }
  };

  const setDefault = async (a: PaymentAccount) => {
    setBusy(true);
    setError('');
    try {
      await api.patch(`/payment-accounts/${a.id}`, { isDefault: true });
      await load(storeId);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('acc.errDefault'));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!name.trim() || !account.trim()) return;
    setBusy(true);
    setSheetError('');
    try {
      await api.post('/store/payment-accounts', { storeId, type, name: name.trim(), account: account.trim() });
      setSheet(null);
      setName('');
      setAccount('');
      setType('bank');
      await load(storeId);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setSheetError(e instanceof ApiError ? e.message : t('acc.errAdd'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!target) return;
    setBusy(true);
    setSheetError('');
    try {
      await api.delete(`/store/payment-accounts/${target.id}`);
      setSheet(null);
      setTarget(null);
      await load(storeId);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setSheetError(e instanceof ApiError ? e.message : t('acc.errDelete'));
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
        <Text style={styles.topTitle}>{t('acc.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {stores.map((s) => (
            <Chip key={s.id} label={s.name} selected={storeId === s.id} onPress={() => setStoreId(s.id)} />
          ))}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Row style={{ justifyContent: 'space-between', marginTop: Spacing.md }}>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, flex: 1 }}>
            {t('acc.sub')}
          </Text>
          <Btn
            label={t('acc.add')}
            icon="add"
            size="sm"
            onPress={() => {
              setType('bank');
              setName('');
              setAccount('');
              setSheetError('');
              setSheet('add');
            }}
          />
        </Row>

        <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
          {accounts.length === 0 ? <Empty icon="wallet-outline" title={t('acc.empty')} sub={t('acc.emptySub')} /> : null}
          {accounts.map((a) => (
            <Card key={a.id} style={{ gap: Spacing.sm }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Row gap={10} style={{ flex: 1 }}>
                  <View style={styles.iconBox}>
                    <Icon name={TYPE_ICON[a.type]} size={18} color={Colors.info} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Row gap={6}>
                      <Text style={styles.name} numberOfLines={1}>{a.name}</Text>
                      {a.isDefault ? <Text style={styles.star}>{t('acc.default')}</Text> : null}
                    </Row>
                    <Text style={styles.meta}>{a.type === 'mobile_money' ? (t(PROVIDER_LABEL[a.provider as PaymentProvider])) : t(TYPE_LABEL[a.type])} · {a.accountMasked}</Text>
                  </View>
                </Row>
                <Pill
                  label={a.status === 'active' ? t('acc.active') : a.status === 'pending' ? t('acc.pending') : t('acc.disabled')}
                  tone={a.status === 'active' ? 'success' : a.status === 'pending' ? 'warning' : 'neutral'}
                />
              </Row>
              <Row gap={Spacing.sm}>
                {a.status === 'pending' ? (
                  <Btn label={t('acc.verify')} variant="ghost" size="sm" style={{ flex: 1 }} loading={busy} onPress={() => verify(a)} />
                ) : null}
                {!a.isDefault ? (
                  <Btn label={t('acc.setDefault')} variant="outline" size="sm" style={{ flex: 1 }} loading={busy} onPress={() => setDefault(a)} />
                ) : null}
                <Btn
                  label={t('acc.delete')}
                  variant="danger"
                  size="sm"
                  style={{ flex: 1 }}
                  onPress={() => {
                    setTarget(a);
                    setSheetError('');
                    setSheet('delete');
                  }}
                />
              </Row>
            </Card>
          ))}
        </View>
      </Screen>

      <SheetModal visible={sheet === 'add'} onClose={() => setSheet(null)} title={t('acc.addTitle')}>
        <View style={{ gap: Spacing.md }}>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('acc.type')}</Text>
            <Row gap={8} style={{ flexWrap: 'wrap' }}>
              {ACCOUNT_TYPES.map((at) => (
                <Chip key={at} label={t(TYPE_LABEL[at])} selected={type === at} onPress={() => setType(at)} />
              ))}
            </Row>
          </View>
          <Field label={t('acc.name')} value={name} onChangeText={setName} placeholder={t('acc.namePh')} maxLength={30} />
          <Field label={t('acc.number')} value={account} onChangeText={setAccount} placeholder={t('acc.numberPh')} keyboardType="number-pad" maxLength={32} />
          {sheetError ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{sheetError}</Text> : null}
          <Btn label={t('acc.add')} size="lg" loading={busy} disabled={!name.trim() || !account.trim()} onPress={add} />
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'delete'} onClose={() => setSheet(null)} title={t('acc.deleteTitle')}>
        <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 19 }}>
          {t('acc.deleteBody', { name: target?.name ?? '' })}
        </Text>
        {sheetError ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs, textAlign: 'center' }}>{sheetError}</Text> : null}
        <Row gap={Spacing.sm}>
          <Btn label={t('acc.cancel')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => setSheet(null)} />
          <Btn label={t('acc.delete')} variant="danger" size="sm" style={{ flex: 1 }} loading={busy} onPress={remove} />
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
});
