/**
 * Hudumika design tokens.
 * Source of truth: build-meituan-inspired-website (18).zip + its src/index.css @theme block.
 * Design-system naming rules live in DESIGN-SYSTEM.md (synced from the zip by a separate agent).
 */

/** Raw brand palette — mirrors the @theme block in the reference src/index.css. */
export const palette = {
  paper: '#fbf8f3',
  surface: '#ffffff',
  line: '#e8e6e0',
  lineStrong: '#d9d7d1',
  ink900: '#101412',
  ink700: '#2b332f',
  ink500: '#5c6560',
  ink300: '#8a9490',
  ink100: '#c9cdca',
  brand500: '#1a5c44',
  brand600: '#134332',
  brand700: '#0f2e22',
  brand50: '#eef4f0',
  accent: '#c9a84e',
  accentSoft: '#f4ecd2',
  danger: '#b42318',
  dangerSoft: '#fef3f2',
} as const;

/** Semantic color map — raw palette plus roles (status tones, overlay, surfaces). */
export const color = {
  ...palette,

  bg: palette.paper,
  surfaceHover: '#ffffff',

  success: '#059669',
  successSoft: '#ecfdf5',
  warning: '#d97706',
  warningSoft: '#fef3c7',
  info: '#2563eb',
  infoSoft: '#eff6ff',

  overlay: 'rgba(16, 20, 18, 0.4)',
  white: '#ffffff',
  black: '#101412',
} as const;

/** Typography — Plus Jakarta Sans for UI, Space Grotesk for display; 11–56px scale. */
export const typography = {
  fontFamily: {
    sans: 'Plus Jakarta Sans',
    display: 'Space Grotesk',
  },

  fontSize: {
    caption: 11,
    micro: 12,
    label: 12,
    body: 14,
    bodyLg: 15,
    h3: 20,
    h2: 24,
    h2Lg: 30,
    h1: 38,
    h1Md: 48,
    h1Lg: 56,
    display: 38,
    displayMd: 48,
    displayLg: 56,
    eyebrow: 12,
  },

  weight: {
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
    extrabold: 800,
  },

  /** Eyebrow/section kicker: 12px uppercase with wide tracking. */
  eyebrow: {
    size: 12,
    case: 'uppercase',
    tracking: 0.16,
    weight: 700,
  },
} as const;

/** Spacing — 4px base scale. */
export const spacing = {
  '4': 4,
  '8': 8,
  '12': 12,
  '16': 16,
  '20': 20,
  '24': 24,
  '32': 32,
  '40': 40,

  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  '2xl': 32,
  '3xl': 40,
} as const;

/** Corner radii — pill for buttons/chips/avatars, 16px cards, 20–24px panels. */
export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  pill: 999,
} as const;

/** Shadows — ink-based (ink-900 #101412) rgba values, no colored glow. */
export const shadows = {
  sm: '0 1px 2px rgba(16, 20, 18, 0.05)',
  lg: '0 10px 15px -3px rgba(16, 20, 18, 0.1), 0 4px 6px -4px rgba(16, 20, 18, 0.05)',
  xl: '0 20px 25px -5px rgba(16, 20, 18, 0.1), 0 8px 10px -6px rgba(16, 20, 18, 0.05)',
} as const;

/** Motion — easeOutQuint curve, press feedback at 0.98. */
export const motion = {
  duration: {
    fast: 150,
    base: 200,
    slow: 300,
    slower: 400,
  },
  ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
  pressScale: 0.98,
} as const;

/** Layout — page container. */
export const container = {
  maxWidth: 1280,
} as const;
