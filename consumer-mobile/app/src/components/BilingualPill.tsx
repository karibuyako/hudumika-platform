/* Bilingual microcopy pill — trust pills/footnotes only (never buttons/dialogs). */
import { Text, View } from 'react-native';

import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';

export function BilingualPill({ en, sw }: { en: string; sw: string }) {
  return (
    <View style={{ backgroundColor: Colors.primarySoft, borderRadius: Radius.pill, paddingHorizontal: Spacing.sm, paddingVertical: 3, alignSelf: 'flex-start' }}>
      <Text style={{ color: Colors.primaryDeep, fontSize: FontSize.xs, fontFamily: Fonts.sansMedium }}>{en} · {sw}</Text>
    </View>
  );
}
