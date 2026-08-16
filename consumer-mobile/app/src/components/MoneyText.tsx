/* Money display — formatTZS only, integer TZS, signed rows render the sign. */
import { Text } from 'react-native';

import { Colors, Fonts, FontSize, NumberStyle } from '@/constants/theme';
import { formatTZS } from '@/i18n';

export function MoneyText({ amountTZS, size = FontSize.md, bold = false, signed = false }: {
  amountTZS: number;
  size?: number;
  bold?: boolean;
  signed?: boolean;
}) {
  const text = signed && amountTZS !== 0
    ? `${amountTZS < 0 ? '−' : '+'}${formatTZS(Math.abs(amountTZS)).replace('TZS ', 'TZS ')}`
    : formatTZS(amountTZS);
  return (
    <Text
      accessibilityLabel={`TZS ${Math.round(amountTZS)}`}
      style={{ color: Colors.text, fontSize: size, fontFamily: bold ? Fonts.displayBold : Fonts.displayMedium, fontVariant: NumberStyle.fontVariant }}>
      {text}
    </Text>
  );
}
