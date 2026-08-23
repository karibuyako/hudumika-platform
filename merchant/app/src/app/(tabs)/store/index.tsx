import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { Btn, Card, Icon, ListRow, Pill, Row, Screen, SectionTitle, SheetModal, ToggleRow } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { COMMISSION_RATE } from '@/data/seed';
import { api, ApiError } from '@/api/client';
import type { ClosureProtection, StoreListItem, StoreServer } from '@/api/types';
import { fullTime, tzs } from '@/lib/format';
import { useCampaignStore } from '@/store/campaigns';
import { useCatalogStore } from '@/store/catalog';
import { useStoreStore } from '@/store/store';

const BANNER_COLORS = [Colors.primary, Colors.primaryDark, Colors.info, Colors.success, Colors.gold, Colors.ink700];
const HOURS = ['10:00', '11:00', '12:00', '16:00', '16:30', '17:00', '18:00', '19:00'];
const CLOSES = ['22:00', '23:00', '24:00', '01:00', '02:00'];
const RADII = ['2', '3', '4', '5'];
const FEES = ['0', '2', '3', '4', '5'];
const DELAYS = ['5', '15', '30', '60'];
const ETAS = ['20', '25', '30', '35', '40'];
const PICKUPS = ['10', '15', '20', '30'];
const REOPEN: { label: I18nKey; ms: number }[] = [
  { label: 'st.reopen30', ms: 30 * 60000 },
  { label: 'st.reopen1h', ms: 3600000 },
  { label: 'st.reopen2h', ms: 2 * 3600000 },
  { label: 'st.reopen4h', ms: 4 * 3600000 },
  { label: 'st.reopenTomorrow', ms: 24 * 3600000 },
];
const CLOSURE_OPTIONS: { label: I18nKey; days: number }[] = [
  { label: 'st.closureTomorrow', days: 1 },
  { label: 'st.closureWeekend', days: 2 },
  { label: 'st.closure3d', days: 3 },
  { label: 'st.closure7d', days: 7 },
];

const RINGTONE_LABEL: Record<string, I18nKey> = { beep: 'st.soundBeep', melody: 'st.soundMelody', none: 'st.soundNone' };
const NOTES_LABEL: Record<string, I18nKey> = { none: 'st.notesNone', optional: 'st.notesOptional', required: 'st.notesRequired' };

const QUICK_LINKS = [
  { label: 'st.qlPreview', icon: 'eye-outline', route: '/store/preview' },
  { label: 'st.qlAccounts', icon: 'card-outline', route: '/store/accounts' },
  { label: 'st.qlReceipt', icon: 'receipt-outline', route: '/store/receipt' },
  { label: 'st.qlPrinters', icon: 'print-outline', route: '/store/printers' },
  { label: 'st.qlDevices', icon: 'hardware-chip-outline', route: '/store/devices' },
  { label: 'st.qlTables', icon: 'grid-outline', route: '/store/tables' },
  { label: 'st.qlQr', icon: 'qr-code-outline', route: '/store/qr' },
  { label: 'st.qlBills', icon: 'receipt-outline', route: '/store/bills' },
  { label: 'st.qlDual', icon: 'tv-outline', route: '/store/dual' },
  { label: 'st.qlCompliance', icon: 'shield-checkmark-outline', route: '/store/compliance' },
  { label: 'st.qlLoyalty', icon: 'people-outline', route: '/store/loyalty' },
  { label: 'st.qlTiers', icon: 'medal-outline', route: '/store/tiers' },
  { label: 'st.qlSettings', icon: 'settings-outline', route: '/store/settings' },
  { label: 'st.qlReservations', icon: 'calendar-outline', route: '/store/reservations' },
  { label: 'st.qlPrintJobs', icon: 'print-outline', route: '/store/print-jobs' },
  { label: 'st.qlLogs', icon: 'document-text-outline', route: '/store/logs' },
  { label: 'st.qlBulk', icon: 'file-tray-outline', route: '/store/bulk' },
  { label: 'st.qlChain', icon: 'stats-chart-outline', route: '/store/chain' },
  { label: 'st.qlInventory', icon: 'cube-outline', route: '/store/inventory' },
  { label: 'st.qlSuppliers', icon: 'people-outline', route: '/store/suppliers' },
  { label: 'st.qlPurchaseOrders', icon: 'document-text-outline', route: '/store/purchase-orders' },
  { label: 'st.qlReturns', icon: 'return-up-back-outline', route: '/store/returns' },
  { label: 'st.qlWarehouses', icon: 'business-outline', route: '/store/warehouses' },
  { label: 'st.qlWebhooks', icon: 'link-outline', route: '/ops/webhooks' },
  { label: 'st.qlIntegrations', icon: 'git-merge-outline', route: '/ops/integrations' },
  { label: 'st.qlTasks', icon: 'checkmark-done-outline', route: '/ops/tasks' },
] as const;

