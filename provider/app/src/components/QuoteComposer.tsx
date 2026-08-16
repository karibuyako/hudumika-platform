import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Btn, Field, Icon } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { formatTZS, t } from '@/i18n';
import type { BookingQuote, PartsLine } from '@hudumika/contract';

/** Quote composer — labor + trip fee + optional parts. Totals stay server-computed. */
export function QuoteComposer({ onCancel, onSubmit, loading, estimateHint, initial }: {
  onCancel: () => void;
  onSubmit: (quote: BookingQuote) => void;
  loading?: boolean;
  estimateHint?: string | null;
  initial?: Partial<BookingQuote>;
}) {
  const [labor, setLabor] = useState(String(initial?.laborTZS ?? ''));
  const [trip, setTrip] = useState(String(initial?.tripFeeTZS ?? ''));
  const [note, setNote] = useState(initial?.note ?? '');
  const [parts, setParts] = useState<PartsLine[]>(initial?.parts ?? []);
  const [error, setError] = useState('');

  const laborTZS = Number(labor);
  const valid = Number.isInteger(laborTZS) && laborTZS > 0;

  const updatePart = (idx: number, patch: Partial<PartsLine>) => {
    setParts((ps) => ps.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  };

  const submit = () => {
    if (!valid) {
      setError('Labor must be a positive whole number');
      return;
    }
    setError('');
    const cleanParts = parts.filter((p) => p.name.trim()).map((p) => ({ name: p.name.trim(), quantity: Math.max(1, Math.round(p.quantity)), unitCostTZS: Math.round(p.unitCostTZS) }));
    onSubmit({
      laborTZS,
      tripFeeTZS: trip ? Math.round(Number(trip)) : 0,
      parts: cleanParts.length ? cleanParts : undefined,
      note: note.trim() || undefined,
    });
  };

  return (
    <View style={{ gap: Spacing.md }}>
      {estimateHint ? (
        <View style={styles.hintBox}>
          <Icon name="information-circle" size={14} color={Colors.info} />
          <Text style={styles.hintText}>{t('quotes.estimateHint')} {formatTZS(Number(estimateHint))}</Text>
        </View>
      ) : null}

      <Field label={`${t('quotes.labor')} (TZS)`} value={labor} onChangeText={setLabor} keyboardType="number-pad" />
      <Field label={`${t('quotes.trip')} (TZS)`} value={trip} onChangeText={setTrip} keyboardType="number-pad" hint={t('misc.optional')} />

      <View style={{ gap: Spacing.xs }}>
        <Text style={styles.sectionLabel}>{t('quotes.parts')}</Text>
        {parts.map((p, i) => (
          <View key={i} style={styles.partRow}>
            <View style={{ flex: 2 }}>
              <Field label={t('parts.name')} value={p.name} onChangeText={(v) => updatePart(i, { name: v })} />
            </View>
            <View style={{ flex: 1 }}>
              <Field label={t('parts.qty')} value={String(p.quantity)} onChangeText={(v) => updatePart(i, { quantity: Number(v) || 1 })} keyboardType="number-pad" />
            </View>
            <View style={{ flex: 1 }}>
              <Field label={t('parts.unitCost')} value={String(p.unitCostTZS)} onChangeText={(v) => updatePart(i, { unitCostTZS: Number(v) || 0 })} keyboardType="number-pad" />
            </View>
          </View>
        ))}
        <Pressable
          onPress={() => setParts((ps) => [...ps, { name: '', quantity: 1, unitCostTZS: 0 }])}
          accessibilityRole="button"
          style={({ pressed }) => [styles.addPart, pressed && { opacity: 0.7 }]}>
          <Icon name="add" size={16} color={Colors.primaryDeep} />
          <Text style={styles.addPartText}>{t('parts.add')}</Text>
        </Pressable>
      </View>

      <Field label={t('quotes.note')} value={note} onChangeText={setNote} multiline placeholder={t('quotes.notePlaceholder')} maxLength={500} />

      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Btn label={t('quotes.submit')} onPress={submit} loading={loading} size="lg" />
      <Btn label={t('misc.cancel')} variant="ghost" onPress={onCancel} disabled={loading} />
    </View>
  );
}

const styles = StyleSheet.create({
  hintBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.infoSoft,
    borderRadius: Radius.sm,
    padding: Spacing.sm,
  },
  hintText: { flex: 1, color: Colors.info, fontSize: FontSize.xs, fontFamily: 'PlusJakartaSans_600SemiBold' },
  sectionLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: 'PlusJakartaSans_700Bold' },
  partRow: { flexDirection: 'row', gap: Spacing.sm },
  addPart: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
  addPartText: { color: Colors.primaryDeep, fontSize: FontSize.sm, fontFamily: 'PlusJakartaSans_700Bold' },
  error: { color: Colors.danger, fontSize: FontSize.sm },
});
