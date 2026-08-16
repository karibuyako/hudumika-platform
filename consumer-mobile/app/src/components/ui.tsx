/* UI primitives — copied from rider-mobile/app/src/components/ui.tsx (the
 * sanctioned base, per consumer-mobile/INSTRUCTIONS.md §3.3) and extended with
 * the consumer primitives: EmptyState, ErrorState, StatusPill (order statuses),
 * MoneyText, Rating, BilingualPill, SkeletonCard, PriceBreakdown.
 */
import { Ionicons } from '@expo/vector-icons';
import React, { PropsWithChildren, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleProp,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TextInputProps,
  View,
  ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Colors, Fonts, FontSize, NumberStyle, Radius, shadow, Spacing } from '@/constants/theme';
import { formatTZS, t } from '@/i18n';

export type IconName = keyof typeof Ionicons.glyphMap;

export function Icon({ name, size = 20, color = Colors.text }: { name: IconName; size?: number; color?: string }) {
  return <Ionicons name={name} size={size} color={color} />;
}

export function Screen({ children, scroll, style, contentStyle }: PropsWithChildren<{
  scroll?: boolean;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
}>) {
  const base: ViewStyle = { flex: 1, backgroundColor: Colors.bg };
  if (scroll) {
    return (
      <SafeAreaView style={[base, style]} edges={['top']}>
        <ScrollView
          contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 120, ...(contentStyle as object) }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      </SafeAreaView>
    );
  }
  return (
    <SafeAreaView style={[base, style]} edges={['top']}>
      <View style={{ flex: 1, ...(contentStyle as object) }}>{children}</View>
    </SafeAreaView>
  );
}

export function Card({ children, style, onPress, flat, accessibilityRole = 'button', accessibilityLabel }: PropsWithChildren<{
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  flat?: boolean;
  accessibilityRole?: 'button' | 'link';
  accessibilityLabel?: string;
}>) {
  const inner = (
    <View style={[styles.card, !flat && shadow.card, style]}>{children}</View>
  );
  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole={accessibilityRole}
        accessibilityLabel={accessibilityLabel}
        style={({ pressed }) => ({ opacity: pressed ? 0.88 : 1 })}>
        {inner}
      </Pressable>
    );
  }
  return inner;
}

type BtnVariant = 'primary' | 'dark' | 'danger' | 'ghost' | 'outline' | 'success' | 'subtle';
type BtnSize = 'sm' | 'md' | 'lg';

export function Btn({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled,
  loading,
  icon,
  style,
}: {
  label: string;
  onPress?: () => void;
  variant?: BtnVariant;
  size?: BtnSize;
  disabled?: boolean;
  loading?: boolean;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
}) {
  const bg: Record<BtnVariant, string> = {
    primary: Colors.primary,
    dark: Colors.black,
    danger: Colors.danger,
    ghost: Colors.primarySoft,
    outline: 'transparent',
    success: Colors.success,
    subtle: Colors.surface,
  };
  const fg: Record<BtnVariant, string> = {
    primary: Colors.ink,
    dark: Colors.white,
    danger: Colors.white,
    ghost: Colors.primaryDeep,
    outline: Colors.text,
    success: Colors.white,
    subtle: Colors.text,
  };
  const pad = size === 'lg' ? 15 : size === 'sm' ? 9 : 12;
  const fs = size === 'lg' ? FontSize.lg : size === 'sm' ? FontSize.sm : FontSize.md;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      style={({ pressed }) => [
        styles.btn,
        {
          backgroundColor: variant === 'outline' ? 'transparent' : bg[variant],
          borderWidth: variant === 'outline' ? 1 : 0,
          borderColor: Colors.borderStrong,
          paddingVertical: pad,
          borderRadius: Radius.pill,
          opacity: disabled ? 0.45 : pressed ? 0.82 : 1,
        },
        style,
      ]}>
      {loading ? (
        <ActivityIndicator color={fg[variant]} />
      ) : (
        <View style={styles.btnInner}>
          {icon ? <Icon name={icon} size={fs + 2} color={fg[variant]} /> : null}
          <Text style={{ color: fg[variant], fontSize: fs, fontFamily: Fonts.sansBold, letterSpacing: 0.2 }}>
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

export function Chip({
  label,
  selected,
  onPress,
  tone = 'neutral',
  count,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  tone?: 'neutral' | 'danger' | 'success' | 'info';
  count?: number;
}) {
  const toneColor = tone === 'danger' ? Colors.danger : tone === 'success' ? Colors.success : tone === 'info' ? Colors.info : Colors.text;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      style={({ pressed }) => [
        styles.chip,
        selected && { backgroundColor: Colors.ink, borderColor: Colors.ink },
        pressed && { opacity: 0.8 },
      ]}>
      <Text style={[styles.chipText, selected && { color: Colors.white, fontFamily: Fonts.sansSemibold }]}>
        {label}
        {count !== undefined ? (
          <Text style={{ color: selected ? Colors.primary : toneColor, fontFamily: Fonts.sansBold, fontVariant: NumberStyle.fontVariant }}> {count}</Text>
        ) : null}
      </Text>
    </Pressable>
  );
}

export function Pill({ label, tone }: { label: string; tone: 'neutral' | 'danger' | 'success' | 'info' | 'warning' }) {
  const map = {
    neutral: { fg: Colors.textSecondary, bg: Colors.surface },
    danger: { fg: Colors.danger, bg: Colors.dangerSoft },
    success: { fg: Colors.success, bg: Colors.successSoft },
    info: { fg: Colors.info, bg: Colors.infoSoft },
    warning: { fg: Colors.warning, bg: Colors.warningSoft },
  };
  const c = map[tone];
  return (
    <View style={{ backgroundColor: c.bg, paddingHorizontal: Spacing.sm, paddingVertical: 3, borderRadius: Radius.pill }}>
      <Text style={{ color: c.fg, fontSize: FontSize.xs, fontFamily: Fonts.sansBold, letterSpacing: 0.3 }}>{label}</Text>
    </View>
  );
}


export function Row({ children, style, gap = Spacing.md }: PropsWithChildren<{ style?: StyleProp<ViewStyle>; gap?: number }>) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap }, style]}>{children}</View>;
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[{ height: StyleSheet.hairlineWidth, backgroundColor: Colors.border }, style]} />;
}

