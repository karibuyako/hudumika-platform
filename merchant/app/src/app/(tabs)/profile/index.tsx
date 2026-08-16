import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Avatar, Btn, Card, Icon, ListRow, Pill, Row, Screen, SectionTitle, SheetModal, ToggleRow } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { useAuthStore } from '@/store/auth';
import { api, ApiError } from '@/api/client';
import { useCustomerStore } from '@/store/customers';
import { useStoreStore } from '@/store/store';
import { tzs } from '@/lib/format';
import { useMessageStore } from '@/store/messages';
import type { CustomerSegment } from '@/types';
import type { BenchmarkSummary, Printer, MerchantStaff, MerchantStaffRole, MerchantStaffStatus, UserProfile } from '@/api/types';

const ROLE_LABEL: Record<MerchantStaffRole, I18nKey> = { owner: 'prof.roleOwner', manager: 'prof.roleManager', cashier: 'prof.roleCashier', kitchen: 'prof.roleKitchen', waiter: 'prof.roleWaiter' };
const STATUS_LABEL: Record<MerchantStaffStatus, I18nKey> = { invited: 'prof.statusInvited', active: 'prof.statusActive', suspended: 'prof.statusSuspended' };
const STATUS_TONE: Record<MerchantStaffStatus, 'neutral' | 'danger' | 'success' | 'info' | 'warning'> = { invited: 'info', active: 'success', suspended: 'danger' };
const INVITE_ROLES: Exclude<MerchantStaffRole, 'owner'>[] = ['manager', 'cashier', 'kitchen', 'waiter'];
const PRINTER_TYPE_LABEL: Record<Printer['type'], I18nKey> = { bluetooth: 'prn.typeBluetooth', network: 'prn.typeNetwork', cloud: 'prn.typeCloud' };

