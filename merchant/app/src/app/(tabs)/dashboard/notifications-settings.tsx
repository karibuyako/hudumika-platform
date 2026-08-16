import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Divider, Icon, Pill, Row, Screen, SectionTitle, ToggleRow } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { useNotificationsSettingsStore } from '@/store/notifications-settings';
import type { OrderAlertSettings } from '@/api/types';

const EVENT_ROWS: { key: string; label: I18nKey }[] = [
  { key: 'order.created', label: 'notif.evNewOrder' },
  { key: 'order.status', label: 'notif.evOrderStatus' },
  { key: 'refund.processed', label: 'notif.evRefund' },
  { key: 'review.received', label: 'notif.evReview' },
  { key: 'ticket.reply', label: 'notif.evTicket' },
  { key: 'withdrawal.paid', label: 'notif.evWithdrawal' },
  { key: 'marketing.campaign', label: 'notif.evCampaign' },
  { key: 'system.announcement', label: 'notif.evAnnouncement' },
];

/* System events render locked-on — they cannot be disabled
 * (NOTIFICATIONS.md §Preferences; backend/NOTIFICATIONS.md high-priority set).
 * Mirrors LOCKED_PREFERENCE_EVENTS in the mock. */
const LOCKED_EVENTS: ReadonlySet<string> = new Set([
  'system.announcement',
  'otp.requested',
  'otp.verified',
  'withdrawal.failed',
  'payout.failed',
]);

const CHANNELS: { key: 'push' | 'sms' | 'email' | 'inApp'; label: I18nKey; tint: string }[] = [
  { key: 'push', label: 'notif.push', tint: Colors.info },
  { key: 'email', label: 'notif.email', tint: Colors.primary },
  { key: 'sms', label: 'notif.sms', tint: Colors.warning },
  { key: 'inApp', label: 'notif.inApp', tint: Colors.success },
];

const ALERT_CHANNELS: { key: 'push' | 'sms' | 'in_app'; label: I18nKey }[] = [
  { key: 'push', label: 'notif.push' },
  { key: 'sms', label: 'notif.sms' },
  { key: 'in_app', label: 'notif.inApp' },
];

