import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Btn, Card, EmptyState, ErrorState, Icon, Pill, Screen, SkeletonCard } from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { getSupportRepository, type HelpArticle } from '@/repos';

export default function HelpScreen() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [articles, setArticles] = useState<HelpArticle[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Debounced search (300 ms) — never a request per keystroke (search.tsx pattern).
  const fetchArticles = useCallback(async (q: string) => {
    setError('');
    setLoading(true);
    try {
      setArticles(await getSupportRepository().listArticles(q || undefined));
    } catch {
      setError(t('common.error'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const q = query.trim();
    const timer = setTimeout(() => fetchArticles(q), 300);
    return () => clearTimeout(timer);
  }, [query, fetchArticles]);

  const searching = query.trim().length > 0;
  const showSkeleton = loading && articles === null;
  const showEmpty = !showSkeleton && !error && articles !== null && articles.length === 0;

  return (
    <Screen scroll>
      <View style={styles.searchRow}>
        <Pressable onPress={() => router.back()} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.back')}>
          <Icon name="arrow-back" size={22} color={Colors.text} />
        </Pressable>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t('help.search')}
          placeholderTextColor={Colors.textFaint}
          accessibilityLabel={t('help.search')}
          returnKeyType="search"
          style={styles.input}
        />
      </View>

      {showSkeleton ? <SkeletonCard rows={4} /> : null}

      {error ? <ErrorState message={error} onRetry={() => fetchArticles(query.trim())} /> : null}

      {showEmpty ? (
        <EmptyState
          icon="search-outline"
          title={searching ? t('help.noResults') : t('help.empty')}
          actionLabel={searching ? t('search.clear') : undefined}
          onAction={searching ? () => setQuery('') : undefined}
        />
      ) : null}

      {!showSkeleton && !error && articles && articles.length > 0 ? (
        <>
          {articles.map((article) => (
            <Card key={article.id} style={styles.article} onPress={() => router.push(`/help/${article.id}`)}>
              <View style={{ flex: 1 }}>
                <Text style={styles.articleTitle} numberOfLines={2}>{article.title}</Text>
                <Pill label={article.category} tone="neutral" />
              </View>
              <Icon name="chevron-forward" size={18} color={Colors.textTertiary} />
            </Card>
          ))}
          <Card style={styles.contact} flat>
            <Text style={styles.contactTitle}>{t('help.contact')}</Text>
            <Btn label={t('help.contactCta')} onPress={() => router.push('/support')} size="md" />
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginBottom: Spacing.lg },
  input: {
    flex: 1,
    backgroundColor: Colors.card,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 11,
    fontSize: FontSize.md,
    color: Colors.text,
    fontFamily: Fonts.sans,
  },
  article: {
    marginBottom: Spacing.sm,
    paddingVertical: Spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  articleTitle: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansSemibold, marginBottom: 6 },
  contact: { marginTop: Spacing.xl, padding: Spacing.lg, gap: Spacing.md },
  contactTitle: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansSemibold },
});
