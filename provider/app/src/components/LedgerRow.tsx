import { StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/ui';
import { Colors, FontSize, NumberStyle, Spacing } from '@/constants/theme';
import { formatTZS, t } from '@/i18n';
import type { I18nKey } from '@/i18n';
import { dateISO } from '@/lib/format';
import type { LedgerEntry, LedgerEntryType } from '@hudumika/contract';

const LEDGER_META: Record<LedgerEntryType, { labelKey: I18nKey; icon: 'briefcase' | 'swap-horizontal' | 'arrow-up-circle' | 'gift' | 'wallet' | 'sparkles' | 'trending-down' }> = {
  order_earning: { labelKey: 'earnings.booking_earning', icon: 'briefcase' },
  booking_earning: { labelKey: 'earnings.booking_earning', icon: 'briefcase' },
  delivery_fee: { labelKey: 'earnings.booking_earning', icon: 'briefcase' },
  commission: { labelKey: 'earnings.commission', icon: 'trending-down' },
  adjustment: { labelKey: 'earnings.adjustment', icon: 'swap-horizontal' },
  payout: { labelKey: 'earnings.payout', icon: 'arrow-up-circle' },
  refund: { labelKey: 'earnings.refund', icon: 'swap-horizontal' },
  bonus: { labelKey: 'earnings.bonus', icon: 'gift' },
  tip: { labelKey: 'earnings.bonus', icon: 'sparkles' },
};

/** Immutable ledger row with running balance. */
export function LedgerRow({ entry }: { entry: LedgerEntry }) {
  const meta = LEDGER_META[entry.type] ?? { labelKey: 'earnings.adjustment' as const, icon: 'swap-horizontal' as const };
  const positive = entry.amountTZS >= 0;
  return (
    <View style={styles.row}>
      <View style={styles.iconBox}>
        <Icon name={meta.icon} size={15} color={positive ? Colors.success : Colors.textTertiary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.title}>{t(meta.labelKey)}</Text>
        <Text style={styles.meta}>{dateISO(entry.createdAt)}</Text>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[styles.amount, { color: positive ? Colors.success : Colors.textSecondary }, { fontVariant: NumberStyle.fontVariant }]}>
          {positive ? '+' : ''}{formatTZS(entry.amountTZS)}
        </Text>
        <Text style={[styles.balance, { fontVariant: NumberStyle.fontVariant }]}>{formatTZS(entry.balanceTZS)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, padding: Spacing.lg },
  iconBox: {
    width: 30,
    height: 30,
    borderRadius: 9,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: FontSize.sm, color: Colors.text, fontFamily: 'PlusJakartaSans_600SemiBold' },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 },
  amount: { fontSize: FontSize.sm, fontFamily: 'PlusJakartaSans_800ExtraBold' },
  balance: { fontSize: FontSize.xs, color: Colors.textFaint, marginTop: 1 },
});