export default function StoreScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const store = useStoreStore((s) => s.store);
  const orderSettings = useStoreStore((s) => s.orderSettings);
  const decoration = useStoreStore((s) => s.decoration);
  const promotion = useStoreStore((s) => s.promotion);
  const products = useCatalogStore((s) => s.products);
  const platformCampaigns = useCampaignStore((s) => s.platformCampaigns);
  const signupPlatform = useCampaignStore((s) => s.signupPlatform);

  const [stores, setStores] = useState<StoreListItem[]>([]);
  const [storeId, setStoreId] = useState('s_demo');
  const [server, setServer] = useState<StoreServer | null>(null);
  const [closure, setClosure] = useState<{ protection: ClosureProtection | null; usedDaysThisYear: number; remainingDays: number } | null>(null);
  const [sheet, setSheet] = useState<null | 'info' | 'hours' | 'decor' | 'delivery' | 'orders' | 'promo' | 'platform' | 'timed-close' | 'closure'>(null);
  const [platformId, setPlatformId] = useState<string | null>(null);
  const [openHour, setOpenHour] = useState('16:30');
  const [closeHour, setCloseHour] = useState('02:00');
  const [radius, setRadius] = useState('4');
  const [fee, setFee] = useState('3');
  const [eta, setEta] = useState('30');
  const [pickup, setPickup] = useState('15');
  const [posterText, setPosterText] = useState('');
  const [sign, setSign] = useState('');
  const [tagline, setTagline] = useState('');
  const [brandStory, setBrandStory] = useState('');
  const [coverImage, setCoverImage] = useState('');
  const [infoName, setInfoName] = useState('');
  const [infoAddress, setInfoAddress] = useState('');
  const [infoPhone, setInfoPhone] = useState('');
  const [infoDesc, setInfoDesc] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [reopenMs, setReopenMs] = useState(3600000);
  const [closureDays, setClosureDays] = useState(1);
  const [closureImmediate, setClosureImmediate] = useState(false);
  const [closureReason, setClosureReason] = useState('');
  const [closedDays, setClosedDays] = useState<number[]>([]);
  const [err, setErr] = useState('');

  const loadStore = useCallback(async (id: string) => {
    try {
      const res = await api.get<{ store: StoreServer }>(`/stores/${id}`, { retries: 1 });
      setServer(res.store);
      if (id === 's_demo') useStoreStore.getState().hydrate(res.store);
      const cls = await api.get<{ protection: ClosureProtection | null; usedDaysThisYear: number; remainingDays: number }>(`/closure/status?storeId=${id}`, { retries: 1 });
      setClosure(cls);
    } catch {
      /* keep stale */
    }
  }, []);

  useEffect(() => {
    api.get<{ stores: StoreListItem[] }>('/stores', { retries: 1 }).then((r) => setStores(r.stores)).catch(() => undefined);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => loadStore(storeId), 0);
    return () => clearTimeout(t);
  }, [storeId, loadStore]);

  const patch = async (patchBody: Record<string, unknown>) => {
    try {
      // eslint-disable-next-line react-hooks/purity
      const res = await api.patch<{ store: StoreServer }>(`/stores/${storeId}/settings`, patchBody, { idempotencyKey: `st:${storeId}:${Date.now()}` });
      setServer(res.store);
      if (storeId === 's_demo') useStoreStore.getState().hydrate(res.store);
      return true;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t('st.errSave'));
      return false;
    }
  };

  const s = server ?? ({
    name: store.name || 'Store',
    address: store.address,
    phone: store.phone,
    announcement: '',
    coverImage: '',
    bannerColor: store.bannerColor,
    description: store.description,
    open: store.open,
    hours: store.hours,
    deliveryRadiusKm: store.deliveryRadiusKm,
    deliveryFee: store.deliveryFee,
    minOrder: store.minOrder,
    deliveryEtaMin: 30,
    pickupReadyMinutes: 15,
    orderSettings,
    decoration,
    paymentMethods: { mpesa: true, airtel_money: true, cod: true, card: false },
    dualScreen: { enabled: false, screen: 'orders', refreshSec: 10, showOrderNumbers: true, theme: 'dark', pairingCode: '' },
    qrOrdering: { enabled: true, type: 'table', urlPattern: 'https://order.example.com/q' },
    promotion,
    featuredProductIds: store.featuredProductIds,
  } as unknown as StoreServer);

  const featured = products.filter((p) => store.featuredProductIds.includes(p.id));
  const openCampaigns = platformCampaigns.filter((p) => p.status === 'open');

  const toggleFeatured = (id: string) => {
    const has = s.featuredProductIds.includes(id);
    const next = has ? s.featuredProductIds.filter((x) => x !== id) : [...s.featuredProductIds, id].slice(0, 6);
    patch({ featuredProductIds: next });
  };

  const openPlatform = (id: string) => {
    setPlatformId(id);
    setSheet('platform');
  };

  const openTimedClose = () => {
    setErr('');
    setSheet('timed-close');
  };

  const applyTimedClose = async () => {
    // eslint-disable-next-line react-hooks/purity
    const reopenAt = Date.now() + reopenMs;
    if (await patch({ open: false, scheduledReopenAt: reopenAt })) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSheet(null);
    }
  };

  const applyClosure = async () => {
    if (!closureReason.trim()) {
      setErr(t('st.errReason'));
      return;
    }
    try {
      const from = closureImmediate ? Date.now() : Date.now() + 3600000;
      const to = from + closureDays * 86400000;
      await api.post(`/merchants/me/closure-protection?storeId=${storeId}`, { active: true, reason: closureReason.trim(), from, to }, { idempotencyKey: `cp:${storeId}:${Date.now()}` });
      setSheet(null);
      setClosureReason('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      loadStore(storeId);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t('st.errApply'));
    }
  };

  const cancelClosure = async () => {
    try {
      await api.post(`/merchants/me/closure-protection?storeId=${storeId}`, { active: false, reason: 'Cancelled by merchant' }, { idempotencyKey: `cp-c:${storeId}:${Date.now()}` });
      loadStore(storeId);
    } catch {
      /* ignore */
    }
  };

  return (
    <Screen scroll>
      <Row gap={6} style={{ flexWrap: 'wrap', marginBottom: Spacing.sm }}>
        {stores.map((st) => (
          <Pressable
            key={st.id}
            onPress={() => setStoreId(st.id)}
            accessibilityRole="button"
            accessibilityLabel={st.name.replace('Skewer House BBQ · ', '')}
            accessibilityState={{ selected: storeId === st.id }}
            style={[styles.storeChip, storeId === st.id && styles.storeChipActive]}>
            <View style={[styles.storeDot, { backgroundColor: st.open ? Colors.success : Colors.textTertiary }]} />
            <Text style={[styles.storeChipText, storeId === st.id && { color: Colors.text, fontWeight: '700' }]} numberOfLines={1}>
              {st.name.replace('Skewer House BBQ · ', '')}
            </Text>
          </Pressable>
        ))}
      </Row>

      <Card style={[styles.statusCard, { backgroundColor: s.open ? Colors.primary : Colors.black }]}>
        <Row style={{ justifyContent: 'space-between' }}>
          <View>
            <Text style={[styles.bigLabel, { color: s.open ? Colors.text : Colors.white }]}>{t('st.status')}</Text>
            <Text style={[styles.bigValue, { color: s.open ? Colors.text : Colors.white }]}>
              {s.open ? t('st.openDot') : t('st.closedDot')}
            </Text>
          </View>
          <Switch
            value={s.open}
            onValueChange={(v) => { patch({ open: v }); }}
            trackColor={{ false: Colors.borderStrong, true: Colors.ink }}
            thumbColor={Colors.white}
          />
        </Row>
        <Text style={[styles.bigSub, { color: s.open ? 'rgba(25,26,28,0.55)' : 'rgba(255,255,255,0.5)' }]}>
          {t('st.noOrdersWhileClosed')}
        </Text>
        {!s.open && s.scheduledReopenAt ? (
          <Row gap={8} style={{ alignItems: 'center', marginTop: Spacing.sm }}>
            <Icon name="timer-outline" size={16} color="rgba(255,255,255,0.85)" />
            <Text style={{ flex: 1, fontSize: FontSize.xs, color: 'rgba(255,255,255,0.85)' }}>
              {t('st.scheduledReopen', { time: fullTime(s.scheduledReopenAt) })}
            </Text>
            <Btn label={t('common.cancel')} variant="ghost" size="sm" onPress={() => patch({ scheduledReopenAt: null })} />
          </Row>
        ) : null}
        {s.open ? (
          <Btn label={t('st.closeTimed')} variant="ghost" size="sm" onPress={openTimedClose} style={{ alignSelf: 'flex-start', marginTop: 8 }} />
        ) : null}
      </Card>

      <SectionTitle title={t('st.protection')} icon="shield" />
      {closure?.protection ? (
        <Card style={styles.protectionCard}>
          <Row gap={10} style={{ alignItems: 'flex-start' }}>
            <Icon name="shield-checkmark" size={20} color={Colors.success} />
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={{ fontSize: FontSize.sm, fontWeight: '800', color: Colors.text }}>{t('st.protectionActive')}</Text>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary }}>
                {t('st.protectionWindow', { from: fullTime(closure.protection.from), to: fullTime(closure.protection.to) })}
              </Text>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('st.protectionReason', { reason: closure.protection.reason })}</Text>
              <Btn label={t('st.cancelProtection')} variant="outline" size="sm" onPress={cancelClosure} style={{ alignSelf: 'flex-start', marginTop: 6 }} />
            </View>
          </Row>
        </Card>
      ) : (
        <Card style={{ gap: Spacing.sm }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={{ fontSize: FontSize.sm, color: Colors.text, fontWeight: '700' }}>{t('st.protectionSub')}</Text>
            <Pill label={t('st.daysLeft', { n: closure?.remainingDays ?? 15 })} tone={closure && closure.remainingDays < 3 ? 'warning' : 'info'} />
          </Row>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 17 }}>
            {t('st.protectionDesc')}
          </Text>
          <Btn label={t('st.applyProtection')} icon="shield-outline" size="sm" onPress={() => { setErr(''); setSheet('closure'); }} />
        </Card>
      )}

      <SectionTitle title={t('st.basics')} icon="information-circle" />
      <Card style={{ paddingVertical: 0, overflow: 'hidden' }}>
        <ListRow
          icon="storefront-outline"
          title={s.name}
          sub={`${s.category} · ${s.phone}`}
          onPress={() => {
            setInfoName(s.name);
            setInfoAddress(s.address);
            setInfoPhone(s.phone);
            setInfoDesc(s.description ?? '');
            setAnnouncement(s.announcement ?? '');
            setErr('');
            setSheet('info');
          }}
        />
        <ListRow icon="locate-outline" title={s.address} sub={t('st.basicsSub')} onPress={() => {
          setInfoName(s.name);
          setInfoAddress(s.address);
          setInfoPhone(s.phone);
          setInfoDesc(s.description ?? '');
          setAnnouncement(s.announcement ?? '');
          setErr('');
          setSheet('info');
        }} />
        <ListRow
          icon="time-outline"
