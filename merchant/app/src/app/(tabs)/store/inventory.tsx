import { Stack, router, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Chip, Empty, Field, Icon, Pill, Row, Screen, Segmented, SheetModal, ToggleRow } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import type { InventoryItem, InventoryMasterSource, InventorySyncChannel } from '@/api/types';
import { useSupplyChainStore } from '@/store/supply-chain';
import { useMessageStore } from '@/store/messages';
import { fullTime } from '@/lib/format';

const LEVEL_LABEL: Record<'low' | 'out_of_stock', I18nKey> = { low: 'sc.lowStock', out_of_stock: 'sc.outOfStock' };

const REASON_CHIPS: I18nKey[] = ['sc.reasonDamage', 'sc.reasonWriteOff', 'sc.reasonCount', 'sc.reasonReturn'];

const MASTER_LABEL: Record<InventoryMasterSource, string> = {
  platform: 'Platform',
  pos: 'POS',
  erp: 'ERP',
};

const CHANNELS: { key: InventorySyncChannel; label: string }[] = [
  { key: 'platform_orders', label: 'Platform orders' },
  { key: 'dine_in', label: 'Dine-in' },
  { key: 'pos', label: 'POS' },
  { key: 'delivery_partners', label: 'Delivery partners' },
  { key: 'mini_program', label: 'Mini program' },
];

