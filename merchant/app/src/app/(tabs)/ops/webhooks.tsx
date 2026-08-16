import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Chip, Empty, Field, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';
import { fullTime } from '@/lib/format';
import type { WebhookDelivery, WebhookSubscription } from '@/api/types';
import { useWebhooksStore } from '@/store/webhooks';
import { useMessageStore } from '@/store/messages';

const EVENTS = [
  'order.created',
  'order.updated',
  'payment.captured',
  'notification.created',
  'chat.message',
  'campaign.updated',
  'ledger.updated',
  'settlement.created',
  'merchant.updated',
  'task.updated',
] as const;

const STATUS_PILL: Record<WebhookSubscription['status'], { label: string; tone: 'neutral' | 'danger' | 'success' | 'info' | 'warning' }> = {
  active: { label: t('wh.statusActive'), tone: 'success' },
  disabled: { label: t('wh.statusDisabled'), tone: 'neutral' },
  failing: { label: t('wh.statusFailing'), tone: 'danger' },
};

const DELIVERY_PILL: Record<WebhookDelivery['status'], { label: string; tone: 'neutral' | 'danger' | 'success' | 'info' | 'warning' }> = {
  success: { label: t('wh.delivered'), tone: 'success' },
  failed: { label: t('wh.failed'), tone: 'danger' },
  retrying: { label: t('wh.retrying'), tone: 'warning' },
};

