import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Chip, Icon, Pill, Row, Screen, ToggleRow } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { api, ApiError } from '@/api/client';
import type { DineInOrder, StoreListItem, StoreServer, TableRow } from '@/api/types';
import { useSessionStore } from '@/store/session';
import { clock } from '@/lib/format';
import type { Order } from '@/types';

type DualSettings = StoreServer['dualScreen'];

const SCREEN_OPTIONS: { key: DualSettings['screen']; label: I18nKey }[] = [
  { key: 'orders', label: 'dual.orders' },
  { key: 'kitchen', label: 'dual.kitchen' },
  { key: 'media', label: 'dual.media' },
];
const REFRESH_OPTIONS = ['5', '10', '15', '30', '60'];
const THEME_OPTIONS: { key: DualSettings['theme']; label: I18nKey }[] = [
  { key: 'dark', label: 'dual.dark' },
  { key: 'light', label: 'dual.light' },
];
const FAKE_ORDERS = [
  { no: 'MT88042', items: 2, time: '12:32' },
  { no: 'MT88043', items: 1, time: '12:33' },
  { no: 'MT88045', items: 4, time: '12:35' },
  { no: 'MT88046', items: 2, time: '12:36' },
];

const toPreviewRows = (orders: Order[]) =>
  orders.slice(0, 5).map((o) => ({
    no: o.no,
    items: o.items.length,
    time: new Date(o.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  }));

export default function DualScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const [stores, setStores] = useState<StoreListItem[]>([]);
  const [storeId, setStoreId] = useState('s_demo');
  const [dualScreen, setDualScreen] = useState<DualSettings>({
    enabled: false,
    screen: 'orders',
    refreshSec: 15,
    showOrderNumbers: true,
    theme: 'dark',
    pairingCode: '—',
  });
  const [pairCode, setPairCode] = useState('');
  const [pairing, setPairing] = useState(false);
  const [pairMsg, setPairMsg] = useState('');
  const [pairOk, setPairOk] = useState(false);
  const [error, setError] = useState('');
  const [previewOrders, setPreviewOrders] = useState<{ no: string; items: number; time: string }[]>([]);
  const [kitchenBills, setKitchenBills] = useState<DineInOrder[]>([]);
  const [tableNames, setTableNames] = useState<Record<string, string>>({});
  const [printing, setPrinting] = useState('');
  const [printMsg, setPrintMsg] = useState('');

  /* Dual-screen POS role gate (DINE-IN.md): the kitchen display is read-only
   * for kitchen staff (`dine_in:prep`); other roles get STAFF_ROLE_FORBIDDEN. */
  const sessionPerms = useSessionStore((s) => s.perms);
  const canViewKitchen = sessionPerms.includes('*') || sessionPerms.includes('dine_in:prep');

  useEffect(() => {
    if (dualScreen.screen !== 'kitchen') return;
    let active = true;
    const loadKitchen = () => {
      Promise.all([
        api.get<{ bills: DineInOrder[] }>('/dine-in/orders/me?status=open', { retries: 1 }),
        api.get<{ bills: DineInOrder[] }>('/dine-in/orders/me?status=billing', { retries: 1 }),
        api.get<{ tables: TableRow[] }>(`/dine-in/tables?storeId=${storeId}`, { retries: 1 }),
      ])
        .then(([open, billing, tables]) => {
          if (!active) return;
          setKitchenBills([...open.bills, ...billing.bills].sort((a, b) => a.createdAt - b.createdAt));
          setTableNames(Object.fromEntries(tables.tables.map((tb) => [tb.id, tb.label ?? tb.name])));
        })
        .catch(() => {
          if (active) setKitchenBills([]);
        });
    };
    loadKitchen();
    const timer = setInterval(loadKitchen, dualScreen.refreshSec * 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [dualScreen.screen, dualScreen.refreshSec, storeId]);

  useEffect(() => {
    let active = true;
    const load = () => {
      api
        .get<{ orders: Order[] }>('/orders?status=preparing', { retries: 1 })
        .then((r) => {
          if (active) setPreviewOrders(toPreviewRows(r.orders));
        })
        .catch(() => {
          if (active) setPreviewOrders([]);
        });
    };
    load();
    const timer = setInterval(load, dualScreen.refreshSec * 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [dualScreen.refreshSec]);

  useEffect(() => {
    api
      .get<{ stores: StoreListItem[] }>('/stores', { retries: 1 })
      .then((r) => setStores(r.stores))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    api
      .get<{ dualScreen: DualSettings }>(`/stores/${storeId}/dual-screen`, { retries: 1 })
      .then((r) => setDualScreen(r.dualScreen))
      .catch((e) => setError(e instanceof ApiError ? e.message : t('dual.errLoad')));
  }, [storeId]);

  const onStoreChange = (sid: string) => {
    setPairMsg('');
    setPairOk(false);
    setStoreId(sid);
  };

  const patch = async (body: Partial<DualSettings>) => {
    setError('');
    try {
      const r = await api.patch<{ dualScreen: DualSettings }>(`/stores/${storeId}/dual-screen`, body);
      setDualScreen(r.dualScreen);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('dual.errSave'));
    }
  };

  const pair = async () => {
    if (!pairCode.trim()) return;
    setPairing(true);
    setPairMsg('');
    setPairOk(false);
    try {
      await api.post('/dual-screen/pair', { code: pairCode.trim() });
      setPairMsg(t('dual.paired'));
      setPairOk(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setPairMsg(e instanceof ApiError ? e.message : t('dual.errPair'));
      setPairOk(false);
    } finally {
      setPairing(false);
    }
  };

  const printKitchenLabels = async (bill: DineInOrder) => {
    setPrinting(bill.id);
    setPrintMsg('');
    try {
      await api.post('/print-jobs', { jobType: 'kitchen_ticket', tableId: bill.tableId, label: `${tableNames[bill.tableId] ?? t('din.table')} · ${bill.id.slice(-6)}` });
      setPrintMsg(t('dual.labelSent'));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setPrintMsg(e instanceof ApiError ? e.message : t('dual.errLabel'));
    } finally {
      setPrinting('');
    }
  };

  const dark = dualScreen.theme === 'dark';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('dual.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {stores.map((s) => (
            <Chip key={s.id} label={s.name} selected={storeId === s.id} onPress={() => onStoreChange(s.id)} />
          ))}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Card style={{ paddingVertical: 0, overflow: 'hidden', paddingHorizontal: Spacing.lg, marginTop: Spacing.md }}>
          <ToggleRow label={t('dual.title')} sub={t('dual.sub')} value={dualScreen.enabled} onChange={(v) => patch({ enabled: v })} />
          <View style={styles.divider} />
          <View style={{ paddingVertical: Spacing.md, gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('dual.screenMode')}</Text>
            <Row gap={8}>
              {SCREEN_OPTIONS.map((o) => (
                <Chip key={o.key} label={t(o.label)} selected={dualScreen.screen === o.key} onPress={() => patch({ screen: o.key })} />
              ))}
            </Row>
          </View>
          <View style={styles.divider} />
          <View style={{ paddingVertical: Spacing.md, gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('dual.refresh')}</Text>
            <Row gap={8} style={{ flexWrap: 'wrap' }}>
              {REFRESH_OPTIONS.map((s) => (
                <Chip key={s} label={`${s}s`} selected={dualScreen.refreshSec === Number(s)} onPress={() => patch({ refreshSec: Number(s) })} />
              ))}
            </Row>
          </View>
          <View style={styles.divider} />
          <ToggleRow label={t('dual.showNumbers')} sub={t('dual.showNumbersSub')} value={dualScreen.showOrderNumbers} onChange={(v) => patch({ showOrderNumbers: v })} />
          <View style={styles.divider} />
          <View style={{ paddingVertical: Spacing.md, gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('dual.theme')}</Text>
            <Row gap={8}>
              {THEME_OPTIONS.map((th) => (
                <Chip key={th.key} label={t(th.label)} selected={dualScreen.theme === th.key} onPress={() => patch({ theme: th.key })} />
              ))}
            </Row>
          </View>
        </Card>

        <Card style={{ gap: Spacing.md, marginTop: Spacing.md }}>
          <Row gap={10}>
            <View style={styles.pairIcon}>
              <Icon name="tv-outline" size={18} color={Colors.info} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: FontSize.sm, fontWeight: '800', color: Colors.text }}>{t('dual.pair')}</Text>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 }}>{t('dual.pairSub')}</Text>
            </View>
          </Row>
          <View style={styles.codeBox}>
            <Text style={styles.codeText}>{dualScreen.pairingCode}</Text>
          </View>
          <Row gap={8}>
            <TextInput
              value={pairCode}
              onChangeText={setPairCode}
              placeholder={t('dual.enterCode')}
              placeholderTextColor={Colors.textTertiary}
              style={[styles.input, { flex: 1 }]}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={12}
            />
            <Btn label={t('dual.pairBtn')} loading={pairing} disabled={!pairCode.trim()} onPress={pair} />
          </Row>
          {pairMsg ? (
            <Text style={{ fontSize: FontSize.xs, color: pairOk ? Colors.success : Colors.danger, fontWeight: '600' }}>{pairMsg}</Text>
          ) : null}
        </Card>

        {dualScreen.screen === 'kitchen' ? (
          <View style={{ gap: Spacing.sm, marginTop: Spacing.lg }}>
            <Text style={styles.sectionLabel}>{t('dual.kitchenQueue')}</Text>
            {!canViewKitchen ? (
              <Card style={{ gap: Spacing.sm }}>
                <Row gap={8}>
                  <Icon name="lock-closed-outline" size={16} color={Colors.danger} />
                  <Text style={{ flex: 1, color: Colors.danger, fontSize: FontSize.sm, lineHeight: 18 }}>{t('dual.roleForbidden')}</Text>
                </Row>
              </Card>
            ) : (
              <View style={[styles.kitchen, dark ? styles.kitchenDark : styles.kitchenLight]}>
                <Text style={[styles.kitchenTitle, { color: dark ? Colors.primary : Colors.text }]}>{t('dual.kitchenDisplay')}</Text>
                <View style={[styles.kitchenDivider, { backgroundColor: dark ? 'rgba(255,255,255,0.15)' : Colors.border }]} />
                {kitchenBills.length === 0 ? (
                  <Text style={{ fontSize: FontSize.xs, color: dark ? 'rgba(255,255,255,0.5)' : Colors.textTertiary, textAlign: 'center', paddingVertical: Spacing.md }}>
                    {t('dual.kitchenEmpty')}
                  </Text>
                ) : null}
                {kitchenBills.map((b) => (
                  <View key={b.id} style={{ paddingVertical: Spacing.sm, gap: 4 }}>
                    <Row style={{ justifyContent: 'space-between' }}>
                      <Text style={[styles.kitchenItem, { color: dark ? Colors.white : Colors.textSecondary }]}>
                        {tableNames[b.tableId] ?? t('din.table')} · {b.id.slice(-6)}
                      </Text>
                      <Row gap={6}>
                        <Pill
                          label={b.status === 'billing' ? t('din.billing') : t('din.open')}
                          tone={b.status === 'billing' ? 'danger' : 'warning'}
                        />
                        <Text style={{ fontSize: FontSize.xs, color: dark ? 'rgba(255,255,255,0.5)' : Colors.textTertiary }}>{clock(b.createdAt)}</Text>
                      </Row>
                    </Row>
                    {b.items.map((it) => (
                      <Text key={it.catalogueItemId} style={{ fontSize: FontSize.xs, color: dark ? 'rgba(255,255,255,0.65)' : Colors.textTertiary }}>
                        {it.quantity}× {it.name}
                      </Text>
                    ))}
                    <Row style={{ justifyContent: 'flex-end', marginTop: 2 }}>
                      <Btn label={t('dual.printLabels')} size="sm" variant="ghost" loading={printing === b.id} onPress={() => printKitchenLabels(b)} />
                    </Row>
                  </View>
                ))}
              </View>
            )}
            {printMsg ? <Text style={{ fontSize: FontSize.xs, color: Colors.success, textAlign: 'center' }}>{printMsg}</Text> : null}
            <Text style={styles.note}>{t('dual.previewSub')}</Text>
          </View>
        ) : (
          <View style={{ gap: Spacing.sm, marginTop: Spacing.lg }}>
            <Text style={styles.sectionLabel}>{t('dual.preview')}</Text>
            <View style={[styles.kitchen, dark ? styles.kitchenDark : styles.kitchenLight]}>
              <Text style={[styles.kitchenTitle, { color: dark ? Colors.primary : Colors.text }]}>{t('dual.kitchenDisplay')}</Text>
              <View style={[styles.kitchenDivider, { backgroundColor: dark ? 'rgba(255,255,255,0.15)' : Colors.border }]} />
              {(previewOrders.length ? previewOrders : FAKE_ORDERS).map((o, i) => (
                <Row key={i} style={{ justifyContent: 'space-between', paddingVertical: 5 }}>
                  <Text style={[styles.kitchenItem, { color: dark ? Colors.white : Colors.textSecondary }]}>
                    {dualScreen.showOrderNumbers ? t('dual.ticketNo', { no: o.no, items: o.items }) : t('dual.ticketItems', { items: o.items })}
                  </Text>
                  <Text style={{ fontSize: FontSize.xs, color: dark ? 'rgba(255,255,255,0.5)' : Colors.textTertiary }}>{o.time}</Text>
                </Row>
              ))}
            </View>
            <Text style={styles.note}>{t('dual.previewSub')}</Text>
          </View>
        )}
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
  error: { color: Colors.danger, fontSize: FontSize.xs, marginTop: Spacing.sm },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border },
  fieldLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  pairIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: Colors.infoSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  codeBox: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.lg,
    alignItems: 'center',
  },
  codeText: { fontSize: 34, fontWeight: '900', letterSpacing: 4, color: Colors.text },
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
  sectionLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '700', letterSpacing: 0.5 },
  kitchen: { borderRadius: Radius.lg, padding: Spacing.lg, borderWidth: 1 },
  kitchenDark: { backgroundColor: Colors.black, borderColor: Colors.ink700 },
  kitchenLight: { backgroundColor: Colors.card, borderColor: Colors.border },
  kitchenTitle: { fontSize: FontSize.md, fontWeight: '900', letterSpacing: 1, textAlign: 'center' },
  kitchenDivider: { height: StyleSheet.hairlineWidth, marginVertical: Spacing.md },
  kitchenItem: { fontSize: FontSize.sm, fontWeight: '600' },
  note: { fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'center', lineHeight: 16 },
});