title={t('st.hours')}
          value={`${s.hours.open} ~ ${s.hours.close}`}
          onPress={() => {
            setOpenHour(s.hours.open);
            setCloseHour(s.hours.close);
            setClosedDays((s.hours.closedDays ?? []).map(Number));
            setSheet('hours');
          }}
        />
        <ListRow icon="server-outline" title={t('st.revenueShare')} sub={t('st.commission', { pct: Math.round(COMMISSION_RATE * 100) })} value="" onPress={() => undefined} />
      </Card>

      <SectionTitle title={t('st.storefront')} icon="color-palette" />
      <Card style={{ paddingVertical: 0, overflow: 'hidden' }}>
        <View style={styles.bannerPreview}>
          <View style={[styles.banner, { backgroundColor: s.bannerColor }]}>
            <Text style={styles.bannerText}>{s.coverImage ? `${s.coverImage}  ` : ''}{s.name}</Text>
            <Text style={styles.bannerSub}>{s.announcement || s.description}</Text>
          </View>
        </View>
        <Pressable
          onPress={() => {
            setPosterText(s.decoration.posterText);
            setSign(s.decoration.sign);
            setTagline(s.decoration.tagline);
            setBrandStory(s.decoration.brandStory);
            setCoverImage(s.coverImage ?? '');
            setErr('');
            setSheet('decor');
          }}
          accessibilityRole="button"
          accessibilityLabel={t('st.storefrontSub')}>
          <ListRow icon="color-palette-outline" title={t('st.storefrontSub')} sub={t('st.slotsUsed', { n: featured.length })} />
        </Pressable>
      </Card>

      <SectionTitle title={t('st.delivery')} icon="bicycle" />
      <Card style={{ paddingVertical: 0, overflow: 'hidden' }}>
        <ListRow icon="navigate-outline" title={t('st.radius')} value={t('st.km', { km: s.deliveryRadiusKm })} onPress={() => { setRadius(String(s.deliveryRadiusKm)); setSheet('delivery'); }} />
        <ListRow icon="wallet-outline" title={t('st.deliveryFee')} value={tzs(s.deliveryFee)} onPress={() => { setFee(String(s.deliveryFee)); setSheet('delivery'); }} />
        <ListRow icon="cash-outline" title={t('st.minOrder')} value={tzs(s.minOrder)} onPress={() => { setSheet('delivery'); }} />
        <ListRow icon="timer-outline" title={t('st.estDelivery')} value={t('st.min', { n: s.deliveryEtaMin ?? 30 })} onPress={() => { setEta(String(s.deliveryEtaMin ?? 30)); setSheet('delivery'); }} />
        <ListRow icon="restaurant-outline" title={t('st.pickupLead')} value={t('st.min', { n: s.pickupReadyMinutes ?? 15 })} onPress={() => { setPickup(String(s.pickupReadyMinutes ?? 15)); setSheet('delivery'); }} />
      </Card>

      <SectionTitle title={t('st.receiving')} icon="receipt" />
      <Card style={{ paddingVertical: 0, overflow: 'hidden' }}>
        <ListRow
          icon="flash-outline"
          title={t('st.autoAccept')}
          sub={s.orderSettings.autoAccept ? t('st.autoAcceptOn', { s: s.orderSettings.autoAcceptDelaySec }) : t('st.autoAcceptOff')}
          value={s.orderSettings.autoAccept ? t('st.on') : t('st.off')}
          onPress={() => setSheet('orders')}
        />
        <ListRow
          icon="calendar-outline"
          title={t('st.preorders')}
          sub={s.orderSettings.preOrderEnabled ? t('st.preordersOn') : t('st.preordersOff')}
          value={s.orderSettings.preOrderEnabled ? t('st.on') : t('st.off')}
          onPress={() => setSheet('orders')}
        />
        <ListRow
          icon="notifications-outline"
          title={t('st.alert')}
          sub={`${t('st.sound', { ringtone: RINGTONE_LABEL[s.orderSettings.ringtone] ?? s.orderSettings.ringtone })}${s.orderSettings.voiceAnnounce ? t('st.voiceAnnounce') : ''}`}
          value=""
          onPress={() => setSheet('orders')}
        />
      </Card>

      <SectionTitle title={t('st.paymentMethods')} icon="card" />
      <Card style={{ paddingVertical: 0, overflow: 'hidden', paddingHorizontal: Spacing.lg }}>
        {(['mpesa', 'airtel_money', 'cod', 'card'] as const).map((m, i) => (
          <View key={m}>
            {i > 0 ? <View style={styles.divider} /> : null}
            <ToggleRow
              label={m === 'mpesa' ? 'M-Pesa' : m === 'airtel_money' ? 'Airtel Money' : m === 'cod' ? t('st.cod') : t('st.bankCard')}
              value={s.paymentMethods[m]}
              onChange={(v) => patch({ paymentMethods: { ...s.paymentMethods, [m]: v } })}
            />
          </View>
        ))}
      </Card>

      <SectionTitle title={t('st.plan')} icon="rocket" />
      <Card style={{ paddingVertical: 0, overflow: 'hidden' }}>
        <ListRow
          icon="trending-up-outline"
          title={t('st.boost')}
          sub={s.promotion.enabled ? t('st.boostOn', { amount: tzs(s.promotion.dailyBudget), focus: s.promotion.focus === 'ranking' ? t('st.boostSearch') : t('st.boostFeed') }) : t('st.boostOff')}
          value={s.promotion.enabled ? t('st.on') : t('st.off')}
          onPress={() => setSheet('promo')}
        />
      </Card>

      <SectionTitle title={t('st.tools')} icon="apps" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm }}>
        {QUICK_LINKS.map((q) => (
          <Pressable key={q.route} onPress={() => router.push(q.route as never)} accessibilityRole="button" accessibilityLabel={t(q.label)} style={styles.quickLink}>
            <Icon name={q.icon} size={16} color={Colors.primaryDark} />
            <Text style={styles.quickLinkText}>{t(q.label)}</Text>
          </Pressable>
        ))}
      </View>

      <SectionTitle title={t('st.campaigns')} icon="megaphone" />
      <View style={{ gap: Spacing.md }}>
        {openCampaigns.length > 0 ? (
          <Card style={styles.campaignHint}>
            <Icon name="sparkles-outline" size={18} color={Colors.primaryDark} />
            <Text style={{ flex: 1, fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 19 }}>
              {t('st.campaignsOpen', { n: openCampaigns.length })}
            </Text>
          </Card>
        ) : null}
        {platformCampaigns.map((c) => (
          <Card key={c.id} style={{ gap: Spacing.sm }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.campaignTitle} numberOfLines={1}>{c.title}</Text>
              <Pill
                label={c.status === 'open' ? t('st.campaignOpen') : c.status === 'signed' ? t('st.campaignSignedUp') : t('st.campaignEnded')}
                tone={c.status === 'open' ? 'success' : c.status === 'signed' ? 'info' : 'neutral'}
              />
            </Row>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 16 }}>
              {c.date} · {c.perks}
            </Text>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={{ fontSize: FontSize.sm, color: Colors.success, fontWeight: '700' }}>{c.traffic}</Text>
              {c.status === 'open' ? (
                <Btn label={t('st.signUp')} size="sm" onPress={() => openPlatform(c.id)} />
              ) : null}
            </Row>
          </Card>
        ))}
      </View>

      <SheetModal visible={sheet === 'info'} onClose={() => setSheet(null)} title={t('st.info')}>
        <View style={{ gap: Spacing.md }}>
          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.sheetLabel}>{t('st.infoName')}</Text>
            <TextInput value={infoName} onChangeText={setInfoName} placeholderTextColor={Colors.textTertiary} style={styles.input} />
          </View>
          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.sheetLabel}>{t('st.infoAddress')}</Text>
            <TextInput value={infoAddress} onChangeText={setInfoAddress} placeholderTextColor={Colors.textTertiary} style={styles.input} />
          </View>
          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.sheetLabel}>{t('st.infoPhone')}</Text>
            <TextInput value={infoPhone} onChangeText={setInfoPhone} placeholderTextColor={Colors.textTertiary} style={styles.input} keyboardType="phone-pad" />
          </View>
          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.sheetLabel}>{t('st.infoDesc')}</Text>
            <TextInput value={infoDesc} onChangeText={setInfoDesc} placeholderTextColor={Colors.textTertiary} style={[styles.input, styles.multiline]} multiline placeholder={t('st.infoNamePh')} />
          </View>
          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.sheetLabel}>{t('st.infoAnnounce')}</Text>
            <TextInput value={announcement} onChangeText={setAnnouncement} placeholderTextColor={Colors.textTertiary} style={[styles.input, styles.multiline]} multiline placeholder={t('st.infoAnnouncePh')} />
          </View>
          {err ? <Text style={styles.error}>{err}</Text> : null}
          <Btn
            label={t('st.saveInfo')}
            size="lg"
            onPress={async () => {
              if (await patch({ name: infoName.trim(), address: infoAddress.trim(), phone: infoPhone.trim(), description: infoDesc.trim(), announcement: announcement.trim() })) setSheet(null);
            }}
          />
          <Text style={styles.tip}>{t('st.reviewNote')}</Text>
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'hours'} onClose={() => setSheet(null)} title={t('st.hours')}>
        <View style={{ gap: Spacing.md }}>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.sheetLabel}>{t('st.opens')}</Text>
            <HourChips values={HOURS} current={openHour} onChange={setOpenHour} />
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.sheetLabel}>{t('st.closes')}</Text>
            <HourChips values={CLOSES} current={closeHour} onChange={setCloseHour} />
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.sheetLabel}>{t('st.closedDays')}</Text>
            <Row gap={8} style={{ flexWrap: 'wrap' }}>
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => {
                const on = closedDays.includes(i);
                return (
                  <Pressable
                    key={d}
                    onPress={() => setClosedDays(on ? closedDays.filter((x) => x !== i) : [...closedDays, i].sort((a, b) => a - b))}
                    accessibilityRole="button"
                    accessibilityLabel={d}
                    accessibilityState={{ selected: on }}
                    style={[styles.hourChip, on && styles.hourChipActive]}>
                    <Text style={[styles.hourText, on && { color: Colors.text, fontWeight: '700' }]}>{d}</Text>
                  </Pressable>
                );
              })}
            </Row>
          </View>
          <Btn label={t('st.saveHours')} size="lg" onPress={async () => {
            if (await patch({ hours: { ...s.hours, open: openHour, close: closeHour, closedDays } })) setSheet(null);
          }} />
          <Text style={styles.tip}>{t('st.hoursTip')}</Text>
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'decor'} onClose={() => setSheet(null)} title={t('st.deco')}>
        <View style={{ gap: Spacing.md }}>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.sheetLabel}>{t('st.bannerColor')}</Text>
            <Row gap={8}>
              {BANNER_COLORS.map((c) => (
                <Pressable
                  key={c}
                  onPress={() => patch({ bannerColor: c })}
                  accessibilityRole="button"
                  accessibilityLabel={c}
                  accessibilityState={{ selected: s.bannerColor === c }}
                  style={[styles.colorDot, { backgroundColor: c }, s.bannerColor === c && styles.colorDotActive]}>
                  {s.bannerColor === c ? <Icon name="checkmark" size={16} color={Colors.white} /> : null}
                </Pressable>
              ))}
            </Row>
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.sheetLabel}>{t('st.cover')}</Text>
            <TextInput value={coverImage} onChangeText={setCoverImage} placeholderTextColor={Colors.textTertiary} style={styles.input} placeholder={t('st.coverPh')} />
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.sheetLabel}>{t('st.poster')}</Text>
            <TextInput value={posterText} onChangeText={setPosterText} placeholderTextColor={Colors.textTertiary} style={styles.input} />
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.sheetLabel}>{t('st.sign')}</Text>
            <TextInput value={sign} onChangeText={setSign} placeholderTextColor={Colors.textTertiary} style={styles.input} />
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.sheetLabel}>{t('st.tagline')}</Text>
            <TextInput value={tagline} onChangeText={setTagline} placeholderTextColor={Colors.textTertiary} style={styles.input} />
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.sheetLabel}>{t('st.story')}</Text>
            <TextInput value={brandStory} onChangeText={setBrandStory} placeholderTextColor={Colors.textTertiary} style={[styles.input, styles.multiline]} multiline />
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.sheetLabel}>{t('st.featured')}</Text>
            <ScrollView style={{ maxHeight: 260 }} showsVerticalScrollIndicator={false} nestedScrollEnabled>
              <View style={{ gap: Spacing.xs }}>
                {products.map((p) => {
                  const on = s.featuredProductIds.includes(p.id);
                  return (
                    <Pressable key={p.id} onPress={() => toggleFeatured(p.id)} accessibilityRole="button" accessibilityLabel={p.name} accessibilityState={{ selected: on }} style={[styles.featRow, on && styles.featActive]}>
                      <Text style={{ fontSize: 18 }}>{p.emoji}</Text>
                      <Text style={{ flex: 1, fontSize: FontSize.sm, color: Colors.text, fontWeight: on ? '700' : '400' }} numberOfLines={1}>{p.name}</Text>
                      {on ? <Icon name="checkmark-circle" size={17} color={Colors.success} /> : <Icon name="add-circle-outline" size={17} color={Colors.textTertiary} />}
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
          </View>
          <Btn label={t('st.saveDeco')} size="lg" onPress={async () => {
            if (await patch({
              coverImage: coverImage.trim(),
              decoration: { posterText: posterText.trim() || s.decoration.posterText, sign: sign.trim() || s.decoration.sign, tagline: tagline.trim() || s.decoration.tagline, brandStory: brandStory.trim() || s.decoration.brandStory, posterColor: s.decoration.posterColor },
            })) setSheet(null);
          }} />
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'delivery'} onClose={() => setSheet(null)} title={t('st.deliverySettings')}>
        <View style={{ gap: Spacing.md }}>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.sheetLabel}>{t('st.radiusKm')}</Text>
            <ChipRow values={RADII} current={radius} onChange={setRadius} suffix=" km" />
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.sheetLabel}>{t('st.feeYuan')}</Text>
            <ChipRow values={FEES} current={fee} onChange={setFee} suffix="" />
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.sheetLabel}>{t('st.estMin')}</Text>
            <ChipRow values={ETAS} current={eta} onChange={setEta} suffix=" min" />
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.sheetLabel}>{t('st.pickupMin')}</Text>
            <ChipRow values={PICKUPS} current={pickup} onChange={setPickup} suffix=" min" />
          </View>
          <Btn label={t('st.saveSettings')} size="lg" onPress={async () => {
            if (await patch({ deliveryRadiusKm: Number(radius), deliveryFee: Number(fee), deliveryEtaMin: Number(eta), pickupReadyMinutes: Number(pickup) })) setSheet(null);
          }} />
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'orders'} onClose={() => setSheet(null)} title={t('st.receivingTitle')}>
        <View style={{ gap: Spacing.md }}>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.sheetLabel}>{t('st.autoAcceptSheet')}</Text>
            <Switch
              value={s.orderSettings.autoAccept}
              onValueChange={(v) => { patch({ orderSettings: { ...s.orderSettings, autoAccept: v } }); }}
              trackColor={{ false: Colors.borderStrong, true: Colors.ink }}
              thumbColor={Colors.white}
            />
            <Text style={styles.tip}>
              {s.orderSettings.autoAccept
                ? t('st.autoAcceptDesc')
                : t('st.manualAcceptDesc')}
            </Text>
          </View>
          {s.orderSettings.autoAccept ? (
            <View style={{ gap: Spacing.sm }}>
              <Text style={styles.sheetLabel}>{t('st.acceptDelay')}</Text>
              <ChipRow
                values={DELAYS}
                current={String(s.orderSettings.autoAcceptDelaySec)}
                onChange={(v) => patch({ orderSettings: { ...s.orderSettings, autoAcceptDelaySec: Number(v) } })}
                suffix="s"
              />
            </View>
          ) : null}
          <ToggleRow label={t('st.preorders')} value={s.orderSettings.preOrderEnabled} onChange={(v) => patch({ orderSettings: { ...s.orderSettings, preOrderEnabled: v } })} />
          <ToggleRow label={t('st.contactless')} sub={t('st.contactlessSub')} value={!!s.orderSettings.contactlessDelivery} onChange={(v) => patch({ orderSettings: { ...s.orderSettings, contactlessDelivery: v } })} />
          <ToggleRow label={t('st.preordersClosed')} sub={t('st.preordersClosedSub')} value={!!s.orderSettings.acceptWhileClosed} onChange={(v) => patch({ orderSettings: { ...s.orderSettings, acceptWhileClosed: v } })} />
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.sheetLabel}>{t('st.orderNotes')}</Text>
            <ChipRow
              values={[t('st.notesNone'), t('st.notesOptional'), t('st.notesRequired')]}
              current={NOTES_LABEL[s.orderSettings.requireNotes ?? 'optional']}
              onChange={(v) => patch({ orderSettings: { ...s.orderSettings, requireNotes: (Object.keys(NOTES_LABEL) as ('none' | 'optional' | 'required')[]).find((k) => NOTES_LABEL[k] === v) ?? 'optional' } })}
              suffix=""
            />
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.sheetLabel}>{t('st.alertSound')}</Text>
            <ChipRow
              values={[t('st.soundBeep'), t('st.soundMelody'), t('st.soundNone')]}
              current={RINGTONE_LABEL[s.orderSettings.ringtone]}
              onChange={(v) => patch({ orderSettings: { ...s.orderSettings, ringtone: (Object.keys(RINGTONE_LABEL) as ('beep' | 'melody' | 'none')[]).find((k) => RINGTONE_LABEL[k] === v) ?? 'beep' } })}
              suffix=""
            />
          </View>
          <ToggleRow label={t('st.voiceLabel')} value={!!s.orderSettings.voiceAnnounce} onChange={(v) => patch({ orderSettings: { ...s.orderSettings, voiceAnnounce: v } })} />
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'promo'} onClose={() => setSheet(null)} title={t('st.plan')}>
        <View style={{ gap: Spacing.md }}>
          <ToggleRow label={t('st.boostDesc')} value={s.promotion.enabled} onChange={(v) => patch({ promotion: { ...s.promotion, enabled: v } })} />
          {s.promotion.enabled ? (
            <>
              <View style={{ gap: Spacing.sm }}>
                <Text style={styles.sheetLabel}>{t('st.dailyBudget')}</Text>
                <ChipRow
                  values={['40', '60', '100', '150']}
                  current={String(s.promotion.dailyBudget)}
                  onChange={(v) => patch({ promotion: { ...s.promotion, dailyBudget: Number(v) } })}
                  suffix=""
                />
              </View>
              <View style={{ gap: Spacing.sm }}>
                <Text style={styles.sheetLabel}>{t('st.focus')}</Text>
                <Row gap={8}>
                  <Pressable onPress={() => patch({ promotion: { ...s.promotion, focus: 'ranking' } })} accessibilityRole="button" accessibilityLabel={t('st.focusSearch')} accessibilityState={{ selected: s.promotion.focus === 'ranking' }} style={[styles.hourChip, s.promotion.focus === 'ranking' && styles.hourChipActive]}>
                    <Text style={[styles.hourText, s.promotion.focus === 'ranking' && { color: Colors.text, fontWeight: '700' }]}>{t('st.focusSearch')}</Text>
                  </Pressable>
                  <Pressable onPress={() => patch({ promotion: { ...s.promotion, focus: 'impressions' } })} accessibilityRole="button" accessibilityLabel={t('st.focusFeed')} accessibilityState={{ selected: s.promotion.focus === 'impressions' }} style={[styles.hourChip, s.promotion.focus === 'impressions' && styles.hourChipActive]}>
                    <Text style={[styles.hourText, s.promotion.focus === 'impressions' && { color: Colors.text, fontWeight: '700' }]}>{t('st.focusFeed')}</Text>
                  </Pressable>
                </Row>
              </View>
            </>
          ) : null}
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'platform'} onClose={() => setSheet(null)} title={t('st.joinCampaign')}>
        {platformCampaigns.find((c) => c.id === platformId) ? (
          <View style={{ gap: Spacing.md }}>
            <Card style={{ gap: 6, backgroundColor: Colors.black }}>
              <Text style={{ color: Colors.primary, fontWeight: '800', fontSize: FontSize.sm }}>{t('st.extraTraffic')}</Text>
              <Text style={{ color: Colors.white, fontSize: FontSize.xl, fontWeight: '800' }}>
                {platformCampaigns.find((c) => c.id === platformId)?.traffic}
              </Text>
            </Card>
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 }}>
              {platformCampaigns.find((c) => c.id === platformId)?.perks}
            </Text>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 16 }}>
              {t('st.requirement', { requirement: platformCampaigns.find((c) => c.id === platformId)?.requirement ?? '' })}
            </Text>
            <Btn label={t('st.signUpNow')} size="lg" onPress={() => { if (platformId) signupPlatform(platformId); setSheet(null); }} />
            <Text style={styles.tip}>{t('st.freeToJoin')}</Text>
          </View>
        ) : null}
      </SheetModal>

      <SheetModal visible={sheet === 'timed-close'} onClose={() => setSheet(null)} title={t('st.closeTimed')}>
        <View style={{ gap: Spacing.md }}>
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 }}>
            {t('st.closeDesc')}
          </Text>
          <ChipRow
            values={REOPEN.map((r) => t(r.label))}
            current={t(REOPEN.find((r) => r.ms === reopenMs)?.label ?? 'st.reopen1h')}
            onChange={(v) => setReopenMs(REOPEN.find((r) => t(r.label) === v)?.ms ?? 3600000)}
            suffix=""
          />
          <Btn label={t('st.closeSchedule')} variant="danger" size="lg" onPress={applyTimedClose} />
          <Text style={styles.tip}>{t('st.reopenServer')}</Text>
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'closure'} onClose={() => setSheet(null)} title={t('st.applyProtection')}>
        <View style={{ gap: Spacing.md }}>
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 }}>
            {t('st.protectionInfo', { n: closure?.remainingDays ?? 15 })}
          </Text>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.sheetLabel}>{t('st.protectionDuration')}</Text>
            <ChipRow
              values={CLOSURE_OPTIONS.map((c) => t(c.label))}
              current={t(CLOSURE_OPTIONS.find((c) => c.days === closureDays)?.label ?? 'st.closureTomorrow')}
              onChange={(v) => setClosureDays(CLOSURE_OPTIONS.find((c) => t(c.label) === v)?.days ?? 1)}
              suffix=""
            />
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.sheetLabel}>{t('st.startTime')}</Text>
            <Row gap={8}>
              <Pressable onPress={() => setClosureImmediate(false)} accessibilityRole="button" accessibilityLabel={t('st.inOneHour')} accessibilityState={{ selected: !closureImmediate }} style={[styles.hourChip, !closureImmediate && styles.hourChipActive]}>
                <Text style={[styles.hourText, !closureImmediate && { color: Colors.text, fontWeight: '700' }]}>{t('st.inOneHour')}</Text>
              </Pressable>
              <Pressable onPress={() => setClosureImmediate(true)} accessibilityRole="button" accessibilityLabel={t('st.startNow')} accessibilityState={{ selected: closureImmediate }} style={[styles.hourChip, closureImmediate && styles.hourChipActive]}>
                <Text style={[styles.hourText, closureImmediate && { color: Colors.text, fontWeight: '700' }]}>{t('st.startNow')}</Text>
              </Pressable>
            </Row>
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.sheetLabel}>{t('st.protectionReasonLabel')}</Text>
            <TextInput value={closureReason} onChangeText={setClosureReason} placeholderTextColor={Colors.textTertiary} style={styles.input} placeholder={t('st.reasonPh')} maxLength={60} />
          </View>
          {err ? <Text style={styles.error}>{err}</Text> : null}
          <Btn label={t('st.applyBtn')} size="lg" onPress={applyClosure} />
          <Text style={styles.tip}>{closureImmediate ? t('st.startsNow') : t('st.startsHour')}</Text>
        </View>
      </SheetModal>
    </Screen>
  );
}