export default function WebhooksScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const webhooks = useWebhooksStore((s) => s.webhooks);
  const deliveries = useWebhooksStore((s) => s.deliveries);
  const error = useWebhooksStore((s) => s.error);
  const hydrate = useWebhooksStore((s) => s.hydrate);
  const createWebhook = useWebhooksStore((s) => s.create);
  const updateWebhook = useWebhooksStore((s) => s.update);
  const removeWebhook = useWebhooksStore((s) => s.remove);
  const loadDeliveries = useWebhooksStore((s) => s.loadDeliveries);
  const pushMessage = useMessageStore((s) => s.push);

  const [sheet, setSheet] = useState<null | 'add' | 'edit' | 'delete' | 'deliveries'>(null);
  const [target, setTarget] = useState<WebhookSubscription | null>(null);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const [rotateSecret, setRotateSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    hydrate().catch(() => undefined);
  }, [hydrate]);

  const openAdd = () => {
    setTarget(null);
    setUrl('');
    setEvents([]);
    setRotateSecret(false);
    setFormError('');
    setSheet('add');
  };

  const openEdit = (w: WebhookSubscription) => {
    setTarget(w);
    setUrl(w.url);
    setEvents(w.events);
    setRotateSecret(false);
    setFormError('');
    setSheet('edit');
  };

  const toggleEvent = (e: string) => {
    setEvents((cur) => (cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e]));
  };

  const save = async () => {
    const trimmed = url.trim();
    if (!trimmed) {
      setFormError(t('wh.errSave'));
      return;
    }
    setBusy(true);
    setFormError('');
    const body = { url: trimmed, events, ...(rotateSecret ? { rotateSecret: true } : {}) };
    const res = target ? await updateWebhook(target.id, body) : await createWebhook(body);
    setBusy(false);
    if (res.ok) {
      setSheet(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({
        type: 'system',
        title: target ? t('wh.updated') : t('wh.created'),
        body: trimmed,
      });
    } else {
      setFormError(res.message ?? t('wh.errSave'));
    }
  };

  const remove = async () => {
    if (!target) return;
    setBusy(true);
    setFormError('');
    const res = await removeWebhook(target.id);
    setBusy(false);
    if (res.ok) {
      setSheet(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      setFormError(res.message ?? t('wh.errDelete'));
    }
  };

  const openDeliveries = async (w: WebhookSubscription) => {
    setTarget(w);
    setSheet('deliveries');
    await loadDeliveries(w.id);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('wh.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <Row style={{ justifyContent: 'space-between', marginTop: Spacing.md }}>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, flex: 1 }}>{t('wh.sub')}</Text>
          <Btn label={t('wh.add')} icon="add" size="sm" onPress={openAdd} />
        </Row>

        {error ? (
          <View style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.lg }}>
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('wh.errLoad')}</Text>
            <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => hydrate()} />
          </View>
        ) : null}

        <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
          {webhooks.length === 0 ? <Empty icon="link-outline" title={t('wh.empty')} sub={t('wh.emptySub')} /> : null}
          {webhooks.map((w) => (
            <Card key={w.id} style={{ gap: Spacing.sm }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={styles.name} numberOfLines={1}>{w.url}</Text>
                <Pill label={STATUS_PILL[w.status].label} tone={STATUS_PILL[w.status].tone} />
              </Row>
              <Text style={styles.meta}>{w.events.join(' · ')}</Text>
              <Text style={styles.meta}>
                {w.lastDeliveryAt ? t('wh.lastDelivery', { time: fullTime(w.lastDeliveryAt) }) : ''}
              </Text>
              <Row gap={Spacing.sm}>
                <Btn label={t('wh.viewDeliveries')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => openDeliveries(w)} />
                <Btn label={t('common.edit')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => openEdit(w)} />
                <Btn
                  label={t('common.delete')}
                  variant="danger"
                  size="sm"
                  style={{ flex: 1 }}
                  onPress={() => {
                    setTarget(w);
                    setFormError('');
                    setSheet('delete');
                  }}
                />
              </Row>
            </Card>
          ))}
        </View>
      </Screen>

      <SheetModal visible={sheet === 'add' || sheet === 'edit'} onClose={() => setSheet(null)} title={sheet === 'edit' ? t('wh.editTitle') : t('wh.addTitle')}>
        <View style={{ gap: Spacing.md }}>
          <Field label={t('wh.url')} value={url} onChangeText={setUrl} placeholder={t('wh.urlPh')} keyboardType="url" />
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('wh.events')}</Text>
            <Row gap={8} style={{ flexWrap: 'wrap' }}>
              {EVENTS.map((e) => (
                <Chip key={e} label={e} selected={events.includes(e)} onPress={() => toggleEvent(e)} />
              ))}
            </Row>
            <Text style={styles.hint}>{t('wh.eventsHint')}</Text>
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('wh.secretLabel')}</Text>
            <Text style={styles.hint}>{t('wh.secretNote')}</Text>
            {sheet === 'edit' ? (
              <Row gap={8}>
                <Chip
                  label={t('wh.rotateSecret')}
                  selected={rotateSecret}
                  onPress={() => setRotateSecret((v) => !v)}
                />
              </Row>
            ) : null}
          </View>
          {formError ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{formError}</Text> : null}
          <Btn label={t('common.save')} size="lg" loading={busy} disabled={!url.trim() || events.length === 0} onPress={save} />
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'delete'} onClose={() => setSheet(null)} title={t('wh.deleteTitle')}>
        <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 19 }}>
          {t('wh.deleteBody', { name: target?.url ?? '' })}
        </Text>
        {formError ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs, textAlign: 'center' }}>{formError}</Text> : null}
        <Row gap={Spacing.sm}>
          <Btn label={t('common.cancel')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => setSheet(null)} />
          <Btn label={t('common.delete')} variant="danger" size="sm" style={{ flex: 1 }} loading={busy} onPress={remove} />
        </Row>
      </SheetModal>

      <SheetModal visible={sheet === 'deliveries'} onClose={() => setSheet(null)} title={t('wh.deliveries')}>
        <View style={{ gap: Spacing.md }}>
          {deliveries.length === 0 ? <Empty icon="paper-plane-outline" title={t('wh.noDeliveries')} sub={t('wh.noDeliveriesSub')} /> : null}
          {deliveries.map((d) => (
            <Card key={d.id} flat style={{ gap: 4 }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={styles.deliveryEvent} numberOfLines={1}>{d.event}</Text>
                <Pill label={DELIVERY_PILL[d.status].label} tone={DELIVERY_PILL[d.status].tone} />
              </Row>
              <Text style={styles.meta}>
                {t('wh.attempts', { n: d.attempts })}
                {d.statusCode !== null ? ` · HTTP ${d.statusCode}` : ''}
              </Text>
              {d.status === 'retrying' && d.nextRetryAt ? (
                <Text style={styles.meta}>{t('wh.nextRetry', { time: fullTime(d.nextRetryAt) })}</Text>
              ) : null}
              {d.deliveredAt ? <Text style={styles.meta}>{t('wh.lastDelivery', { time: fullTime(d.deliveredAt) })}</Text> : null}
            </Card>
          ))}
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
  deliveryEvent: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text, flexShrink: 1 },
  fieldLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  hint: { fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 16 },
});