export function SectionTitle({ title, action, icon, onAction }: {
  title: string;
  action?: string;
  icon?: IconName;
  onAction?: () => void;
}) {
  return (
    <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md, marginTop: Spacing.lg }}>
      <Row gap={6}>
        {icon ? <Icon name={icon} size={15} color={Colors.textTertiary} /> : null}
        <Text style={styles.sectionTitle}>{title}</Text>
      </Row>
      {action ? (
        <Pressable onPress={onAction} hitSlop={8} accessibilityRole="button" accessibilityLabel={action}>
          <Text style={{ color: Colors.textTertiary, fontSize: FontSize.sm, fontFamily: Fonts.sansMedium }}>{action} ›</Text>
        </Pressable>
      ) : null}
    </Row>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  multiline,
  maxLength,
  hint,
  autoCapitalize,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  keyboardType?: TextInputProps['keyboardType'];
  multiline?: boolean;
  maxLength?: number;
  hint?: string;
  autoCapitalize?: TextInputProps['autoCapitalize'];
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: Spacing.xs }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={styles.fieldLabel}>{label}</Text>
        {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
      </View>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={Colors.textFaint}
        keyboardType={keyboardType}
        multiline={multiline}
        maxLength={maxLength}
        autoCapitalize={autoCapitalize}
        accessibilityLabel={label}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          styles.input,
          focused && { borderColor: Colors.primary, borderWidth: 1.5 },
          multiline && { minHeight: 76, textAlignVertical: 'top' },
        ]}
      />
    </View>
  );
}