function HourChips({ values, current, onChange }: { values: string[]; current: string; onChange: (v: string) => void }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {values.map((v) => (
        <Pressable key={v} onPress={() => onChange(v)} accessibilityRole="button" accessibilityLabel={v} accessibilityState={{ selected: current === v }} style={[styles.hourChip, current === v && styles.hourChipActive]}>
          <Text style={[styles.hourText, current === v && { color: Colors.text, fontWeight: '700' }]}>{v}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function ChipRow({ values, current, onChange, suffix }: { values: string[]; current: string; onChange: (v: string) => void; suffix: string }) {
  return (
    <Row gap={8} style={{ flexWrap: 'wrap' }}>
      {values.map((v) => (
        <Pressable key={v} onPress={() => onChange(v)} accessibilityRole="button" accessibilityLabel={`${v}${suffix}`} accessibilityState={{ selected: current === v }} style={[styles.hourChip, current === v && styles.hourChipActive]}>
          <Text style={[styles.hourText, current === v && { color: Colors.text, fontWeight: '700' }]}>{v}{suffix}</Text>
        </Pressable>
      ))}
    </Row>
  );
}

const styles = StyleSheet.create({
  storeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
  },
  storeChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primaryDark },
  storeChipText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  storeDot: { width: 7, height: 7, borderRadius: 3.5 },
  statusCard: {},
  bigLabel: { fontSize: FontSize.sm, fontWeight: '600' },
  bigValue: { fontSize: FontSize.xl, fontWeight: '800', marginTop: 4 },
  bigSub: { fontSize: FontSize.xs, marginTop: Spacing.sm },
  protectionCard: {
    backgroundColor: Colors.primarySoft,
    borderWidth: 1,
    borderColor: `${Colors.success}55`,
  },
  bannerPreview: { padding: Spacing.lg, paddingBottom: 0 },
  banner: {
    borderRadius: Radius.lg,
    paddingVertical: 26,
    paddingHorizontal: Spacing.lg,
    gap: 4,
  },
  bannerText: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.white },
  bannerSub: { fontSize: FontSize.sm, color: 'rgba(255,255,255,0.85)' },
  sheetLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
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
  multiline: { minHeight: 72, textAlignVertical: 'top' },
  error: { color: Colors.danger, fontSize: FontSize.sm },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border },
  hourChip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
  },
  hourChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primaryDark },
  hourText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  colorDot: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  colorDotActive: { borderWidth: 2, borderColor: Colors.text },
  featRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 11,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
  },
  featActive: { borderColor: Colors.primaryDark, backgroundColor: Colors.primarySoft },
  tip: { fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'center', lineHeight: 16 },
  campaignHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: Colors.primarySoft,
  },
  campaignTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flex: 1 },
  quickLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
  },
  quickLinkText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '600' },
});
