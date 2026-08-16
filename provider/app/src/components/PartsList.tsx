import { StyleSheet, Text, View } from 'react-native';

import { Card, Icon, Row } from '@/components/ui';
import { Colors, FontSize, NumberStyle, Spacing } from '@/constants/theme';
import { formatTZS, t } from '@/i18n';
import type { PartsLine } from '@hudumika/contract';

/** Read-only parts list with running subtotal (client never computes totals). */
export function PartsList({ parts }: { parts: PartsLine[] }) {
  if (parts.length === 0) {
    return (
      <Card>
        <Text style={styles.empty}>{t('parts.empty')}</Text>
      </Card>
    );
  }
  return (
    <Card flat style={{ padding: 0 }}>
      {parts.map((p, i) => (
        <Row key={`${p.name}-${i}`} style={[styles.row, i > 0 && styles.rowBorder]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>{p.name}</Text>
            <Text style={styles.meta}>{p.quantity} × {formatTZS(p.unitCostTZS)}</Text>
          </View>
          <Icon name="checkmark-circle" size={14} color={Colors.success} />
        </Row>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { padding: Spacing.lg, justifyContent: 'space-between' },
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border },
  name: { fontSize: FontSize.sm, color: Colors.text, fontFamily: 'PlusJakartaSans_600SemiBold' },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontVariant: NumberStyle.fontVariant, marginTop: 2 },
  empty: { fontSize: FontSize.sm, color: Colors.textTertiary, textAlign: 'center' },
});