export default function NotificationsSettingsScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const preferences = useNotificationsSettingsStore((s) => s.preferences);
  const orderSettings = useNotificationsSettingsStore((s) => s.orderSettings);
  const loading = useNotificationsSettingsStore((s) => s.loading);
  const loadError = useNotificationsSettingsStore((s) => s.error);
  const hydrate = useNotificationsSettingsStore((s) => s.hydrate);
  const savePreferences = useNotificationsSettingsStore((s) => s.savePreferences);
  const saveOrderSettings = useNotificationsSettingsStore((s) => s.saveOrderSettings);

  const [savingPrefs, setSavingPrefs] = useState(false);
  const [savingOrders, setSavingOrders] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<{ autoAccept: string; quietFrom: string; quietTo: string } | null>(null);
  const [pushPerm, setPushPerm] = useState<'granted' | 'denied' | 'undetermined' | null>(null);
  const [pushToken, setPushToken] = useState<string | null>(null);

  useEffect(() => {
    hydrate();
    if (Platform.OS !== 'web') {
      import('@/lib/push').then((m) =>
        m.getPushPermission().then((p) => {
          setPushPerm(p);
          return p;
        }),
      );
    }
  }, [hydrate]);

  const enablePush = async () => {
    const mod = await import('@/lib/push');
    const p = await mod.requestPushPermission(t('notif.pushReason'));
    setPushPerm(p);
    if (p === 'granted') {
      const token = await mod.registerPushToken();
      setPushToken(token);
      if (token) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  /* Mobile: register/refresh the Expo push token (NOTIFICATIONS.md §Push
   * setup — per-device, stored server-side). */
  const registerPush = async () => {
    const mod = await import('@/lib/push');
    const token = await mod.registerPushToken();
    setPushToken(token);
    if (token) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  /* Local editable copies are derived from the store (never synced via effect):
   * typing into the inputs flips on the draft, which then drives the values. */
  const autoAccept = draft?.autoAccept ?? String(orderSettings?.autoAcceptWithinSeconds ?? 60);
  const quietFrom = draft?.quietFrom ?? orderSettings?.quietHours?.from ?? '22:00';
  const quietTo = draft?.quietTo ?? orderSettings?.quietHours?.to ?? '08:00';

  const setDraftField = (patch: Partial<{ autoAccept: string; quietFrom: string; quietTo: string }>) =>
    setDraft((d) => ({
      autoAccept: d?.autoAccept ?? String(orderSettings?.autoAcceptWithinSeconds ?? 60),
      quietFrom: d?.quietFrom ?? orderSettings?.quietHours?.from ?? '22:00',
      quietTo: d?.quietTo ?? orderSettings?.quietHours?.to ?? '08:00',
      ...patch,
    }));

  /** Locked-on system events are forced enabled on every channel. */
  const withLockedEvents = (prefs: NonNullable<typeof preferences>): NonNullable<typeof preferences> => {
    const next = {
      push: { ...prefs.push },
      sms: { ...prefs.sms },
      email: { ...prefs.email },
      inApp: { ...prefs.inApp },
    };
    for (const channel of ['push', 'sms', 'email', 'inApp'] as const) {
      for (const key of LOCKED_EVENTS) {
        next[channel][key] = true;
      }
    }
    return next;
  };

  const persistPrefs = (next: NonNullable<typeof preferences>) => {
    setSavingPrefs(true);
    setError('');
    savePreferences(withLockedEvents(next))
      .then(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light))
      .catch(() => setError(t('notif.errSave')))
      .finally(() => setSavingPrefs(false));
  };

  const togglePref = (channel: 'push' | 'sms' | 'email' | 'inApp', event: string) => {
    if (!preferences) return;
    const next = {
      push: { ...preferences.push },
      sms: { ...preferences.sms },
      email: { ...preferences.email },
      inApp: { ...preferences.inApp },
    };
    next[channel][event] = !next[channel][event];
    persistPrefs(next);
  };

  /* "Disable all except system" quick toggle (NOTIFICATIONS.md §Preferences). */
  const disableAllButSystem = () => {
    if (!preferences) return;
    const next = {
      push: { ...preferences.push },
      sms: { ...preferences.sms },
      email: { ...preferences.email },
      inApp: { ...preferences.inApp },
    };
    for (const channel of ['push', 'sms', 'email', 'inApp'] as const) {
      for (const key of Object.keys(next[channel])) {
        if (!LOCKED_EVENTS.has(key)) next[channel][key] = false;
      }
    }
    persistPrefs(next);
  };

  const toggleChannel = (channel: 'push' | 'sms' | 'in_app') => {
    if (!orderSettings) return;
    const channels = orderSettings.channels.includes(channel)
      ? orderSettings.channels.filter((c) => c !== channel)
      : [...orderSettings.channels, channel];
    persistOrder({ channels });
  };

  const persistOrder = (patch: Partial<OrderAlertSettings>) => {
    if (!orderSettings) return;
    setSavingOrders(true);
    setError('');
    saveOrderSettings({ ...orderSettings, ...patch })
      .then(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light))
      .catch(() => setError(t('notif.errSave')))
      .finally(() => setSavingOrders(false));
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('notif.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        {loading && !preferences ? (
          <View style={{ gap: Spacing.md }}>
            {[1, 2, 3].map((i) => (
              <Card key={i} style={{ gap: Spacing.md }}>
                <View style={[styles.skeletonLine, { width: '40%' }]} />
                <View style={[styles.skeletonLine, { width: '80%' }]} />
              </Card>
            ))}
          </View>
        ) : null}

        {loadError && !preferences ? (
          <Card style={{ gap: Spacing.sm, alignItems: 'center' }}>
            <Icon name="cloud-offline-outline" size={22} color={Colors.danger} />
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' }}>{t('notif.errLoad')}</Text>
            <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => hydrate()} />
          </Card>
        ) : null}

        {Platform.OS !== 'web' ? (
          <Card style={{ gap: Spacing.sm, marginBottom: Spacing.md }}>
            <Row gap={10}>
              <View style={styles.pushIcon}>
                <Icon name="notifications-outline" size={18} color={Colors.info} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: FontSize.sm, fontWeight: '800', color: Colors.text }}>{t('notif.pushPermission')}</Text>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                  {pushPerm === 'granted' ? t('notif.pushGranted') : t('notif.pushDenied')}
                </Text>
              </View>
            </Row>
            <Row gap={8}>
              {pushPerm !== 'granted' ? (
                <Btn label={t('notif.pushEnable')} size="sm" onPress={enablePush} />
              ) : (
                <Btn label={pushToken ? t('notif.pushRegistered') : t('notif.pushRegister')} size="sm" variant="outline" onPress={registerPush} />
              )}
            </Row>
          </Card>
        ) : null}

        <SectionTitle title={t('notif.preferences')} icon="notifications" />
        <Card style={{ paddingVertical: 0, overflow: 'hidden' }}>
          <Row style={styles.channelHeader}>
            <View style={styles.eventLabelCell} />
            {CHANNELS.map((c) => (
              <View key={c.key} style={styles.channelCell}>
                <Text style={{ color: c.tint, fontSize: FontSize.xs, fontWeight: '800' }}>{t(c.label)}</Text>
              </View>
            ))}
          </Row>
          {EVENT_ROWS.map((row, i) => {
            const locked = LOCKED_EVENTS.has(row.key);
            const enabled = (channel: 'push' | 'sms' | 'email' | 'inApp') => locked || !!preferences?.[channel]?.[row.key];
            return (
              <View key={row.key}>
                {i > 0 ? <Divider /> : null}
                <Row style={styles.eventRow}>
                  <View style={styles.eventLabelCell}>
                    <Text style={styles.eventLabel} numberOfLines={1}>{t(row.label)}</Text>
                    {locked ? (
                      <View style={styles.lockedTag}>
                        <Icon name="lock-closed-outline" size={10} color={Colors.primaryDark} />
                        <Text style={styles.lockedTagText}>{t('notif.locked')}</Text>
                      </View>
                    ) : null}
                  </View>
                  {CHANNELS.map((c) => (
                    <View key={c.key} style={styles.channelCell}>
                      <Pressable
                        onPress={() => togglePref(c.key, row.key)}
                        hitSlop={6}
                        accessibilityRole="switch"
                        accessibilityLabel={`${t(row.label)} ${t(c.label)}`}
                        accessibilityState={{ checked: enabled(c.key), disabled: locked || savingPrefs }}
                        disabled={locked || savingPrefs}
                        style={[
                          styles.channelDot,
                          { borderColor: locked ? Colors.borderStrong : c.tint },
                          enabled(c.key) && { backgroundColor: locked ? Colors.primary : c.tint },
                        ]}
                      />
                    </View>
                  ))}
                </Row>
              </View>
            );
          })}
          <Divider />
          <View style={{ padding: Spacing.md }}>
            <Btn label={t('notif.disableAllButSystem')} variant="outline" size="sm" loading={savingPrefs} disabled={!preferences} onPress={disableAllButSystem} />
          </View>
        </Card>

        <SectionTitle title={t('notif.orderAlerts')} icon="timer" />
        <Card style={{ gap: Spacing.md }}>
          <Text style={styles.sectionHint}>{t('notif.orderAlertsHint')}</Text>

          <View style={{ gap: 6 }}>
            <Text style={styles.fieldLabel}>{t('notif.acceptanceMethod')}</Text>
            <Row gap={8}>
              {(['manual', 'auto'] as const).map((m) => (
                <Pressable
                  key={m}
                  onPress={() => persistOrder({ acceptanceMethod: m })}
                  accessibilityRole="button"
                  accessibilityState={{ selected: orderSettings?.acceptanceMethod === m }}
                  style={[styles.optionChip, orderSettings?.acceptanceMethod === m && styles.optionChipActive]}>
                  <Text style={[styles.optionText, orderSettings?.acceptanceMethod === m && { color: Colors.white, fontWeight: '700' }]}>
                    {t(m === 'manual' ? 'notif.manual' : 'notif.auto')}
                  </Text>
                </Pressable>
              ))}
            </Row>
          </View>

          <ToggleRow label={t('notif.voiceAlerts')} value={!!orderSettings?.voiceAlerts} onChange={(v) => persistOrder({ voiceAlerts: v })} />

          <View style={{ gap: 6 }}>
            <Text style={styles.fieldLabel}>{t('notif.channels')}</Text>
            <Row gap={8}>
              {ALERT_CHANNELS.map((c) => {
                const on = !!orderSettings?.channels.includes(c.key);
                return (
                  <Pressable
                    key={c.key}
                    onPress={() => toggleChannel(c.key)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    style={[styles.optionChip, on && styles.optionChipActive]}>
                    <Text style={[styles.optionText, on && { color: Colors.white, fontWeight: '700' }]}>{t(c.label)}</Text>
                  </Pressable>
                );
              })}
            </Row>
          </View>

          <Divider />

          <ToggleRow
            label={t('notif.quietHours')}
            sub={t('notif.quietHoursSub')}
            value={!!orderSettings?.quietHours?.enabled}
            onChange={(v) => persistOrder({ quietHours: { enabled: v, from: quietFrom, to: quietTo } })}
          />
          {orderSettings?.quietHours?.enabled ? (
            <Row gap={8}>
              <TextInput
                value={quietFrom}
                onChangeText={(v) => {
                  setDraftField({ quietFrom: v });
                  persistOrder({ quietHours: { enabled: true, from: v, to: quietTo } });
                }}
                placeholder="22:00"
                placeholderTextColor={Colors.textTertiary}
                style={styles.timeInput}
                maxLength={5}
                accessibilityLabel={t('notif.quietFrom')}
              />
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>–</Text>
              <TextInput
                value={quietTo}
                onChangeText={(v) => {
                  setDraftField({ quietTo: v });
                  persistOrder({ quietHours: { enabled: true, from: quietFrom, to: v } });
                }}
                placeholder="08:00"
                placeholderTextColor={Colors.textTertiary}
                style={styles.timeInput}
                maxLength={5}
                accessibilityLabel={t('notif.quietTo')}
              />
            </Row>
          ) : null}

          <Divider />

          <View style={{ gap: 6 }}>
            <Text style={styles.fieldLabel}>{t('notif.autoAcceptSeconds')}</Text>
            <Row gap={8}>
              <TextInput
                value={autoAccept}
                onChangeText={(v) => setDraftField({ autoAccept: v })}
                keyboardType="number-pad"
                style={styles.timeInput}
                maxLength={3}
                accessibilityLabel={t('notif.autoAcceptSeconds')}
              />
              <Btn
                label={t('common.apply')}
                size="sm"
                disabled={!autoAccept}
                loading={savingOrders}
                onPress={() => {
                  const n = Number(autoAccept);
                  if (Number.isInteger(n) && n >= 30 && n <= 300) {
                    persistOrder({ autoAcceptWithinSeconds: n });
                  }
                }}
              />
              <Pill label={t('notif.seconds', { n: autoAccept || '60' })} tone="neutral" />
            </Row>
          </View>
        </Card>
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
  error: { color: Colors.danger, fontSize: FontSize.xs, marginBottom: Spacing.md },
  channelHeader: { paddingVertical: 10, paddingHorizontal: Spacing.lg, backgroundColor: Colors.surface },
  eventRow: { paddingHorizontal: Spacing.lg, paddingVertical: 12 },
  eventLabelCell: { flex: 1, gap: 3 },
  eventLabel: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.text },
  lockedTag: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
  lockedTagText: { fontSize: 10, color: Colors.primaryDark, fontWeight: '700' },
  channelCell: { width: 40, alignItems: 'center', justifyContent: 'center' },
  channelDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
  },
  sectionHint: { fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 17 },
  fieldLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  optionChip: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
  },
  optionChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primaryDark },
  optionText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  timeInput: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 9,
    fontSize: FontSize.sm,
    color: Colors.text,
    backgroundColor: Colors.card,
    minWidth: 88,
    textAlign: 'center',
  },
  pushIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: Colors.infoSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skeletonLine: { height: 12, borderRadius: 6, backgroundColor: Colors.surface },
});
