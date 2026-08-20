import { Ionicons } from '@expo/vector-icons';
import React, { PropsWithChildren, useEffect, useState } from 'react';
import {
  AccessibilityInfo,
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
import { t } from '@/i18n';
import { useNetworkStore } from '@/store/network';

export type IconName = keyof typeof Ionicons.glyphMap;

export { CountdownRing } from './CountdownRing';

/** Async + reactive reduced-motion flag. Animations that are not essential
 * (modal slides, decorative pulses) are disabled when this is true. */
export function useReduceMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (mounted) setReduced(v);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => {
      if (mounted) setReduced(v);
    });
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);
  return reduced;
}

/** Loading indicator: honors reduced motion by rendering a static ring
 * instead of a spinning one. */
export function Spinner({ color = Colors.primary, size = 'small' }: { color?: string; size?: number | 'small' | 'large' }) {
  const reduceMotion = useReduceMotion();
  if (reduceMotion) {
    const dim = size === 'large' ? 30 : size === 'small' ? 16 : 22;
    return (
      <View
        accessible
        accessibilityLabel={t('common.loading')}
        style={{ width: dim, height: dim, borderRadius: dim / 2, borderWidth: 2, borderColor: color, opacity: 0.4 }}
      />
    );
  }
  return <ActivityIndicator color={color} size={size} />;
}

/** Decorative icons are hidden from the accessibility tree; pass `label` for
 * icon-only controls that must be read out. */
export function Icon({ name, size = 20, color = Colors.text, label }: { name: IconName; size?: number; color?: string; label?: string }) {
  return (
    <View
      accessible={label != null}
      accessibilityLabel={label}
      accessibilityElementsHidden={label == null}
      importantForAccessibility={label == null ? 'no-hide-descendants' : 'yes'}>
      <Ionicons name={name} size={size} color={color} />
    </View>
  );
}

export function Screen({ children, scroll, style, contentStyle }: PropsWithChildren<{
  scroll?: boolean;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
}>) {
  const base: ViewStyle = { flex: 1, backgroundColor: Colors.bg };
  const banner = <OfflineBanner />;
  if (scroll) {
    return (
      <SafeAreaView style={[base, style]} edges={['top']}>
        {banner}
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
      {banner}
      <View style={{ flex: 1, ...(contentStyle as object) }}>{children}</View>
    </SafeAreaView>
  );
}

/** Connectivity banner: shown when offline ("changes will retry") or while the
 * offline mutation queue replays ("syncing n pending changes"). */
export function OfflineBanner() {
  const online = useNetworkStore((s) => s.online);
  const syncing = useNetworkStore((s) => s.syncing);
  const queuedCount = useNetworkStore((s) => s.queuedCount);
  const showSync = online && syncing && queuedCount > 0;
  if (online && !showSync) return null;
  const text = showSync
    ? t(queuedCount === 1 ? 'offline.syncingOne' : 'offline.syncingMany', { count: queuedCount })
    : t('offline.banner');
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
      style={styles.offlineBanner}>
      <Icon name={showSync ? 'sync' : 'cloud-offline'} size={14} color={Colors.white} />
      <Text style={styles.offlineBannerText}>{text}</Text>
    </View>
  );
}

export function Card({ children, style, onPress, flat, accessibilityLabel }: PropsWithChildren<{
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  flat?: boolean;
  accessibilityLabel?: string;
}>) {
  const inner = (
    <View style={[styles.card, !flat && shadow.card, style]}>{children}</View>
  );
  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled: false }}
        hitSlop={8}
        style={({ pressed }) => ({ opacity: pressed ? 0.88 : 1, minHeight: 48, justifyContent: 'center' })}>
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
      hitSlop={size === 'sm' ? { top: 10, bottom: 10, left: 6, right: 6 } : size === 'md' ? { top: 8, bottom: 8 } : { top: 6, bottom: 6 }}
      style={({ pressed }) => [
        styles.btn,
        {
          backgroundColor: variant === 'outline' ? 'transparent' : bg[variant],
          borderWidth: variant === 'outline' ? 1 : 0,
          borderColor: Colors.borderStrong,
          paddingVertical: pad,
          minHeight: 48,
          borderRadius: Radius.pill,
          opacity: disabled ? 0.45 : pressed ? 0.82 : 1,
        },
        style,
      ]}>
      {loading ? (
        <Spinner color={fg[variant]} size={size === 'lg' ? 'large' : size === 'sm' ? 'small' : undefined} />
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
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: selected ?? false }}
      hitSlop={{ top: 8, bottom: 8 }}
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

const STATUS_META: Record<string, { label: string; tone: 'danger' | 'warning' | 'info' | 'success' | 'neutral' }> = {
  new: { label: 'NEW', tone: 'danger' },
  preparing: { label: 'PREPARING', tone: 'warning' },
  ready: { label: 'READY', tone: 'info' },
  completed: { label: 'COMPLETED', tone: 'success' },
  cancelled: { label: 'CANCELLED', tone: 'neutral' },
};