export function ToggleRow({ label, sub, value, onChange, disabled }: {
  label: string;
  sub?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Row style={{ justifyContent: 'space-between', paddingVertical: Spacing.md, opacity: disabled ? 0.55 : 1 }}>
      <View style={{ flex: 1, paddingRight: Spacing.lg }}>
        <Text style={{ fontSize: FontSize.md, color: Colors.text, fontFamily: Fonts.sansMedium }}>{label}</Text>
        {sub ? <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary, marginTop: 2, lineHeight: 17, fontFamily: Fonts.sans }}>{sub}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: Colors.borderStrong, true: Colors.success }}
        thumbColor={Colors.white}
        ios_backgroundColor={Colors.borderStrong}
        accessibilityLabel={label}
        accessibilityState={{ disabled: disabled ?? false }}
      />
    </Row>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  equal = false,
}: {
  options: { key: T; label: string; count?: number }[];
  value: T;
  onChange: (k: T) => void;
  equal?: boolean;
}) {
  return (
    <View style={styles.segmentTrack}>
      {options.map((opt) => {
        const active = opt.key === value;
        return (
          <Pressable
            key={opt.key}
            onPress={() => onChange(opt.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={({ pressed }) => [styles.segmentItem, active && styles.segmentItemActive, pressed && { opacity: 0.7 }]}>
            <Text
              numberOfLines={1}
              style={[
                styles.segmentText,
                active && { color: Colors.ink, fontFamily: Fonts.sansBold },
                !equal && opt.label.length > 4 && { fontSize: FontSize.xs },
              ]}>
              {opt.label}
              {opt.count !== undefined ? (
                <Text style={{ color: active ? Colors.primaryDeep : Colors.textTertiary, fontFamily: Fonts.sansSemibold, fontVariant: NumberStyle.fontVariant }}>
                  {' '}{opt.count}
                </Text>
              ) : null}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function SheetModal({
  visible,
  onClose,
  title,
  children,
}: PropsWithChildren<{ visible: boolean; onClose: () => void; title?: string }>) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} accessibilityViewIsModal>
      <KeyboardAvoidingView
        style={{ flex: 1, justifyContent: 'flex-end' }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={t('common.close')} />
        <View style={styles.sheet}>
          <View style={styles.sheetHandle} />
          {title ? <Text style={styles.sheetTitle}>{title}</Text> : null}
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function Empty({ icon, title, sub }: { icon: IconName; title: string; sub?: string }) {
  return (
    <View style={styles.empty} accessibilityLabel={title}>
      <View style={styles.emptyIcon}>
        <Icon name={icon} size={28} color={Colors.textTertiary} />
      </View>
      <Text style={{ color: Colors.textSecondary, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold }}>{title}</Text>
      {sub ? <Text style={{ color: Colors.textFaint, fontSize: FontSize.xs, fontFamily: Fonts.sans }}>{sub}</Text> : null}
    </View>
  );
}




/* Money display — formatTZS only, integer TZS, signed rows render the sign. */

/* Rating display — values always come from the API (never hardcoded). */

/* Bilingual microcopy pill — trust pills/footnotes only (never buttons/dialogs). */

/* PriceBreakdown — rendered verbatim from the server (client totals advisory). */
export function PriceBreakdown({ rows, totalTZS, totalLabel }: {
  rows: { label: string; amountTZS: number; signed?: boolean; highlight?: boolean }[];
  totalTZS: number;
  totalLabel: string;
}) {
  return (
    <View style={{ gap: Spacing.sm }}>
      {rows.map((r) => (
        <Row key={r.label} style={{ justifyContent: 'space-between' }}>
          <Text style={{ fontSize: FontSize.sm, color: r.highlight ? Colors.text : Colors.textSecondary, fontFamily: Fonts.sansMedium }}>{r.label}</Text>
          <Text
            style={{
              fontSize: FontSize.sm,
              color: r.signed && r.amountTZS < 0 ? Colors.success : Colors.text,
              fontFamily: Fonts.sansSemibold,
              fontVariant: NumberStyle.fontVariant,
            }}>
            {r.signed && r.amountTZS !== 0 ? `${r.amountTZS < 0 ? '−' : ''}` : ''}{formatTZS(Math.abs(r.amountTZS))}
          </Text>
        </Row>
      ))}
      <Divider />
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={{ fontSize: FontSize.lg, fontFamily: Fonts.sansExtraBold, color: Colors.text }}>{totalLabel}</Text>
        <Text style={{ fontSize: FontSize.lg, fontFamily: Fonts.displayBold, color: Colors.text, fontVariant: NumberStyle.fontVariant }}>{formatTZS(totalTZS)}</Text>
      </Row>
    </View>
  );
}

export function ListRow({
  title,
  sub,
  value,
  icon,
  onPress,
  danger,
  trailing,
  chevron = true,
}: {
  title: string;
  sub?: string;
  value?: string;
  icon?: IconName;
  onPress?: () => void;
  danger?: boolean;
  trailing?: React.ReactNode;
  chevron?: boolean;
}) {
  const IconComp = icon ? (
    <View style={[styles.listIcon, danger && { backgroundColor: Colors.dangerSoft }]}>
      <Icon name={icon} size={17} color={danger ? Colors.danger : Colors.textSecondary} />
    </View>
  ) : null;
  const content = (
    <View style={styles.listRow}>
      {IconComp}
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: FontSize.md, color: danger ? Colors.danger : Colors.text, fontFamily: Fonts.sansMedium }} numberOfLines={1}>
          {title}
        </Text>
        {sub ? <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary, marginTop: 2, fontFamily: Fonts.sans }} numberOfLines={1}>{sub}</Text> : null}
      </View>
      {trailing}
      {value ? <Text style={{ color: Colors.textSecondary, fontSize: FontSize.sm, fontFamily: Fonts.sansMedium, fontVariant: NumberStyle.fontVariant }}>{value}</Text> : null}
      {onPress && chevron ? <Icon name="chevron-forward" size={15} color={Colors.textFaint} /> : null}
    </View>
  );
  if (onPress) {
    return (
      <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [{ backgroundColor: pressed ? Colors.surfacePress : 'transparent' }]}>
        {content}
      </Pressable>
    );
  }
  return content;
}

export function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <View style={styles.badge} accessibilityLabel={`${count} unread`}>
      <Text style={{ color: Colors.white, fontSize: 10, fontFamily: Fonts.sansExtraBold, fontVariant: NumberStyle.fontVariant }}>
        {count > 99 ? '99+' : count}
      </Text>
    </View>
  );
}

export function Stars({ rating, size = 13, showValue }: { rating: number; size?: number; showValue?: boolean }) {
  return (
    <Row gap={2}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Icon key={i} name={i <= rating ? 'star' : 'star-outline'} size={size} color={i <= rating ? Colors.gold : Colors.borderStrong} />
      ))}
      {showValue ? <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary, marginLeft: 4, fontFamily: Fonts.sansMedium, fontVariant: NumberStyle.fontVariant }}>{rating.toFixed(1)}</Text> : null}
    </Row>
  );
}

