import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';

import { Btn, Card, EmptyState, ErrorState, Pill, Row, Screen, SkeletonCard } from '@/components/ui';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { getSupportRepository, type HelpArticle } from '@/repos';

export default function HelpArticleScreen() {
  const router = useRouter();
  const { articleId } = useLocalSearchParams<{ articleId: string }>();
  const [articles, setArticles] = useState<HelpArticle[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      // The contract exposes no GET /help/articles/{id} — resolve the
      // article from the knowledge base (server filters client-side too).
      setArticles(await getSupportRepository().listArticles());
    } catch {
      setError(t('common.error'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (!articles) {
    return (
      <Screen>
        <SkeletonCard rows={4} />
      </Screen>
    );
  }

  const article = articles.find((a) => a.id === articleId);

  if (!article) {
    return (
      <Screen>
        <EmptyState icon="document-text-outline" title={t('help.articleNotFound')} actionLabel={t('help.backToArticles')} onAction={() => router.replace('/help')} />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 120 }} showsVerticalScrollIndicator={false}>
        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <Pill label={article.category} tone="info" />
        </Row>
        <Text style={styles.title}>{article.title}</Text>
        <Card flat style={{ marginTop: Spacing.md }}>
          <Text style={styles.body}>{article.body ?? t('help.empty')}</Text>
        </Card>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text },
  body: { fontSize: FontSize.md, color: Colors.textSecondary, fontFamily: Fonts.sans, lineHeight: 22 },
});
