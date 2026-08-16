/* Voucher wallet — GET /vouchers/me (GROUP-BUY.md VoucherCard). The code
 * (GB-XXXX-XXXX) IS the QR payload the merchant scans — verification is
 * merchant-side (POST /vouchers/{code}/verify), the app never calls it. */
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Platform, StyleSheet, Text, View } from 'react-native';

import { Btn, Card, EmptyState, ErrorState, Icon, Row, Screen, SkeletonCard, StatusPill } from '@/components/ui';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { getMerchantsRepository, getVouchersRepository } from '@/repos';
import { formatTZS } from '@/lib/format';
import { dateISO } from '@/lib/dates';
import { voucherExpiresWithin } from '@/lib/notifications';
import { cancelExistingReminder, scheduleVoucherExpiryReminder } from '@/lib/push';
import { ApiError } from '@/api/client';
import type { MerchantPublic, Voucher } from '@hudumika/contract';

/** Honest in-app stand-in for the client-scheduled expiry reminder
 * (NOTIFICATIONS.md): the 48 h push requires expo-notifications, so unused
 * vouchers expiring within 72 h show the amber hint instead. */
const EXPIRING_SOON_MS = 72 * 3600_000;

export default function VouchersScreen() {
  const router = useRouter();
  const [vouchers, setVouchers] = useState<Voucher[] | null>(null);
  const [merchants, setMerchants] = useState<MerchantPublic[]>([]);
  const [error, setError] = useState('');
  const [refundPending, setRefundPending] = useState(false);
  const [showCodeFor, setShowCodeFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError('');
    setRefundPending(false);
    try {
      const [mine, all] = await Promise.all([getVouchersRepository().list(), getMerchantsRepository().list()]);
      setVouchers(mine);
      if (all.length) setMerchants(all);
      if (Platform.OS !== 'web') {
        // Client-scheduled expiry reminders (NOTIFICATIONS.md): unused
        // vouchers get a local notification ~48 h before expiresAt (the
        // in-app 72 h hint below is untouched); anything no longer unused
        // clears its stale reminder. Both are native-only no-ops otherwise.
        for (const v of mine) {
          if (v.status === 'unused') void scheduleVoucherExpiryReminder(v);
          else void cancelExistingReminder(v.code);
        }
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VOUCHER_REFUND_PENDING') {
        // A refund is in flight for the wallet — keep showing the vouchers.
        setRefundPending(true);
        setVouchers(await getVouchersRepository().list());
      } else {
        setError(t('common.error'));
      }
    }
  }, []);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const merchantName = (id?: string | null) => {
    if (!id) return '';
    return merchants.find((m) => m.id === id)?.businessName ?? id;
  };

  return (
    <Screen>
      <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg }}>
        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <Text style={styles.title}>{t('vouchers.title')}</Text>
          <View style={{ width: 40 }} />
        </Row>
        {refundPending ? (
          <Card style={[styles.bannerCard, { backgroundColor: Colors.infoSoft }]}>
            <Row gap={Spacing.md}>
              <Icon name="sync-circle-outline" size={18} color={Colors.info} />
              <Text style={[styles.meta, { color: Colors.info, flex: 1, fontFamily: Fonts.sansSemibold }]}>{t('vouchers.refundPending')}</Text>
            </Row>
          </Card>
        ) : null}
      </View>
      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !vouchers ? (
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={2} />
        </View>
      ) : vouchers.length === 0 ? (
        <EmptyState icon="qr-code-outline" title={t('vouchers.empty')} sub={t('vouchers.emptyHint')} />
      ) : (
        <FlatList
          data={vouchers}
          keyExtractor={(v) => v.code}
          onRefresh={load}
          refreshing={false}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }}
          renderItem={({ item }) => {
            const expanded = showCodeFor === item.code;
            const unused = item.status === 'unused';
            const expiringSoon = unused && item.expiresAt ? voucherExpiresWithin(item, EXPIRING_SOON_MS) : false;
            return (
              <Card style={[styles.card, { opacity: item.status === 'expired' ? 0.55 : 1 }]} flat>
                <Row gap={Spacing.md}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.code}>{item.code}</Text>
                    <Text style={styles.meta} numberOfLines={1}>{item.title}</Text>
                    <Text style={styles.meta}>{formatTZS(item.priceTZS ?? 0)}</Text>
                    {item.expiresAt ? <Text style={styles.meta}>{t('coupons.validUntil', { t: dateISO(item.expiresAt) })}</Text> : null}
                    {expiringSoon ? (
                      <Text style={[styles.meta, { color: Colors.warning, fontFamily: Fonts.sansSemibold }]}>
                        {t('vouchers.expiringSoon', { t: dateISO(item.expiresAt) })}
                      </Text>
                    ) : null}
                    {item.status === 'redeemed' ? (
                      <Text style={styles.meta}>
                        {item.redeemedByMerchantId
                          ? t('vouchers.redeemedBy', { t: dateISO(item.redeemedAt), merchant: merchantName(item.redeemedByMerchantId) })
                          : t('vouchers.redeemedAt', { t: dateISO(item.redeemedAt) })}
                      </Text>
                    ) : null}
                    <Row gap={Spacing.sm} style={{ marginTop: Spacing.sm }}>
                      <StatusPill status={item.status} />
                    </Row>
                    {item.status === 'void' ? (
                      <Btn label={t('vouchers.supportCta')} variant="outline" size="sm" onPress={() => router.push('/support')} style={{ marginTop: Spacing.sm, alignSelf: 'flex-start' }} />
                    ) : null}
                  </View>
                  {unused ? (
                    <Btn label={t('vouchers.use')} size="sm" onPress={() => setShowCodeFor(expanded ? null : item.code)} />
                  ) : null}
                </Row>
                {unused && expanded ? (
                  <View style={styles.codePanel}>
                    <Icon name="qr-code" size={40} color={Colors.primaryDeep} />
                    <Text style={styles.bigCode}>{item.code}</Text>
                    <Text style={[styles.meta, { color: Colors.textSecondary, textAlign: 'center' }]}>{t('vouchers.showCode')}</Text>
                    <Text style={[styles.meta, { textAlign: 'center' }]}>{t('vouchers.redeemHint')}</Text>
                  </View>
                ) : null}
              </Card>
            );
          }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text, flex: 1, textAlign: 'center' },
  card: {
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: Colors.primary,
    gap: Spacing.md,
  },
  bannerCard: { marginBottom: Spacing.lg },
  code: { fontSize: FontSize.md, fontFamily: Fonts.sansExtraBold, color: Colors.text, letterSpacing: 0.8, fontVariant: ['tabular-nums'] },
  bigCode: { fontSize: FontSize.xl, fontFamily: Fonts.sansExtraBold, color: Colors.text, letterSpacing: 1.5, fontVariant: ['tabular-nums'] },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  codePanel: { alignItems: 'center', gap: Spacing.sm, borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: Spacing.md },
});