export function Avatar({ name, size = 44, color }: { name: string; size?: number; color?: string }) {
  const palette = [Colors.primaryDark, Colors.info, Colors.success, Colors.gold, Colors.danger, Colors.primary];
  const idx = (name.charCodeAt(0) + name.length) % palette.length;
  const bg = color ?? palette[idx];
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
      <Text style={{ color: Colors.white, fontSize: size * 0.4, fontFamily: Fonts.sansExtraBold }}>
        {name.trim().charAt(0).toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.card,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  btn: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnInner: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  chip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    borderRadius: Radius.pill,
    backgroundColor: Colors.card,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
  },
  chipText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sansMedium },
  sectionTitle: {
    fontSize: FontSize.lg,
    fontFamily: Fonts.sansExtraBold,
    color: Colors.text,
    letterSpacing: 0.2,
  },
  fieldLabel: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontFamily: Fonts.sansSemibold,
  },
  fieldHint: { fontSize: FontSize.xs, color: Colors.textFaint, fontFamily: Fonts.sans },
  input: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Platform.OS === 'ios' ? 12 : 9,
    fontSize: FontSize.md,
    color: Colors.text,
    fontFamily: Fonts.sans,
    backgroundColor: Colors.card,
  },
  segmentTrack: {
    flexDirection: 'row',
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    padding: 3,
    gap: 2,
  },
  segmentItem: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderRadius: Radius.sm,
    alignItems: 'center',
  },
  segmentItemActive: { backgroundColor: Colors.card, shadowColor: Colors.black, shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  segmentText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sansMedium },
  backdrop: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: Colors.overlay,
  },
  sheet: {
    backgroundColor: Colors.card,
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    padding: Spacing.lg,
    paddingBottom: 40,
    gap: Spacing.md,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.borderStrong,
    marginBottom: Spacing.sm,
  },
  sheetTitle: {
    fontSize: FontSize.lg,
    fontFamily: Fonts.sansExtraBold,
    color: Colors.text,
    textAlign: 'center',
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.lg,
  },
  listIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    minWidth: 17,
    height: 17,
    borderRadius: 9,
    backgroundColor: Colors.danger,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: { alignItems: 'center', paddingVertical: Spacing.xxl * 1.5, gap: Spacing.sm },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    backgroundColor: Colors.dangerSoft,
    borderRadius: Radius.md,
    padding: Spacing.lg,
    marginVertical: Spacing.md,
  },
});


/* Consumer-specific primitives live in their own files (INSTRUCTIONS §5) and
 * are re-exported here so screens keep a single import surface. */
export { EmptyState } from './EmptyState';
export { ErrorState } from './ErrorState';
export { Skeleton, SkeletonCard } from './SkeletonCard';
export { MoneyText } from './MoneyText';
export { Rating } from './Rating';
export { BilingualPill } from './BilingualPill';
export { StatusPill } from './StatusPill';
