import type { TextStyle } from 'react-native';
import { color as tokens } from '@hudumika/tokens';

export const Brand = {
  primary: tokens.brand500, // #1a5c44
  primaryDark: tokens.brand600, // #134332
  primaryDeep: tokens.brand700, // #0f2e22
  primarySoft: tokens.brand50, // #eef4f0
  ink: tokens.ink900, // #101412
} as const;

export const Colors = {
  primary: Brand.primary,
  primaryDark: Brand.primaryDark,
  primaryDeep: Brand.primaryDeep,
  primarySoft: Brand.primarySoft,
  ink: Brand.ink,

  bg: tokens.bg, // paper #fbf8f3
  card: tokens.surface, // #ffffff
  surface: '#f5f4f0', // light gray aligned to paper (tracks, icon wells)
  surfacePress: tokens.brand50, // #eef4f0

  text: Brand.ink,
  textSecondary: tokens.ink500, // #5c6560
  textTertiary: tokens.ink300, // #8a9490
  textFaint: '#c9cdca',
  ink700: tokens.ink700, // #2b332f — deep gray-green (banner cycles, kitchen dark)

  border: tokens.line, // #e8e6e0
  borderStrong: tokens.lineStrong, // #d9d7d1

  success: tokens.success, // #059669
  successSoft: tokens.successSoft, // #ecfdf5
  danger: tokens.danger, // #b42318
  dangerSoft: tokens.dangerSoft, // #fef3f2
  warning: tokens.warning, // #d97706
  warningSoft: tokens.warningSoft, // #fef3c7
  info: tokens.info, // #2563eb
  infoSoft: tokens.infoSoft, // #eff6ff

  tabActive: tokens.ink900, // #101412
  tabInactive: tokens.ink300, // #8a9490
  white: tokens.white,
  overlay: tokens.overlay, // rgba(16, 20, 18, 0.4)
  black: tokens.black, // #101412
  gold: tokens.accent, // #c9a84e — muted gold, max 5% of UI
  goldSoft: tokens.accentSoft, // #f4ecd2

  /* Decorative icon tints (feature/campaign accents) — no semantic meaning. */
  violet: '#7b61ff',
  rose: '#e2708a',
} as const;

export const fonts = {
  body400: 'PlusJakartaSans_400Regular',
  body500: 'PlusJakartaSans_500Medium',
  body600: 'PlusJakartaSans_600SemiBold',
  body700: 'PlusJakartaSans_700Bold',
  body800: 'PlusJakartaSans_800ExtraBold',
  display500: 'SpaceGrotesk_500Medium',
  display700: 'SpaceGrotesk_700Bold',
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

export const shadow = {
  card: {
    shadowColor: tokens.ink900, // #101412
    shadowOpacity: 0.045,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 3 },
    elevation: 1.5,
  },
  pop: {
    shadowColor: tokens.ink900,
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
    fontFamily: fonts.body700,
    color: Colors.text,
  },
  headerBackButtonDisplayMode: 'minimal' as const,
  contentStyle: { backgroundColor: Colors.bg },
};

export const NumberStyle = {
  fontVariant: ['tabular-nums'] as TextStyle['fontVariant'],
};
