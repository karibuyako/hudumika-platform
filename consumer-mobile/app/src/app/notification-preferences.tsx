import { useCallback, useEffect, useState } from 'react';
import * as Haptics from 'expo-haptics';
import { StyleSheet, Text, View } from 'react-native';

import { Btn, Card, EmptyState, ErrorState, Screen, SkeletonCard, ToggleRow } from '@/components/ui';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t, type I18nKey } from '@/i18n';
import { toast } from '@/store/ui';
import { idempotencyKey } from '@/lib/idempotency';
import { getNotificationsRepository } from '@/repos';
import { useSessionStore } from '@/store/session';
import { ApiError } from '@/api/client';
import type { NotificationPreferences } from '@hudumika/contract';

type Channel = 'push' | 'sms' | 'email' | 'inApp';

const CHANNEL_NAMES: Record<Channel, string> = { push: 'Push', sms: 'SMS', email: 'Email', inApp: 'In-app' };

/* Per-event preference sections — the keys are the app's own notification
 * catalog (docs/NOTIFICATIONS.md + src/store/events.ts): every key the
 * backend accepts for a customer channel. One toggle per event drives the
 * primary (push) channel; the row's sub-line lists the secondary channels
 * that are still on for that event. */
const SECTIONS: { titleKey: I18nKey; events: string[]; locked?: boolean }[] = [
  {
    titleKey: 'notifications.section.orders',
    events: ['order.created', 'order.updated', 'order.delivered', 'order.cancelled', 'order.scheduled_reminder', 'order.rush_requested'],
  },
  {
    titleKey: 'notifications.section.payments',
    events: ['payment.captured', 'payment.failed', 'refund.processed'],
  },
  {
    titleKey: 'notifications.section.bookings',
    events: ['booking.requested', 'booking.accepted', 'booking.declined', 'booking.reminder', 'booking.arrived', 'booking.no_show'],
  },
  {
    titleKey: 'notifications.section.promotions',
    events: ['promotion.new', 'coupon.claimed', 'red_packet.available'],
  },
  {
    titleKey: 'notifications.section.reviews',
    events: ['review.received', 'ticket.reply', 'dispute.opened', 'dispute.resolved'],
  },
  {
    titleKey: 'notifications.section.logistics',
    events: ['intercity.eta_updated', 'waybill.updated', 'delivery.delayed', 'warehouse.fulfilled'],
  },
  {
    titleKey: 'notifications.section.system',
    events: ['security.otp', 'security.login'],
    locked: true,
  },
];

/** Backend rule (NOTIFICATIONS.md): system & security alerts are always on. */
const LOCKED_EVENTS = SECTIONS.filter((s) => s.locked).flatMap((s) => s.events);

/** The backend catalog also rejects events it does not know (422
 * PREFERENCE_INVALID_EVENT); the invalid key comes from the error message. */
const INVALID_EVENT_RE = /Unknown notification event: (\S+)/;

const labelKey = (event: string): I18nKey => `notifications.event.${event}` as I18nKey;

export default function NotificationPreferencesScreen() {
  const user = useSessionStore((s) => s.user);
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [invalidEvent, setInvalidEvent] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError('');
    setInvalidEvent(null);
    try {
      setPrefs(await getNotificationsRepository().getPreferences());
    } catch {
      setError(t('common.error'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = (key: string) => {
    // Locked-off rows (system/security) are not togglable — the repo enforces
    // the same rule server-side.
    if (LOCKED_EVENTS.includes(key)) return;
    setPrefs((prev) => {
      if (!prev) return prev;
      const map = { ...(prev.push ?? {}) };
      map[key] = !map[key];
      return { ...prev, push: map };
    });
    setSaved(false);
    setInvalidEvent(null);
  };

  // Optimistic save with rollback to server state on failure: the local
  // toggles were already applied on tap; a rejected save reloads the server
  // copy (server state wins). PREFERENCE_INVALID_EVENT keeps the screen up and
  // highlights the offending row instead of the generic error.
  const save = async () => {
    if (!prefs) return;
    setSaving(true);
    setError('');
    setInvalidEvent(null);
    try {
      await getNotificationsRepository().putPreferences(prefs, idempotencyKey(user?.id ?? 'customer', 'prefs'));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      toast(t('notifications.saved'));
      setSaved(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PREFERENCE_INVALID_EVENT') {
        const match = e.message.match(INVALID_EVENT_RE);
        setInvalidEvent(match?.[1] ?? null);
        await load(); // rollback — server state wins
        return;
      }
      setError(t('common.error'));
      await load(); // server state wins
    } finally {
      setSaving(false);
    }
  };

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (!prefs) {
    return (
      <Screen>
        <SkeletonCard rows={4} />
      </Screen>
    );
  }

  const channels = ['push', 'sms', 'email', 'inApp'] as const;
  const toggleableEvents = SECTIONS.filter((s) => !s.locked).flatMap((s) => s.events);
  const total = toggleableEvents.reduce((acc, e) => acc + ((prefs.push?.[e] ?? false) ? 1 : 0), 0);

  /** Secondary channels still on for an event (the row's own push toggle is
   * excluded) — keeps the per-channel shape visible without a sub-toggle UI. */
  const secondaryChannels = (key: string): string =>
    channels.filter((c) => c !== 'push' && prefs[c]?.[key]).map((c) => CHANNEL_NAMES[c]).join(' · ');

  return (
    <Screen scroll>
      <Text style={styles.title}>{t('notifications.preferences')}</Text>
      {total === 0 ? (
        <EmptyState icon="notifications-off-outline" title={t('notifications.empty')} />
      ) : null}
      {SECTIONS.map((section) => (
        <Card key={section.titleKey} style={{ marginBottom: Spacing.md }}>
          <Text style={styles.section}>{t(section.titleKey)}</Text>
          {section.events.map((event) => {
            const locked = LOCKED_EVENTS.includes(event);
            const invalid = invalidEvent === event;
            const secondary = secondaryChannels(event);
            return (
              <View key={event}>
                <ToggleRow
                  label={t(labelKey(event))}
                  sub={locked ? t('notifications.lockedHelper') : secondary || undefined}
                  value={locked ? true : !!prefs.push?.[event]}
                  onChange={() => toggle(event)}
                  disabled={locked}
                />
                {invalid ? (
                  <Text style={styles.invalid} accessibilityRole="alert">
                    {t('notifications.prefInvalidEvent')}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </Card>
      ))}
      {saved ? <Text style={styles.saved}>{t('common.done')} ✓</Text> : null}
      <Btn label={t('common.save')} onPress={save} size="lg" loading={saving} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text, marginBottom: Spacing.md },
  section: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sansSemibold, marginBottom: Spacing.sm },
  saved: { color: Colors.success, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, marginBottom: Spacing.sm },
  invalid: { color: Colors.danger, fontSize: FontSize.xs, fontFamily: Fonts.sansMedium, marginBottom: Spacing.sm },
});
