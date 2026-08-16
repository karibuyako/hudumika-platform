/* Events list — GET /entertainment/events (cursor pagination; category
 * chips). Cards navigate to /events/{eventId}. StartsAt renders local time
 * via fullDateISO; prices are integer TZS via formatTZS/MoneyText. */
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Card, Chip, EmptyState, ErrorState, MoneyText, Pill, Row, Screen, SkeletonCard } from '@/components/ui';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t, type I18nKey } from '@/i18n';
import { getEventsRepository } from '@/repos';
import { fullDateISO } from '@/lib/dates';
import type { EventListing } from '@hudumika/contract';

const CATEGORIES = ['music', 'theatre', 'festival'] as const;

/** Server categories are free-form strings — translate the seeded ones,
 * fall back to the raw value for anything else. */
function categoryLabel(category?: string): string {
  if (category && (CATEGORIES as readonly string[]).includes(category)) {
    return t(`events.category.${category}` as I18nKey);
  }
  return category ?? '';
}

export default function EventsScreen() {
  const router = useRouter();
  const [events, setEvents] = useState<EventListing[] | null>(null);
  const [category, setCategory] = useState<string>('all');
  const [error, setError] = useState('');

  const load = useCallback(async (cat: string) => {
    setError('');
    try {
      const { results } = await getEventsRepository().list({ category: cat === 'all' ? undefined : cat });
      setEvents(results);
    } catch {
      setError(t('common.error'));
    }
  }, []);

  useEffect(() => {
    load(category);
  }, [category, load]);

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={() => load(category)} />
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg, gap: Spacing.md }}>
        <Text style={styles.title}>{t('events.title')}</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: Spacing.sm }}>
          <Chip label={t('events.all')} selected={category === 'all'} onPress={() => setCategory('all')} />
          {CATEGORIES.map((c) => (
            <Chip key={c} label={t(`events.category.${c}` as I18nKey)} selected={category === c} onPress={() => setCategory(c)} />
          ))}
        </ScrollView>
      </View>

      {!events ? (
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={3} />
          <SkeletonCard rows={2} />
          <SkeletonCard rows={2} />
        </View>
      ) : (
        <FlatList
          data={events}
          keyExtractor={(e) => e.id}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }}
          ListEmptyComponent={<EmptyState icon="calendar-outline" title={t('events.noEvents')} />}
          renderItem={({ item }) => (
            <Card
              style={styles.card}
              onPress={() => router.push(`/events/${item.id}`)}
              accessibilityRole="link"
              accessibilityLabel={`${t('events.title')}: ${item.title}`}>
              <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.sm }}>
                <Text style={styles.name} numberOfLines={1}>{item.title}</Text>
                {item.category ? <Pill label={categoryLabel(item.category)} tone="info" /> : null}
              </Row>
              <Text style={styles.meta}>{item.venue ?? t('events.venue')}</Text>
              <Text style={styles.meta}>{item.cityName ?? item.cityId}</Text>
              <Text style={styles.meta}>{t('events.startsAt')} · {fullDateISO(item.startsAt)}</Text>
              {item.startingPriceTZS !== undefined ? (
                <Row gap={4} style={{ marginTop: Spacing.sm }}>
                  <Text style={styles.meta}>{t('events.from')}</Text>
                  <MoneyText amountTZS={item.startingPriceTZS} size={FontSize.md} bold />
                </Row>
              ) : null}
            </Card>
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text },
  card: { marginBottom: Spacing.md },
  name: { fontSize: FontSize.lg, fontFamily: Fonts.sansExtraBold, color: Colors.text, flex: 1, paddingRight: Spacing.md },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
});
