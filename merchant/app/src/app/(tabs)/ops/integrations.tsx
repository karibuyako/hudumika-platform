import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Empty, Field, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import type { IconName } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';
import { fullTime } from '@/lib/format';
import type { IntegrationInfo } from '@/api/types';
import { useWebhooksStore } from '@/store/webhooks';
import { useMessageStore } from '@/store/messages';

const PROVIDER_ICON: Record<IntegrationInfo['provider'], IconName> = {
  pos: 'cash-outline',
  erp: 'business-outline',
  accounting: 'calculator-outline',
  payroll: 'people-outline',
  delivery_partner: 'bicycle-outline',
  mini_program: 'phone-portrait-outline',
};

const STATUS_PILL: Record<IntegrationInfo['status'], { label: string; tone: 'neutral' | 'danger' | 'success' | 'info' | 'warning' }> = {
  connected: { label: t('int.connected'), tone: 'success' },
  disconnected: { label: t('int.disconnected'), tone: 'neutral' },
  error: { label: t('int.error'), tone: 'danger' },
};

export default function IntegrationsScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const integrations = useWebhooksStore((s) => s.integrations);
  const error = useWebhooksStore((s) => s.error);
  const hydrate = useWebhooksStore((s) => s.hydrate);
  const disconnect = useWebhooksStore((s) => s.disconnect);
  const pushMessage = useMessageStore((s) => s.push);

  const [target, setTarget] = useState<IntegrationInfo | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    hydrate().catch(() => undefined);
  }, [hydrate]);

  const openDisconnect = (i: IntegrationInfo) => {
    setTarget(i);
    setReason('');
    setFormError('');
  };

  const confirmDisconnect = async () => {
    if (!target) return;
    if (!reason.trim()) {
      setFormError(t('int.reasonRequired'));
      return;
    }
    setBusy(true);
    setFormError('');
    const res = await disconnect(target.id, reason.trim());
    setBusy(false);
    if (res.ok) {
      setTarget(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({ type: 'system', title: t('int.disconnectedOk'), body: target.label });
    } else {
      setFormError(res.message ?? t('int.errDisconnect'));
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('int.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: Spacing.md }}>{t('int.sub')}</Text>

        {error ? (
          <View style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.lg }}>
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('int.errLoad')}</Text>
            <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => hydrate()} />
          </View>
        ) : null}

        <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
          {integrations.length === 0 ? <Empty icon="git-merge-outline" title={t('int.empty')} sub={t('int.emptySub')} /> : null}
          {integrations.map((i) => (
            <Card key={i.id} style={{ gap: Spacing.sm }}>
              {i.status === 'error' ? (
                <View style={styles.errorBanner}>
                  <Icon name="warning-outline" size={15} color={Colors.danger} />
                  <Text style={styles.errorBannerText}>{t('int.syncError')}</Text>
                </View>
              ) : null}
              <Row style={{ justifyContent: 'space-between' }}>
                <Row gap={10} style={{ flex: 1 }}>
                  <View style={styles.iconBox}>
                    <Icon name={PROVIDER_ICON[i.provider]} size={18} color={Colors.info} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.name} numberOfLines={1}>{i.label}</Text>
                    <Text style={styles.meta}>
                      {i.provider} · {t('int.scopes', { n: i.scopes.length })}
                    </Text>
                    <Text style={styles.meta}>
                      {i.lastSyncedAt ? t('int.synced', { time: fullTime(i.lastSyncedAt) }) : t('int.never')}
                    </Text>
                  </View>
                </Row>
                <Pill label={STATUS_PILL[i.status].label} tone={STATUS_PILL[i.status].tone} />
              </Row>
              {i.status !== 'disconnected' ? (
                <Btn
                  label={t('int.disconnect')}
                  variant="danger"
                  size="sm"
                  style={{ alignSelf: 'flex-start' }}
                  onPress={() => openDisconnect(i)}
                />
              ) : null}
            </Card>
          ))}
        </View>
      </Screen>

      <SheetModal visible={target !== null} onClose={() => setTarget(null)} title={t('int.disconnectTitle', { name: target?.label ?? '' })}>
        <View style={{ gap: Spacing.md }}>
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 19 }}>
            {t('int.disconnectBody', { name: target?.label ?? '' })}
          </Text>
          <Field label={t('int.reason')} value={reason} onChangeText={setReason} placeholder={t('int.reasonPh')} maxLength={500} />
          {formError ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{formError}</Text> : null}
          <Row gap={Spacing.sm}>
            <Btn label={t('common.cancel')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => setTarget(null)} />
            <Btn label={t('int.disconnect')} variant="danger" size="sm" style={{ flex: 1 }} loading={busy} onPress={confirmDisconnect} />
          </Row>
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
  iconBox: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: Colors.infoSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flexShrink: 1 },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.dangerSoft,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
  },
  errorBannerText: { fontSize: FontSize.xs, color: Colors.danger, fontWeight: '700' },
});
