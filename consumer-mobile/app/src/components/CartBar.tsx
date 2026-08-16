/* Persistent cart entry point (E2E nav finding) — a floating bar pinned to
 * the bottom of home/merchant screens. Appears only while the cart has
 * items (zustand selector subscription), navigates to /cart, and shows the
 * advisory subtotal via formatTZS (server is the price authority). Money is
 * integer TZS; no animation — reduced-motion safe. */
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon, Row } from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing, shadow } from '@/constants/theme';
import { t } from '@/i18n';
import { formatTZS } from '@/lib/format';
import { groupSubtotal, useCartStore } from '@/store/cart';

interface CartBarProps {
  /** Merchant screen context: show that group's subtotal when it exists,
   * else the cart total. Home keeps the total. */
  merchantId?: string;
}

export function CartBar({ merchantId }: CartBarProps) {
  const router = useRouter();
  const groups = useCartStore((s) => s.groups);

  if (groups.length === 0) return null;

  const itemCount = groups.reduce((acc, g) => acc + g.items.reduce((n, i) => n + i.quantity, 0), 0);
  const group = merchantId ? groups.find((g) => g.merchantId === merchantId) : undefined;
  const subtotal = group
    ? groupSubtotal(group)
    : groups.reduce((acc, g) => acc + groupSubtotal(g), 0);

  return (
    <Pressable
      onPress={() => router.push('/cart')}
      accessibilityRole="button"
      accessibilityLabel={t('cart.barLabel', { count: itemCount, subtotal: formatTZS(subtotal) })}
      style={({ pressed }) => [styles.bar, pressed && { opacity: 0.88 }]}>
      <Row gap={Spacing.md} style={{ alignItems: 'center' }}>
        <View style={styles.iconWrap}>
          <Icon name="cart" size={18} color={Colors.white} />
          {itemCount > 0 ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{itemCount > 99 ? '99+' : itemCount}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.label}>{t('cart.view')}</Text>
      </Row>
      <Text style={styles.subtotal}>{formatTZS(subtotal)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: Spacing.lg,
    right: Spacing.lg,
    bottom: Spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.primaryDeep,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    ...shadow.pop,
  },
  iconWrap: { position: 'relative' },
  badge: {
    position: 'absolute',
    top: -6,
    right: -10,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: Colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: { color: Colors.ink, fontSize: 9, fontFamily: Fonts.sansExtraBold, fontVariant: ['tabular-nums'] },
  label: { color: Colors.white, fontSize: FontSize.md, fontFamily: Fonts.sansBold },
  subtotal: { color: Colors.gold, fontSize: FontSize.sm, fontFamily: Fonts.sansBold, fontVariant: ['tabular-nums'] },
});
