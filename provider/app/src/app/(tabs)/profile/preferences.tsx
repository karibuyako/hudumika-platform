import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { Card, ErrorCard, Screen, SectionTitle, ToggleRow } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { capitalize } from '@/lib/format';
import { getNotificationsRepository } from '@/repos';
import type { NotificationPreferences } from '@hudumika/contract';

const GROUPS: { key: string; events: string[]; locked?: boolean }[] = [
  {
    key: 'bookings',
    events: ['booking.requested', 'job.offered', 'quote.requested', 'booking.accepted', 'job.assigned_technician', 'booking.reminder', 'sla.deadline_approaching'],
  },
  { key: 'payouts', events: ['payout.paid', 'payout.failed', 'payout.exception'] },
  { key: 'reviews', events: ['review.received'] },
  { key: 'support', events: ['ticket.reply'] },
  { key: 'system', events: ['dispute.opened', 'trust.flag_raised', 'document.expiring', 'document.expired'], locked: true },
];

const eventLabel = (event: string) => event.split('.').map(capitalize).join(' ');

export default function PreferencesScreen() {
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');

  const load = async () => {
    try {
      setPrefs(await getNotificationsRepository().getPreferences());
      setError('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('misc.error'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const onToggle = async (event: string, value: boolean) => {
    if (!prefs) return;
    const previous = prefs;
    const next = { ...prefs, push: { ...(prefs.push ?? {}), [event]: value } };
    setPrefs(next);
    setSaveError('');
    try {
      setPrefs(await getNotificationsRepository().putPreferences(next));
    } catch {
      setPrefs(previous);
      setSaveError(t('prefs.saveError'));
    }
  };

  if (loading && !prefs) {
    return (
      <Screen>
        <View style={styles.center}>
          <ActivityIndicator color={Colors.primary} />
        </View>
      </Screen>
    );
  }

  if (error && !prefs) {
    return (
      <Screen>
        <ErrorCard message={error} onRetry={load} />
      </Screen>
    );
  }

  return (
    <Screen scroll>
      {saveError ? <Text style={styles.error}>{saveError}</Text> : null}
      {GROUPS.map((group) => (
        <View key={group.key}>
          <SectionTitle title={capitalize(group.key)} icon="notifications-outline" />
          <Card flat style={{ paddingHorizontal: Spacing.lg }}>
            {group.events.map((event, i) => {
              const value = prefs?.push?.[event] ?? false;
              return (
                <View key={event} style={i > 0 ? styles.toggleBorder : undefined}>
                  <ToggleRow
                    label={eventLabel(event)}
                    sub={group.locked ? t('prefs.locked') : undefined}
                    value={group.locked ? true : value}
                    onChange={(v) => {
                      if (!group.locked) onToggle(event, v);
                    }}
                  />
                </View>
              );
            })}
          </Card>
        </View>
      ))}
      {error && prefs ? <ErrorCard message={error} onRetry={load} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', paddingVertical: 80 },
  toggleBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border },
  error: { color: Colors.danger, fontSize: FontSize.sm, marginBottom: Spacing.md },
});
