import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Card, Icon, Row, Screen } from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { getWalletRepository } from '@/repos';
import { useSessionStore } from '@/store/session';
import type { Wallet } from '@hudumika/contract';

export default function PayCodeScreen() {
  const user = useSessionStore((s) => s.user);
  const [wallet, setWallet] = useState<Wallet | null>(null);

  const load = useCallback(async () => {
    try {
      const w = await getWalletRepository().getWallet();
      setWallet(w);
    } catch {
      // silent — pay code degrades to user ID only
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const userId = user?.id ?? '—';

  return (
    <Screen>
      <View style={{ padding: Spacing.lg, gap: Spacing.lg }}>
        <Text style={styles.title}>{t('wallet.payCode')}</Text>
        <Card style={styles.card}>
          <View style={styles.qrWrap}>
            <View style={styles.qrBox}>
              <Icon name="qr-code" size={120} color={Colors.text} />
            </View>
            <Text style={styles.userId} selectable>
              {userId}
            </Text>
            {wallet ? (
              <Row gap={Spacing.xs} style={{ marginTop: Spacing.xs }}>
                <Text style={styles.balanceLabel}>{t('wallet.balance')}</Text>
                <Text style={styles.balanceValue}>{wallet.totalTZS ?? 0} TZS</Text>
              </Row>
            ) : null}
            <Text style={styles.hint}>{t('wallet.payCodeHint')}</Text>
          </View>
        </Card>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text },
  card: { padding: Spacing.xl, alignItems: 'center', borderRadius: Radius.lg },
  qrWrap: { alignItems: 'center', gap: Spacing.md },
  qrBox: {
    width: 160,
    height: 160,
    borderRadius: Radius.md,
    backgroundColor: Colors.card,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  userId: { fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, color: Colors.textSecondary, textAlign: 'center' },
  balanceLabel: { fontSize: FontSize.xs, fontFamily: Fonts.sans, color: Colors.textTertiary },
  balanceValue: { fontSize: FontSize.xs, fontFamily: Fonts.sansBold, color: Colors.text },
  hint: { fontSize: FontSize.sm, fontFamily: Fonts.sans, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.sm },
});
