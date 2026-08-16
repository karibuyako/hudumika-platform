import { color } from '@hudumika/tokens';
import type { TextStyle } from 'react-native';

export const Brand = {
  primary: color.brand500,
  primaryDark: color.brand600,
  primaryDeep: color.brand700,
  primarySoft: color.brand50,
  ink: color.ink900,
} as const;

export const Colors = {
  primary: Brand.primary,
  primaryDark: Brand.primaryDark,
  primaryDeep: Brand.primaryDeep,
  primarySoft: Brand.primarySoft,
  ink: Brand.ink,

  bg: color.bg,
  card: color.surface,
  surface: color.paper,
  surfacePress: color.brand50,

  text: color.ink900,
  textSecondary: color.ink500,
  textTertiary: color.ink300,
  textFaint: '#c9cdca',

  border: color.line,
  borderStrong: color.lineStrong,

  success: color.success,
  successSoft: color.successSoft,
  danger: color.danger,
  dangerSoft: color.dangerSoft,
  warning: color.warning,
  warningSoft: color.warningSoft,
  info: color.info,
  infoSoft: color.infoSoft,

  tabActive: color.ink900,
  tabInactive: color.ink300,
  white: color.white,
  overlay: color.overlay,
  black: color.ink900,
  gold: color.accent,
  goldSoft: color.accentSoft,
} as const;

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
} as const;

export const Radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  pill: 999,
} as const;

export const FontSize = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 22,
  xxl: 30,
} as const;

export const FontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
  extrabold: '800',
} as const;

/** Loaded via useFonts in app/_layout.tsx — Plus Jakarta Sans for UI, Space Grotesk for display/earnings. */
export const Fonts = {
  sans: 'PlusJakartaSans_400Regular',
  sansMedium: 'PlusJakartaSans_500Medium',
  sansSemibold: 'PlusJakartaSans_600SemiBold',
  sansBold: 'PlusJakartaSans_700Bold',
  sansExtraBold: 'PlusJakartaSans_800ExtraBold',
  display: 'SpaceGrotesk_400Regular',
  displayMedium: 'SpaceGrotesk_500Medium',
  displaySemibold: 'SpaceGrotesk_600SemiBold',
  displayBold: 'SpaceGrotesk_700Bold',
} as const;

export const shadow = {
  card: {
    shadowColor: color.ink900,
    shadowOpacity: 0.045,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 3 },
    elevation: 1.5,
  },
  pop: {
    shadowColor: color.ink900,
    shadowOpacity: 0.12,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
} as const;

export const HeaderStyle = {
  headerShown: true,
  headerStyle: { backgroundColor: Colors.card },
  headerShadowVisible: false,
  headerTintColor: Colors.text,
  headerTitleStyle: {
    fontSize: FontSize.lg,
    fontWeight: '700' as const,
    fontFamily: Fonts.sansBold,
    color: Colors.text,
  },
  headerBackButtonDisplayMode: 'minimal' as const,
  contentStyle: { backgroundColor: Colors.bg },
};

export const NumberStyle = {
  fontVariant: ['tabular-nums'] as TextStyle['fontVariant'],
};