export default function InventoryScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const params = useLocalSearchParams<{ tab?: string }>();
  const inventory = useSupplyChainStore((s) => s.inventory);
  const adjustments = useSupplyChainStore((s) => s.adjustments);
  const alerts = useSupplyChainStore((s) => s.alerts);
  const syncConfig = useSupplyChainStore((s) => s.syncConfig);
  const hydrateInventory = useSupplyChainStore((s) => s.hydrateInventory);
  const hydrateAdjustments = useSupplyChainStore((s) => s.hydrateAdjustments);
  const hydrateAlerts = useSupplyChainStore((s) => s.hydrateAlerts);
  const hydrateSyncConfig = useSupplyChainStore((s) => s.hydrateSyncConfig);
  const adjustStock = useSupplyChainStore((s) => s.adjustStock);
  const updateSyncConfig = useSupplyChainStore((s) => s.updateSyncConfig);
  const pushMessage = useMessageStore((s) => s.push);

  const [tab, setTab] = useState<'items' | 'alerts' | 'adjustments'>(params.tab === 'alerts' ? 'alerts' : 'items');
  const [sheet, setSheet] = useState<null | 'adjust' | 'sync'>(null);
  const [target, setTarget] = useState<InventoryItem | null>(null);
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [syncMaster, setSyncMaster] = useState<InventoryMasterSource>('platform');
  const [syncChannels, setSyncChannels] = useState<InventorySyncChannel[]>([]);

  useEffect(() => {
    hydrateInventory().catch(() => undefined);
    hydrateAlerts().catch(() => undefined);
    hydrateAdjustments().catch(() => undefined);
    hydrateSyncConfig().catch(() => undefined);
  }, [hydrateInventory, hydrateAlerts, hydrateAdjustments, hydrateSyncConfig]);

  const alertLevel = (id: string): 'low' | 'out_of_stock' | null => alerts.find((a) => a.catalogueItemId === id)?.level ?? null;

  const openAdjust = (item: InventoryItem) => {
    setTarget(item);
    setDelta('');
    setReason('');
    setError('');
    setSheet('adjust');
  };

  const applyAdjust = async () => {
    if (!target) return;
    const d = Number(delta);
    if (!Number.isInteger(d) || d === 0) {
      setError(t('sc.errAdjust'));
      return;
    }
    /* ISC L24 — a reason is required; INVENTORY_ADJUSTMENT_REASON_REQUIRED
     * surfaces as a form error (no silent default reason). */
    if (!reason.trim()) {
      setError(t('sc.reasonRequired'));
      return;
    }
    setBusy(true);
    setError('');
    const res = await adjustStock(target.catalogueItemId, d, reason.trim());
    setBusy(false);
    if (res.ok) {
      setSheet(null);
      setTarget(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({ type: 'system', title: t('sc.adjustApplied'), body: t('sc.adjustAppliedSub', { name: target.name, delta: d > 0 ? `+${d}` : String(d) }) });
    } else {
      setError(res.message ?? t('sc.errAdjust'));
    }
  };

  const openSync = () => {
    setSyncEnabled(syncConfig?.enabled ?? false);
    setSyncMaster(syncConfig?.masterSource ?? 'platform');
    setSyncChannels(syncConfig?.channels ?? []);
    setError('');
    setSheet('sync');
  };

  const saveSync = async () => {
    setBusy(true);
    setError('');
    const res = await updateSyncConfig({ enabled: syncEnabled, masterSource: syncMaster, channels: syncChannels });
    setBusy(false);
    if (res.ok) {
      setSheet(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({ type: 'system', title: t('sc.syncSaved'), body: '' });
    } else {
      setError(res.message ?? t('sc.errSync'));
    }
  };

  const toggleChannel = (c: InventorySyncChannel) => {
    setSyncChannels((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('sc.inventoryTitle')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <Row style={{ justifyContent: 'space-between', marginTop: Spacing.md }}>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, flex: 1 }}>{t('sc.inventorySub')}</Text>
          <Btn label={t('sc.syncConfig')} icon="sync-outline" size="sm" variant="outline" onPress={openSync} />
        </Row>

        <Segmented
          options={[
            { key: 'items', label: t('sc.items'), count: inventory.rows.length },
            { key: 'alerts', label: t('sc.alerts'), count: alerts.length },
            { key: 'adjustments', label: t('sc.adjustments'), count: adjustments.length },
          ]}
          value={tab}
          onChange={setTab}
          equal
        />

        {tab === 'items' ? (
          <>
            {inventory.error ? (
              <View style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.lg }}>
                <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{inventory.error}</Text>
                <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => hydrateInventory()} />
              </View>
            ) : null}
            {inventory.rows.length === 0 && !inventory.error ? <Empty icon="cube-outline" title={t('sc.items')} sub={t('sc.inventorySub')} /> : null}
            <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
              {inventory.rows.map((item) => {
                const level = alertLevel(item.catalogueItemId);
                return (
                  <Card key={item.catalogueItemId} style={{ gap: Spacing.sm }}>
                    <Row style={{ justifyContent: 'space-between' }}>
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                        <Text style={styles.meta}>
                          {t('sc.stockOnHand')} {item.stockOnHand} · {t('sc.reserved')} {item.reserved} · {t('sc.available')} {item.available}
                        </Text>
                      </View>
                      {level ? <Pill label={t(LEVEL_LABEL[level]).toUpperCase()} tone={level === 'out_of_stock' ? 'danger' : 'warning'} /> : null}
                    </Row>
                    <Row gap={Spacing.sm}>
                      <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, flex: 1 }}>
                        {t('sc.suggestedReorder', { qty: alerts.find((a) => a.catalogueItemId === item.catalogueItemId)?.suggestedReorderQty ?? '—' })}
                      </Text>
                      <Btn label={t('sc.adjust')} variant="outline" size="sm" onPress={() => openAdjust(item)} />
                    </Row>
                  </Card>
                );
              })}
            </View>
          </>
        ) : null}

        {tab === 'alerts' ? (
          <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
            {alerts.length === 0 ? <Empty icon="checkmark-circle-outline" title={t('sc.noAlerts')} sub={t('sc.noAlertsSub')} /> : null}
            {alerts.map((a) => (
              <Card key={a.catalogueItemId} style={{ gap: Spacing.sm }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.name} numberOfLines={1}>{a.name}</Text>
                    <Text style={styles.meta}>
                      {t('sc.stockOnHand')} {a.stockOnHand}
                    </Text>
                  </View>
                  <Pill label={t(LEVEL_LABEL[a.level]).toUpperCase()} tone={a.level === 'out_of_stock' ? 'danger' : 'warning'} />
                </Row>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('sc.suggestedReorder', { qty: a.suggestedReorderQty ?? '—' })}</Text>
              </Card>
            ))}
          </View>
        ) : null}

        {tab === 'adjustments' ? (
          <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
            {adjustments.length === 0 ? <Empty icon="time-outline" title={t('sc.noAdjustments')} /> : null}
            {adjustments.slice(0, 30).map((a) => (
              <Card key={a.id} flat style={{ gap: 2 }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={styles.name} numberOfLines={1}>{a.itemId}</Text>
                  <Text style={{ fontSize: FontSize.md, fontWeight: '800', color: a.delta >= 0 ? Colors.success : Colors.danger }}>
                    {a.delta >= 0 ? `+${a.delta}` : a.delta}
                  </Text>
                </Row>
                <Text style={styles.meta}>{a.reason}</Text>
                <Text style={styles.meta}>{fullTime(a.at)} · {a.by}</Text>
              </Card>
            ))}
          </View>
        ) : null}
      </Screen>

      <SheetModal visible={sheet === 'adjust'} onClose={() => setSheet(null)} title={t('sc.adjustTitle')}>
        <View style={{ gap: Spacing.md }}>
          {target ? (
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>
              {t('sc.adjustHint', { name: target.name })} — {t('sc.stockOnHand')} {target.stockOnHand}
            </Text>
          ) : null}
          <Field label={t('sc.adjustDelta')} value={delta} onChangeText={setDelta} keyboardType="number-pad" placeholder="-5" />
          <View style={{ gap: Spacing.sm }}>
            <Row gap={8} style={{ flexWrap: 'wrap' }}>
              {REASON_CHIPS.map((key) => (
                <Chip key={key} label={t(key)} selected={reason === t(key)} onPress={() => setReason(reason === t(key) ? '' : t(key))} />
              ))}
            </Row>
            <Field label={t('sc.adjustReason')} value={reason} onChangeText={setReason} placeholder={t('sc.adjustReasonPh')} maxLength={500} multiline />
          </View>
          {error ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{error}</Text> : null}
          <Btn label={t('sc.adjust')} size="lg" loading={busy} disabled={!delta.trim() || !reason.trim()} onPress={applyAdjust} />
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'sync'} onClose={() => setSheet(null)} title={t('sc.syncConfig')}>
        <View style={{ gap: Spacing.sm }}>
          <ToggleRow label={t('sc.syncEnabled')} value={syncEnabled} onChange={setSyncEnabled} />
          {syncEnabled && syncMaster !== 'platform' ? (
            <Text style={{ fontSize: FontSize.xs, color: Colors.warning }}>{t('sc.syncDisabled')}</Text>
          ) : null}
          <Text style={styles.fieldLabel}>{t('sc.syncMaster')}</Text>
          <Row gap={8} style={{ flexWrap: 'wrap' }}>
            {(['platform', 'pos', 'erp'] as const).map((m) => (
              <Chip key={m} label={MASTER_LABEL[m]} selected={syncMaster === m} onPress={() => setSyncMaster(m)} />
            ))}
          </Row>
          <Text style={styles.fieldLabel}>{t('sc.syncChannels')}</Text>
          <View style={{ gap: 8 }}>
            {CHANNELS.map((c) => (
              <ToggleRow key={c.key} label={c.label} value={syncChannels.includes(c.key)} onChange={() => toggleChannel(c.key)} />
            ))}
          </View>
          {error ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{error}</Text> : null}
          <Btn label={t('common.save')} size="lg" loading={busy} onPress={saveSync} />
        </View>
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
  fieldLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
});