export function StatusPill({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? STATUS_META.completed;
  return <Pill label={meta.label} tone={meta.tone} />;
}

/** Persistent SOS action (Home header, order action bar): danger tone,
 * ≥48 pt touch target, routes to the safety hub. */
export function SosButton({ onPress, style }: { onPress: () => void; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t('safety.sos')}
      style={({ pressed }) => [styles.sosBtn, pressed && { opacity: 0.85 }, style]}>
      <Icon name="alert-circle" size={18} color={Colors.white} />
      <Text style={styles.sosBtnLabel}>{t('safety.sos')}</Text>
    </Pressable>
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
        <Pressable
          onPress={onAction}
          accessibilityRole="button"
          accessibilityLabel={action}
          accessibilityState={{ disabled: false }}
          hitSlop={8}
          style={({ pressed }) => [{ minHeight: 48, justifyContent: 'center', opacity: pressed ? 0.7 : 1 }]}>
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
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  keyboardType?: TextInputProps['keyboardType'];
  multiline?: boolean;
  maxLength?: number;
  hint?: string;
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
        placeholderTextColor={Colors.textTertiary}
        keyboardType={keyboardType}
        multiline={multiline}
        maxLength={maxLength}
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

export function ToggleRow({ label, sub, value, onChange }: {
  label: string;
  sub?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Row style={{ justifyContent: 'space-between', paddingVertical: Spacing.md }}>
      <View style={{ flex: 1, paddingRight: Spacing.lg }}>
        <Text style={{ fontSize: FontSize.md, color: Colors.text, fontFamily: Fonts.sansMedium }}>{label}</Text>
        {sub ? <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary, marginTop: 2, lineHeight: 17, fontFamily: Fonts.sans }}>{sub}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        accessibilityRole="switch"
        accessibilityLabel={label}
        accessibilityState={{ checked: value }}
        trackColor={{ false: Colors.borderStrong, true: Colors.success }}
        thumbColor={Colors.white}
        ios_backgroundColor={Colors.borderStrong}
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
            accessibilityLabel={opt.label}
            accessibilityState={{ selected: active }}
            hitSlop={{ top: 8, bottom: 8 }}
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
  const reduceMotion = useReduceMotion();
  return (
    <Modal visible={visible} transparent animationType={reduceMotion ? 'none' : 'slide'} onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={{ flex: 1, justifyContent: 'flex-end' }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
        />
        <View style={styles.sheet} accessibilityViewIsModal>
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
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Icon name={icon} size={28} color={Colors.textTertiary} />
      </View>
      <Text style={{ color: Colors.textSecondary, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold }}>{title}</Text>
      {sub ? <Text style={{ color: Colors.textTertiary, fontSize: FontSize.xs, fontFamily: Fonts.sans }}>{sub}</Text> : null}
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
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ disabled: false }}
        hitSlop={{ top: 4, bottom: 4 }}
        style={({ pressed }) => [{ backgroundColor: pressed ? Colors.surfacePress : 'transparent', minHeight: 48, justifyContent: 'center' }]}>
        {content}
      </Pressable>
    );
  }
  return content;
}

export function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <View style={styles.badge} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
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
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
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

export function Kpi({ label, value, delta, icon, onPress }: {
  label: string;
  value: string;
  delta?: number;
  icon?: IconName;
  onPress?: () => void;
}) {
  const up = (delta ?? 0) >= 0;
  const content = (
    <Card style={styles.kpi} onPress={onPress}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={styles.kpiLabel}>{label}</Text>
        {icon ? <Icon name={icon} size={14} color={Colors.textFaint} /> : null}
      </Row>
      <Text style={[styles.kpiValue, { fontVariant: NumberStyle.fontVariant }]}>{value}</Text>
      {delta !== undefined ? (
        <Text style={{ fontSize: FontSize.xs, fontFamily: Fonts.sansBold, color: up ? Colors.success : Colors.danger, fontVariant: NumberStyle.fontVariant }}>
          {up ? '▲' : '▼'} {Math.abs(delta)}%
        </Text>
      ) : (
        <View style={{ height: 11 }} />
      )}
    </Card>
  );
  return content;
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
    minHeight: 48,
    justifyContent: 'center',
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
  fieldHint: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans },
  input: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Platform.OS === 'ios' ? 12 : 9,
    minHeight: 48,
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
    minHeight: 48,
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderRadius: Radius.sm,
    alignItems: 'center',
  },
  segmentItemActive: { backgroundColor: Colors.card, shadowColor: Colors.black, shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  segmentText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sansMedium },
  sosBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: Colors.danger,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.lg,
    minHeight: 48,
  },
  sosBtnLabel: { color: Colors.white, fontSize: FontSize.md, fontFamily: Fonts.sansBold, letterSpacing: 0.4 },
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
  kpi: { flex: 1, paddingVertical: 14, paddingTop: 14, paddingBottom: 14, gap: 4 },
  kpiLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sansMedium },
  kpiValue: { fontSize: FontSize.xl, fontFamily: Fonts.displayBold, color: Colors.text },
  offlineBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.warning,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 10,
  },
  offlineBannerText: { flex: 1, color: Colors.white, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold },
});