export default function ProfileScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const merchantName = useAuthStore((s) => s.merchantName);
  const phone = useAuthStore((s) => s.phone);
  const logout = useAuthStore((s) => s.logout);
  const notifications = useStoreStore((s) => s.notifications);
  const updateNotifications = useStoreStore((s) => s.updateNotifications);
  const store = useStoreStore((s) => s.store);
  const [staffList, setStaffList] = useState<MerchantStaff[]>([]);
  const [staffFailed, setStaffFailed] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [benchmark, setBenchmark] = useState<BenchmarkSummary | null>(null);
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [profileAvatar, setProfileAvatar] = useState('');
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [pwOpen, setPwOpen] = useState(false);
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState('');
  const pushMessage = useMessageStore((s) => s.push);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [printerName, setPrinterName] = useState('');
  const [printerType, setPrinterType] = useState<Printer['type']>('bluetooth');
  const [printerBusy, setPrinterBusy] = useState(false);
  const [printerError, setPrinterError] = useState('');
  const [testMsg, setTestMsg] = useState('');
  const [inviteRole, setInviteRole] = useState<Exclude<MerchantStaffRole, 'owner'>>('cashier');
  const [showLogout, setShowLogout] = useState(false);
  const [staffTarget, setStaffTarget] = useState<MerchantStaff | null>(null);
  const [staffName, setStaffName] = useState('');
  const [staffPhone, setStaffPhone] = useState('');
  const [staffError, setStaffError] = useState('');
  const [staffBusy, setStaffBusy] = useState(false);
  const [printerSheet, setPrinterSheet] = useState(false);
  const [about, setAbout] = useState(false);
  const [segmentSheet, setSegmentSheet] = useState<CustomerSegment | null>(null);
  const [couponAmount, setCouponAmount] = useState('15');
  const [sent, setSent] = useState<{ ts: number; segment: string; count: number; amount: number }[]>([]);
  const segments = useCustomerStore((s) => s.segments);
  const sendCoupon = useCustomerStore((s) => s.sendCoupon);

  const loadStaff = useCallback(async () => {
    try {
      const staff = await api.get<MerchantStaff[]>('/merchants/me/staff', { retries: 1 });
      setStaffList(staff);
      setStaffFailed(false);
    } catch {
      setStaffFailed(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .get<MerchantStaff[]>('/merchants/me/staff', { retries: 1 })
      .then((r) => {
        if (!cancelled) {
          setStaffList(r);
          setStaffFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setStaffFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadPrinters = useCallback(async () => {
    try {
      const r = await api.get<{ printers: Printer[] }>('/printers?storeId=s_demo', { retries: 1 });
      setPrinters(r.printers);
      setPrinterError('');
    } catch (e) {
      setPrinterError(e instanceof ApiError ? e.message : t('prn.errLoad'));
    }
  }, []);

  useEffect(() => {
    api
      .get<{ printers: Printer[] }>('/printers?storeId=s_demo', { retries: 1 })
      .then((r) => setPrinters(r.printers))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .get<UserProfile>('/users/me', { retries: 1 })
      .then((p) => {
        if (!cancelled) {
          setProfile(p);
          setProfileName(p.fullName);
          setProfileAvatar(p.avatarUrl ?? '');
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  /* Store-health card: server-computed benchmark (ANALYTICS.md:53 — never
   * hardcoded marketing numbers). */
  useEffect(() => {
    let cancelled = false;
    api
      .get<BenchmarkSummary>('/analytics/benchmarks', { retries: 1 })
      .then((b) => {
        if (!cancelled) setBenchmark(b);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const saveProfile = async () => {
    if (!profileName.trim()) return;
    setProfileBusy(true);
    setProfileError('');
    try {
      const updated = await api.patch<UserProfile>('/users/me', { fullName: profileName.trim(), avatarUrl: profileAvatar.trim() || null });
      setProfile(updated);
      setProfileName(updated.fullName);
      setProfileAvatar(updated.avatarUrl ?? '');
      setEditProfileOpen(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({ type: 'system', title: t('prof.profileSaved'), body: t('prof.profileSavedBody') });
    } catch (e) {
      setProfileError(e instanceof ApiError ? e.message : t('prof.errProfile'));
    } finally {
      setProfileBusy(false);
    }
  };

  const changePassword = async () => {
    if (pwNew.length < 8) {
      setPwError(t('prof.passwordHint'));
      return;
    }
    if (pwNew !== pwConfirm) {
      setPwError(t('prof.passwordsMismatch'));
      return;
    }
    setPwBusy(true);
    setPwError('');
    try {
      await api.post('/auth/change-password', { currentPassword: pwCurrent, newPassword: pwNew });
      setPwOpen(false);
      setPwCurrent('');
      setPwNew('');
      setPwConfirm('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({ type: 'system', title: t('prof.passwordChanged'), body: t('prof.passwordChangedBody') });
    } catch (e) {
      setPwError(e instanceof ApiError ? e.message : t('prof.errChangePassword'));
    } finally {
      setPwBusy(false);
    }
  };

  const connectPrinter = async (p: Printer) => {
    setPrinterBusy(true);
    setPrinterError('');
    setTestMsg('');
    try {
      await api.post(`/printers/${p.id}/connect`);
      await loadPrinters();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setPrinterError(e instanceof ApiError ? e.message : t('prn.errConnect'));
    } finally {
      setPrinterBusy(false);
    }
  };

  const testPrinter = async (p: Printer) => {
    setPrinterBusy(true);
    setPrinterError('');
    setTestMsg('');
    try {
      await api.post(`/printers/${p.id}/test`);
      setTestMsg(t('prn.testSent'));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setPrinterError(e instanceof ApiError ? e.message : t('prn.errTest'));
    } finally {
      setPrinterBusy(false);
    }
  };

  const setDefaultPrinter = async (p: Printer) => {
    setPrinterBusy(true);
    setPrinterError('');
    try {
      await api.patch(`/printers/${p.id}`, { isDefault: true });
      await loadPrinters();
    } catch (e) {
      setPrinterError(e instanceof ApiError ? e.message : t('prn.errDefault'));
    } finally {
      setPrinterBusy(false);
    }
  };

  const deletePrinter = async (p: Printer) => {
    setPrinterBusy(true);
    setPrinterError('');
    try {
      await api.delete(`/printers/${p.id}`);
      await loadPrinters();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setPrinterError(e instanceof ApiError ? e.message : t('prn.errDelete'));
    } finally {
      setPrinterBusy(false);
    }
  };

  const addPrinter = async () => {
    if (!printerName.trim()) return;
    setPrinterBusy(true);
    setPrinterError('');
    try {
      await api.post('/printers', { storeId: 's_demo', name: printerName.trim(), type: printerType });
      setPrinterName('');
      setPrinterType('bluetooth');
      await loadPrinters();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setPrinterError(e instanceof ApiError ? e.message : t('prn.errAdd'));
    } finally {
      setPrinterBusy(false);
    }
  };

  const addStaff = async () => {
    if (!staffName.trim() || !staffPhone.trim()) return;
    setStaffBusy(true);
    setStaffError('');
    try {
      const res = await api.post<MerchantStaff>('/merchants/me/staff', { name: staffName.trim(), phone: staffPhone.trim(), role: inviteRole }, { idempotencyKey: `inv:${Date.now()}` });
      setStaffList((l) => [...l, res]);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setStaffName('');
      setStaffPhone('');
      setStaffTarget(null);
    } catch (e) {
      setStaffError(e instanceof ApiError ? e.message : t('prof.errInvite'));
    } finally {
      setStaffBusy(false);
    }
  };

  const changeRole = async (id: string, role: MerchantStaffRole) => {
    setStaffError('');
    try {
      const res = await api.patch<MerchantStaff>(`/merchants/me/staff/${id}`, { role });
      setStaffList((l) => l.map((x) => (x.id === id ? res : x)));
    } catch (e) {
      setStaffError(e instanceof ApiError ? e.message : t('prof.errRole'));
    }
  };

  const changeStatus = async (id: string, status: MerchantStaffStatus) => {
    setStaffError('');
    try {
      const res = await api.patch<MerchantStaff>(`/merchants/me/staff/${id}`, { status });
      setStaffList((l) => l.map((x) => (x.id === id ? res : x)));
    } catch (e) {
      setStaffError(e instanceof ApiError ? e.message : t('prof.errStatus'));
    }
  };

  const removeStaff = async (id: string) => {
    setStaffError('');
    try {
      await api.delete(`/merchants/me/staff/${id}`);
      setStaffList((l) => l.filter((x) => x.id !== id));
      setStaffTarget(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setStaffError(e instanceof ApiError ? e.message : t('prof.errRemove'));
    }
  };

  const connected = printers.filter((p) => p.status === 'connected');

  return (
    <Screen scroll>
      <Card style={{ marginTop: Spacing.lg, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <Avatar name={profile?.fullName || merchantName || 'Store'} size={54} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: FontSize.lg, fontWeight: '800', color: Colors.text }} numberOfLines={1}>
            {profile?.fullName || merchantName || store.name}
          </Text>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 3 }}>
            {t('prof.ownerLine', { phone: profile?.phone || store.phone })}
          </Text>
        </View>
        <Btn label={t('prof.edit')} variant="ghost" size="sm" onPress={() => setEditProfileOpen(true)} />
      </Card>

      <SectionTitle title={t('prof.storeHealth')} icon="pulse" />
      <Card style={{ gap: 12 }}>
        <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <View style={styles.scoreRing}>
              <Text style={styles.scoreNum}>{benchmark ? benchmark.merchantScore : '—'}</Text>
              <Text style={styles.scoreLabel}>{t('prof.score')}</Text>
            </View>
            <View style={{ gap: 3 }}>
              <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary }}>{t('prof.rankIn', { category: benchmark?.category ?? '—' })}</Text>
              <Row gap={8} style={{ alignItems: 'baseline' }}>
                <Text style={{ fontSize: 22, fontWeight: '900', color: Colors.text }}>
                  {benchmark ? `${benchmark.merchantScore} · ${t('an.percentile', { n: benchmark.percentileRank })}` : '—'}
                </Text>
              </Row>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                {benchmark ? `${t('an.industryAvgShort')} ${benchmark.industryAverage} · ${benchmark.category}` : ''}
              </Text>
            </View>
          </View>
          <Pressable onPress={() => router.push('/dashboard/analytics')} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('prof.details')}>
            <Text style={{ fontSize: FontSize.xs, color: Colors.info, fontWeight: '700' }}>{t('prof.details')}</Text>
          </Pressable>
        </Row>
        {benchmark ? (
          <View style={{ gap: 6 }}>
            {benchmark.metrics.map((row) => (
              <Row key={row.metric} style={{ justifyContent: 'space-between' }}>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary, width: 148 }} numberOfLines={1}>{row.metric}</Text>
                <Row gap={6}>
                  <Text style={{ fontSize: FontSize.xs, fontWeight: '800', color: Colors.text, fontVariant: ['tabular-nums'] }}>
                    {row.merchant.toLocaleString('en-US', { maximumFractionDigits: 1 })}
                  </Text>
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                    {t('an.industryAvg', { n: row.average.toLocaleString('en-US', { maximumFractionDigits: 1 }) })}
                  </Text>
                </Row>
              </Row>
            ))}
          </View>
        ) : null}
      </Card>

      <SectionTitle title={t('prof.segments')} icon="pie-chart" />
      <Card style={{ gap: 12 }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('prof.precision')}</Text>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('prof.tracked', { n: 308 })}</Text>
        </Row>
        {segments.map((seg) => (
          <View key={seg.segment} style={{ gap: 6 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Row gap={8}>
                <View style={[styles.segDot, { backgroundColor: seg.color }]} />
                <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text }}>{seg.label}</Text>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                  {t('prof.segCount', { count: seg.count, amount: tzs(seg.avgSpend) })}
                </Text>
              </Row>
              <Btn
                label={seg.segment === 'lapsed' ? t('prof.winBack') : t('prof.sendCoupon')}
                variant={seg.segment === 'lapsed' ? 'danger' : 'subtle'}
                size="sm"
                onPress={() => {
                  setSegmentSheet(seg.segment);
                  setCouponAmount(seg.segment === 'vip' ? '30' : '15');
                }}
              />
            </Row>
            <View style={styles.miniTrack}>
              <View style={[styles.miniFill, { width: `${Math.min(100, (seg.count / 156) * 100)}%`, backgroundColor: seg.color }]} />
            </View>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
              {t('prof.lastOrder', { when: seg.lastOrderDaysAgo === 1 ? 'yesterday' : `${seg.lastOrderDaysAgo} days ago` })}
              {seg.segment === 'lapsed' ? ' · 68% respond to a ¥15 coupon' : ''}
            </Text>
          </View>
        ))}
        {sent.length > 0 ? (
          <View style={{ gap: 5, paddingTop: 4 }}>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '700' }}>{t('prof.recent')}</Text>
            {sent.slice(0, 3).map((s, i) => (
              <Row key={i} style={{ justifyContent: 'space-between' }}>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary }}>{t('prof.campaignRow', { n: s.amount, segment: s.segment })}</Text>
                <Text style={{ fontSize: FontSize.xs, color: Colors.success, fontWeight: '700' }}>{t('prof.sent', { n: s.count })}</Text>
              </Row>
            ))}
          </View>
        ) : null}
      </Card>

      <SectionTitle title={t('prof.team')} icon="people" />
      <Card style={{ paddingVertical: 0, overflow: 'hidden' }}>
        {staffFailed ? (
          <View style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.lg }}>
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('orders.loadFailed')}</Text>
            <Btn label={t('common.retry')} size="sm" variant="outline" onPress={loadStaff} />
          </View>
        ) : staffList.length === 0 ? (
          <View style={{ alignItems: 'center', gap: 4, paddingVertical: Spacing.lg, paddingHorizontal: Spacing.lg }}>
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600', textAlign: 'center' }}>{t('prof.noStaff')}</Text>
          </View>
        ) : (
        staffList.map((s) => (
          <ListRow
            key={s.id}
            icon={s.role === 'owner' ? 'storefront' : s.role === 'manager' ? 'shield-checkmark' : s.role === 'cashier' ? 'card-outline' : s.role === 'kitchen' ? 'restaurant-outline' : 'person'}
            title={s.role === 'owner' ? merchantName || s.name : s.name}
            sub={s.role === 'owner' ? phone : `${t(ROLE_LABEL[s.role])} · ${s.phone}`}
            value={s.role === 'owner' ? t('prof.roleOwner') : undefined}
            trailing={<Pill label={t(STATUS_LABEL[s.status])} tone={STATUS_TONE[s.status]} />}
            onPress={() => {
              setStaffError('');
              setStaffTarget(s);
            }}
          />
        ))
        )}
        <ListRow icon="person-add-outline" title={t('prof.addStaff')} sub={t('prof.addStaffSub')} onPress={() => setStaffTarget(null)} />
      </Card>

      <SectionTitle title={t('prof.notifications')} icon="notifications" />
      <Card style={{ paddingVertical: 0, overflow: 'hidden', paddingHorizontal: Spacing.lg }}>
        <ToggleRow label={t('prof.newOrder')} sub={t('prof.newOrderSub')} value={notifications.newOrder} onChange={(v) => updateNotifications({ newOrder: v })} />
        <View style={styles.divider} />
        <ToggleRow label={t('prof.orderProgress')} value={notifications.orderProgress} onChange={(v) => updateNotifications({ orderProgress: v })} />
        <View style={styles.divider} />
        <ToggleRow label={t('prof.reviews')} sub={t('prof.reviewsSub')} value={notifications.review} onChange={(v) => updateNotifications({ review: v })} />
        <View style={styles.divider} />
        <ToggleRow label={t('prof.campaigns')} value={notifications.campaign} onChange={(v) => updateNotifications({ campaign: v })} />
        <View style={styles.divider} />
        <ToggleRow label={t('prof.platform')} value={notifications.system} onChange={(v) => updateNotifications({ system: v })} />
      </Card>

      <SectionTitle title={t('prof.printer')} icon="print" />
      <Card style={{ paddingVertical: 0, overflow: 'hidden' }}>
        <ListRow
          icon="print-outline"
          title={connected.length ? t('prof.printersConnected', { n: connected.length }) : t('prof.connectBt')}
          sub={
            connected[0]
              ? t('prof.printerDetail', { name: connected[0].name, size: connected[0].paperSize, n: connected[0].copies })
              : t('prof.noPrinter')
          }
          value={connected.length ? t('prn.connected') : t('prn.offline')}
          onPress={() => setPrinterSheet(true)}
        />
      </Card>

      <SectionTitle title={t('prof.more')} icon="ellipsis-horizontal" />
      <Card style={{ paddingVertical: 0, overflow: 'hidden' }}>
        <ListRow icon="shield-checkmark-outline" title={t('prof.verification')} sub={t('prof.verificationSub')} onPress={() => router.push('/profile/verification')} />
        <ListRow icon="phone-portrait-outline" title={t('prof.sessions')} sub={t('prof.sessionsSub')} onPress={() => router.push('/profile/sessions')} />
        <ListRow icon="help-circle-outline" title={t('prof.help')} sub={t('prof.helpSub')} onPress={() => router.push('/dashboard/support')} />
        <ListRow icon="notifications-outline" title={t('prof.notifSettings')} sub={t('prof.notifSettingsSub')} onPress={() => router.push('/dashboard/notifications-settings')} />
        <ListRow icon="shield-checkmark-outline" title={t('prof.audit')} sub={t('prof.auditSub')} onPress={() => router.push('/dashboard/audit')} />
        <ListRow icon="warning-outline" title={t('prof.risk')} sub={t('prof.riskSub')} onPress={() => router.push('/dashboard/risk')} />
        <ListRow icon="key-outline" title={t('prof.changePassword')} sub={t('prof.changePasswordSub')} onPress={() => setPwOpen(true)} />
        <ListRow icon="settings-outline" title={t('prof.settings')} sub={t('prof.settingsSub')} onPress={() => router.push('/profile/settings')} />
        <ListRow icon="information-circle-outline" title={t('prof.about')} sub="Version 2.8.1 (build 20260714)" onPress={() => setAbout(true)} />
      </Card>

      <Card style={{ marginTop: Spacing.xl, paddingVertical: 0, overflow: 'hidden', borderColor: Colors.dangerSoft }}>
        <ListRow icon="log-out-outline" title={t('prof.signOut')} danger onPress={() => setShowLogout(true)} />
      </Card>
      <Text style={styles.version}>{t('prof.demoFooter')}</Text>

      <SheetModal
        visible={!!staffTarget || false}
        onClose={() => setStaffTarget(null)}
        title={staffTarget ? t('prof.permsTitle', { name: staffTarget.name }) : t('prof.addStaffTitle')}>
        <View style={{ gap: Spacing.md }}>
          {staffTarget ? (
            <View style={{ gap: Spacing.md }}>
              <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>
                  {t(ROLE_LABEL[staffTarget.role])} · {staffTarget.phone}
                </Text>
                <Pill label={t(STATUS_LABEL[staffTarget.status])} tone={STATUS_TONE[staffTarget.status]} />
              </Row>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                {staffTarget.role === 'owner'
                  ? t('prof.ownerAccess')
                  : staffTarget.status === 'invited'
                    ? t('prof.staffInvited', { name: staffTarget.name })
                    : t('prof.staffSignIn', { name: staffTarget.name })}
              </Text>
              {staffTarget.role !== 'owner' ? (
                <>
                  <View style={{ gap: Spacing.sm }}>
                    <Text style={styles.fieldLabel}>{t('prof.role')}</Text>
                    <Row gap={8} style={{ flexWrap: 'wrap' }}>
                      {INVITE_ROLES.map((r) => (
                        <Pressable key={r} onPress={() => changeRole(staffTarget.id, r)} accessibilityRole="button" accessibilityLabel={t(ROLE_LABEL[r])} accessibilityState={{ selected: staffTarget.role === r }} style={[styles.roleChip, staffTarget.role === r && styles.roleChipActive]}>
                          <Text style={[styles.roleChipText, staffTarget.role === r && { color: Colors.text, fontWeight: '700' }]}>{t(ROLE_LABEL[r])}</Text>
                        </Pressable>
                      ))}
                    </Row>
                  </View>
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 17 }}>
                    {t('prof.roleMatrix')}
                  </Text>
                  <Btn
                    label={staffTarget.status === 'suspended' ? t('prof.reenable') : t('prof.disable')}
                    variant={staffTarget.status === 'suspended' ? 'outline' : 'danger'}
                    size="md"
                    onPress={() => changeStatus(staffTarget.id, staffTarget.status === 'suspended' ? 'active' : 'suspended')}
                  />
                  <Btn
                    label={t('prof.removeStaff')}
                    variant="danger"
                    size="md"
                    onPress={() => removeStaff(staffTarget.id)}
                  />
                </>
              ) : null}
              {staffError ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{staffError}</Text> : null}
            </View>
          ) : (
            <View style={{ gap: Spacing.md }}>
              <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 }}>
                {t('prof.demoRole')}
              </Text>
              <View style={{ gap: 6 }}>
                <Text style={styles.fieldLabel}>{t('prof.name')}</Text>
                <TextInput value={staffName} onChangeText={setStaffName} placeholder={t('prof.namePh')} placeholderTextColor={Colors.textTertiary} style={styles.input} maxLength={40} accessibilityLabel={t('prof.name')} />
              </View>
              <View style={{ gap: 6 }}>
                <Text style={styles.fieldLabel}>{t('prof.phone')}</Text>
                <TextInput value={staffPhone} onChangeText={setStaffPhone} placeholder={t('prof.phonePh')} placeholderTextColor={Colors.textTertiary} style={styles.input} keyboardType="phone-pad" maxLength={13} accessibilityLabel={t('prof.phone')} />
              </View>
              <View style={{ gap: 6 }}>
                <Text style={styles.fieldLabel}>{t('prof.role')}</Text>
                <Row gap={8} style={{ flexWrap: 'wrap' }}>
                  {INVITE_ROLES.map((r) => (
                    <Pressable key={r} onPress={() => setInviteRole(r)} accessibilityRole="button" accessibilityLabel={t(ROLE_LABEL[r])} accessibilityState={{ selected: inviteRole === r }} style={[styles.roleChip, inviteRole === r && styles.roleChipActive]}>
                      <Text style={[styles.roleChipText, inviteRole === r && { color: Colors.text, fontWeight: '700' }]}>{t(ROLE_LABEL[r])}</Text>
                    </Pressable>
                  ))}
                </Row>
              </View>
              {staffError ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{staffError}</Text> : null}
              <Btn label={t('prof.sendInvite')} onPress={addStaff} disabled={!staffName.trim() || !staffPhone.trim()} size="lg" loading={staffBusy} />
            </View>
          )}
        </View>
      </SheetModal>

      <SheetModal visible={printerSheet} onClose={() => setPrinterSheet(false)} title={t('prof.printerSettings')}>
        <View style={{ gap: Spacing.md }}>
          {printerError ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{printerError}</Text> : null}
          {printers.length === 0 ? (
            <Text style={styles.aboutTip}>{t('prof.noPrinters')}</Text>
          ) : (
            printers.map((p) => (
              <View key={p.id} style={{ gap: Spacing.sm }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <View style={{ flex: 1, gap: 1 }}>
                    <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text }} numberOfLines={1}>
                      {p.isDefault ? t('prof.printerStar', { name: p.name }) : p.name}
                    </Text>
                    <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                      {t(PRINTER_TYPE_LABEL[p.type])} · {p.paperSize} · {t('prn.copies', { copies: p.copies })}
                    </Text>
                  </View>
                  <Pill
                    label={p.status === 'connected' ? t('prn.connected') : p.status === 'pairing' ? t('prn.pairing') : t('prn.offline')}
                    tone={p.status === 'connected' ? 'success' : p.status === 'pairing' ? 'warning' : 'neutral'}
                  />
                </Row>
                <Row gap={Spacing.sm}>
                  {p.status === 'pairing' ? (
                    <Btn label={t('prn.connect')} size="sm" style={{ flex: 1 }} loading={printerBusy} onPress={() => connectPrinter(p)} />
                  ) : null}
                  {p.status === 'connected' ? (
                    <Btn label={t('prn.test')} variant="outline" size="sm" style={{ flex: 1 }} loading={printerBusy} onPress={() => testPrinter(p)} />
                  ) : null}
                  {!p.isDefault ? (
                    <Btn label={t('prn.setDefault')} variant="subtle" size="sm" style={{ flex: 1 }} loading={printerBusy} onPress={() => setDefaultPrinter(p)} />
                  ) : null}
                  <Btn label={t('prn.delete')} variant="danger" size="sm" style={{ flex: 1 }} loading={printerBusy} onPress={() => deletePrinter(p)} />
                </Row>
              </View>
            ))
          )}
          {testMsg ? <Text style={{ color: Colors.success, fontSize: FontSize.xs, fontWeight: '700' }}>{testMsg}</Text> : null}
          <View style={styles.divider} />
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('prn.add')}</Text>
            <TextInput
              value={printerName}
              onChangeText={setPrinterName}
              placeholder={t('prn.name')}
              placeholderTextColor={Colors.textTertiary}
              style={styles.input}
              maxLength={30}
              accessibilityLabel={t('prn.add')}
            />
            <Row gap={8}>
              {(['bluetooth', 'network', 'cloud'] as const).map((pt) => (
                <Pressable
                  key={pt}
                  onPress={() => setPrinterType(pt)}
                  accessibilityRole="button"
                  accessibilityLabel={t(PRINTER_TYPE_LABEL[pt])}
                  accessibilityState={{ selected: printerType === pt }}
                  style={[styles.paperChip, printerType === pt && styles.paperChipActive]}>
                  <Text style={[styles.paperText, printerType === pt && { color: Colors.text, fontWeight: '700' }]}>{PRINTER_TYPE_LABEL[pt]}</Text>
                </Pressable>
              ))}
            </Row>
            <Btn label={t('prn.add')} size="lg" loading={printerBusy} disabled={!printerName.trim()} onPress={addPrinter} />
          </View>
        </View>
      </SheetModal>

      <SheetModal
        visible={!!segmentSheet}
        onClose={() => setSegmentSheet(null)}
        title={segmentSheet === 'lapsed' ? t('prof.winBackTitle') : t('prof.precisionCoupon')}>
        <View style={{ gap: Spacing.md }}>
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 20 }}>
            {segmentSheet === 'lapsed'
              ? t('prof.lapsedDesc')
              : segmentSheet === 'vip'
                ? t('prof.vipDesc')
                : t('prof.otherDesc')}
          </Text>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('prof.couponValue')}</Text>
            <Row gap={8}>
              {['10', '15', '20', '30'].map((a) => (
                <Pressable
                  key={a}
                  onPress={() => setCouponAmount(a)}
                  accessibilityRole="button"
                  accessibilityLabel={`¥${a}`}
                  accessibilityState={{ selected: couponAmount === a }}
                  style={[styles.paperChip, couponAmount === a && styles.paperChipActive]}>
                  <Text style={[styles.paperText, couponAmount === a && { color: Colors.text, fontWeight: '700' }]}>¥{a}</Text>
                </Pressable>
              ))}
            </Row>
          </View>
          <Btn
            label={t('prof.sendAll')}
            size="lg"
            onPress={() => {
              if (!segmentSheet) return;
              sendCoupon(segmentSheet, Number(couponAmount)).then((n) => {
                const label = segments.find((s) => s.segment === segmentSheet)?.label ?? segmentSheet;
                setSent((prev) => [{ ts: Date.now(), segment: label, count: n, amount: Number(couponAmount) }, ...prev]);
              });
              setSegmentSheet(null);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            }}
          />
          <Text style={styles.aboutTip}>{t('prof.budgetTip')}</Text>
        </View>
      </SheetModal>

      <SheetModal visible={editProfileOpen} onClose={() => setEditProfileOpen(false)} title={t('prof.editProfileTitle')}>
        <View style={{ gap: Spacing.md }}>
          <View style={{ gap: 6 }}>
            <Text style={styles.fieldLabel}>{t('prof.fullName')}</Text>
            <TextInput value={profileName} onChangeText={setProfileName} placeholder={t('prof.namePh')} placeholderTextColor={Colors.textTertiary} style={styles.input} maxLength={120} accessibilityLabel={t('prof.fullName')} />
          </View>
          <View style={{ gap: 6 }}>
            <Text style={styles.fieldLabel}>{t('prof.avatarUrl')}</Text>
            <TextInput value={profileAvatar} onChangeText={setProfileAvatar} placeholder="https://…" placeholderTextColor={Colors.textTertiary} style={styles.input} autoCapitalize="none" autoCorrect={false} accessibilityLabel={t('prof.avatarUrl')} />
          </View>
          {profileError ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{profileError}</Text> : null}
          <Btn label={t('common.save')} size="lg" loading={profileBusy} disabled={!profileName.trim()} onPress={saveProfile} />
        </View>
      </SheetModal>

      <SheetModal visible={pwOpen} onClose={() => setPwOpen(false)} title={t('prof.changePasswordTitle')}>
        <View style={{ gap: Spacing.md }}>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('prof.demoCurrentPw')}</Text>
          <View style={{ gap: 6 }}>
            <Text style={styles.fieldLabel}>{t('prof.currentPassword')}</Text>
            <TextInput value={pwCurrent} onChangeText={setPwCurrent} style={styles.input} secureTextEntry autoCapitalize="none" accessibilityLabel={t('prof.currentPassword')} />
          </View>
          <View style={{ gap: 6 }}>
            <Text style={styles.fieldLabel}>{t('prof.newPassword')}</Text>
            <TextInput value={pwNew} onChangeText={setPwNew} style={styles.input} secureTextEntry autoCapitalize="none" accessibilityLabel={t('prof.newPassword')} />
          </View>
          <View style={{ gap: 6 }}>
            <Text style={styles.fieldLabel}>{t('prof.confirmPassword')}</Text>
            <TextInput value={pwConfirm} onChangeText={setPwConfirm} style={styles.input} secureTextEntry autoCapitalize="none" accessibilityLabel={t('prof.confirmPassword')} />
          </View>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('prof.passwordHint')}</Text>
          {pwError ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{pwError}</Text> : null}
          <Btn label={t('prof.changePassword')} size="lg" loading={pwBusy} disabled={!pwCurrent || !pwNew || !pwConfirm} onPress={changePassword} />
        </View>
      </SheetModal>

      <SheetModal visible={showLogout} onClose={() => setShowLogout(false)} title={t('prof.signOutQ')}>        <Text style={{ fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22 }}>
          {t('prof.signOutBody')}
        </Text>
        <Row gap={10}>
          <Btn label={t('prof.cancel')} variant="outline" onPress={() => setShowLogout(false)} style={{ flex: 1 }} />
          <Btn
            label={t('prof.signOut')}
            variant="danger"
            onPress={() => {
              logout();
              router.replace('/login');
            }}
            style={{ flex: 1 }}
          />
        </Row>
      </SheetModal>

      <SheetModal visible={about} onClose={() => setAbout(false)} title={t('prof.aboutTitle')}>
        <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22 }}>
          {t('prof.aboutBody')}{'\n'}
          {t('prof.aboutAccount', { phone })}{'\n'}
          {t('prof.aboutStore', { name: store.name })}{'\n'}
          {t('prof.aboutProject')}
        </Text>
        <View style={styles.aboutIcons}>
          <Icon name="storefront" size={15} color={Colors.textTertiary} />
        </View>
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border },
  scoreRing: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Colors.primarySoft,
    borderWidth: 3,
    borderColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scoreNum: { fontSize: 22, fontWeight: '900', color: Colors.text },
  scoreLabel: { fontSize: 9, color: Colors.textTertiary, fontWeight: '700', letterSpacing: 0.5 },
  miniTrack: { flex: 1, height: 6, borderRadius: 3, backgroundColor: Colors.surface, overflow: 'hidden' },
  miniFill: { height: 6, borderRadius: 3 },
  segDot: { width: 10, height: 10, borderRadius: 5 },
  roleChip: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
  },
  roleChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primaryDark },
  roleChipText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  fieldLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 11,
    fontSize: FontSize.md,
    color: Colors.text,
    backgroundColor: Colors.card,
  },
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
  paperChip: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
  },
  paperChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primaryDark },
  paperText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  aboutTip: { fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'center' },
  version: {
    fontSize: FontSize.xs,
    color: Colors.textTertiary,
    textAlign: 'center',
    marginTop: Spacing.md,
  },
  aboutIcons: { alignItems: 'center' },
});