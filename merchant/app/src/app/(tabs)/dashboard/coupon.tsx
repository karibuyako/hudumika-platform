import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { api } from '@/api/client';
import type { GroupBuyVoucher, Staff, VerifyHistoryEntry } from '@/api/types';
import { Btn, Card, Empty, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { fullTime, tzs } from '@/lib/format';
import { useGroupBuyStore } from '@/store/group-buy';

const RESULT_META: Record<VerifyHistoryEntry['result'], { label: I18nKey; tone: 'success' | 'danger' | 'neutral' | 'info' }> = {
  redeemed: { label: 'vch.resultRedeemed', tone: 'success' },
  already_used: { label: 'vch.resultAlreadyUsed', tone: 'danger' },
  expired: { label: 'vch.resultExpired', tone: 'neutral' },
  invalid: { label: 'vch.resultInvalid', tone: 'danger' },
};

type Outcome =
  | { ok: true; voucher: GroupBuyVoucher; entered: string }
  | { ok: false; code?: string; entered: string };

export default function CouponScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const history = useGroupBuyStore((s) => s.history);
  const verifyVoucher = useGroupBuyStore((s) => s.verifyVoucher);
  const hydrateVerifyHistory = useGroupBuyStore((s) => s.hydrateVerifyHistory);
  const [code, setCode] = useState('');
  const [permission, requestPermission] = useCameraPermissions();
  const [camOn, setCamOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Outcome | null>(null);
  const [histFailed, setHistFailed] = useState(false);
  const [histAttempt, setHistAttempt] = useState(0);
  const [staffNames, setStaffNames] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ staff: Staff[] }>('/staff', { retries: 1 })
      .then((r) => {
        if (!cancelled) setStaffNames(Object.fromEntries(r.staff.map((s) => [s.id, s.name])));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const loadHistory = useCallback(() => {
    let cancelled = false;
    setHistFailed(false);
    hydrateVerifyHistory().then(() => {
      if (!cancelled) setHistFailed(useGroupBuyStore.getState().history.length === 0);
    });
    return () => {
      cancelled = true;
    };
  }, [hydrateVerifyHistory]);

  useEffect(loadHistory, [loadHistory, histAttempt]);

  const doVerify = async (raw: string) => {
    if (!raw.trim() || busy) return;
    setBusy(true);
    const res = await verifyVoucher(raw);
    setBusy(false);
    Haptics.notificationAsync(
      res.ok ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error,
    );
    setResult(
      res.ok && res.voucher
        ? { ok: true, voucher: res.voucher, entered: res.voucher.code }
        : { ok: false, code: res.code, entered: raw.trim().toUpperCase() },
    );
  };

  const tryCamera = async () => {
    if (!permission?.granted) {
      const r = await requestPermission();
      if (!r.granted) return;
    }
    setCamOn(true);
  };

  const failBanner = (o: Extract<Outcome, { ok: false }>): string => {
    if (o.code === 'VOUCHER_ALREADY_USED') return t('vch.alreadyUsed');
    if (o.code === 'VOUCHER_EXPIRED') return t('vch.expired');
    if (o.code === 'VOUCHER_NOT_FOUND') return t('vch.notFound');
    if (o.code === 'VOUCHER_INVALID_CODE') return t('vch.invalidCode');
    if (o.code === 'VOUCHER_NOT_REDEEMABLE_AT_MERCHANT') return t('vch.notRedeemable');
    if (o.code === 'VOUCHER_REFUND_PENDING') return t('vch.refundPending');
    return t('vch.failed');
  };

  return (
    <Screen>
      <View style={{ padding: Spacing.lg, gap: Spacing.md, flex: 1 }}>
        <View style={styles.demoHint}>
          <Text style={styles.demoText}>{t('vch.demoHint')}</Text>
        </View>

        <Card style={{ gap: Spacing.lg }}>
          <View style={{ gap: Spacing.xs }}>
            <Text style={styles.label}>{t('vch.enter')}</Text>
            <Row gap={Spacing.sm}>
              <TextInput
                value={code}
                onChangeText={setCode}
                placeholder={t('vch.codePh')}
                placeholderTextColor={Colors.textTertiary}
                autoCapitalize="characters"
                style={styles.input}
              />
              <Btn label={t('vch.verify')} onPress={() => doVerify(code)} variant="dark" style={{ paddingHorizontal: 22 }} />
            </Row>
          </View>
          <View style={styles.divider} />
          <Btn
            label={camOn ? t('vch.scanning') : t('vch.scanQr')}
            icon="scan-outline"
            variant="primary"
            size="lg"
            onPress={tryCamera}
          />
        </Card>

        {camOn && Platform.OS !== 'web' && permission?.granted ? (
          <View style={{ borderRadius: Radius.lg, overflow: 'hidden', height: 280 }}>
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              onBarcodeScanned={({ data }) => {
                if (data) {
                  setCamOn(false);
                  doVerify(data);
                }
              }}
            />
          </View>
        ) : null}

        <Text style={styles.sectionTitle}>{t('vch.history')}</Text>
        <View style={{ flex: 1 }}>
          {histFailed ? (
            <Card style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.xl }}>
              <Icon name="cloud-offline-outline" size={22} color={Colors.textTertiary} />
              <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('vch.errHistory')}</Text>
              <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => setHistAttempt((n) => n + 1)} />
            </Card>
          ) : history.length === 0 ? (
            <Empty icon="ticket-outline" title={t('vch.historyEmpty')} />
          ) : (
            <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
              {history.map((h) => {
                const meta = RESULT_META[h.result];
                return (
                  <Card key={`${h.voucherCode}-${h.verifiedAt}`} style={{ marginBottom: Spacing.sm, paddingVertical: 14 }}>
                    <Row style={{ justifyContent: 'space-between' }}>
                      <View style={{ flex: 1, paddingRight: Spacing.md }}>
                        <Text style={styles.histCode}>{h.voucherCode}</Text>
                        <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 }}>
                          {fullTime(h.verifiedAt)} · {t('vch.by', { staff: staffNames[h.verifiedBy] ?? h.verifiedBy })}
                        </Text>
                      </View>
                      <Pill label={t(meta.label)} tone={meta.tone} />
                    </Row>
                  </Card>
                );
              })}
            </ScrollView>
          )}
        </View>
      </View>

      <SheetModal visible={result !== null} onClose={() => setResult(null)} title={result?.ok ? t('vch.verified') : t('vch.failed')}>
        {result?.ok ? (
          <View style={{ alignItems: 'center', gap: Spacing.sm }}>
            <Icon name="checkmark-circle" size={52} color={Colors.success} />
            <Pill label={t('vch.statusRedeemed')} tone="success" />
            <View style={{ alignSelf: 'stretch', gap: Spacing.sm, marginTop: Spacing.xs }}>
              <ResultRow label={t('vch.codeTitle')} value={result.entered} />
              <ResultRow label={t('vch.boughtFor', { amount: tzs(result.voucher.priceTZS) })} />
              <ResultRow label={t('vch.expiresAt', { end: fullTime(result.voucher.expiresAt) })} />
              {result.voucher.redeemedAt ? <ResultRow label={t('vch.redeemedAt', { when: fullTime(result.voucher.redeemedAt) })} /> : null}
            </View>
            <Btn label={t('vch.done')} onPress={() => setResult(null)} size="lg" style={{ alignSelf: 'stretch', marginTop: Spacing.sm }} />
          </View>
        ) : result ? (
          <View style={{ alignItems: 'center', gap: Spacing.md }}>
            <Icon name="close-circle" size={52} color={Colors.danger} />
            <Text style={{ fontSize: FontSize.lg, fontWeight: '700', color: Colors.text, textAlign: 'center' }}>
              {failBanner(result)}
            </Text>
            <Row gap={Spacing.md}>
              <Btn label={t('vch.scanAgain')} variant="outline" onPress={() => { setResult(null); tryCamera(); }} />
              <Btn label={t('vch.done')} variant="dark" onPress={() => setResult(null)} />
            </Row>
          </View>
        ) : null}
      </SheetModal>
    </Screen>
  );
}

function ResultRow({ label, value }: { label: string; value?: string }) {
  return (
    <Row style={{ justifyContent: 'space-between', paddingVertical: 10 }}>
      <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary, flex: 1, paddingRight: Spacing.md }}>{label}</Text>
      {value ? <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text, textAlign: 'right' }}>{value}</Text> : null}
    </Row>
  );
}

const styles = StyleSheet.create({
  demoHint: {
    backgroundColor: Colors.infoSoft,
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
  },
  demoText: { fontSize: FontSize.xs, color: Colors.info, fontWeight: '600' },
  label: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    fontSize: FontSize.md,
    color: Colors.text,
    backgroundColor: Colors.card,
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, marginTop: Spacing.sm },
  histCode: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, letterSpacing: 1 },
});
