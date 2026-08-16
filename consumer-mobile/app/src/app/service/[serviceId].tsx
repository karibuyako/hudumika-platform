/* Service (category) detail — MASTER-BLUEPRINT §9 screens 1–2: category info
 * (pricing model, duration, cancellation rules), the intake questionnaire
 * preview, providers for the trade, and the Book CTA into the booking flow.
 * Providers resolve via list({ trade }) using the category-name stem
 * (src/lib/catalogue.ts) — no fabricated mapping.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Btn, Card, EmptyState, ErrorState, Icon, MoneyText, Pill, Rating, Row, Screen, SkeletonCard } from '@/components/ui';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { tradeStem } from '@/lib/catalogue';
import { track } from '@/lib/analytics';
import { getProvidersRepository } from '@/repos';
import type { ProviderPublic, ServiceCategoryConfig, ServiceQuestion } from '@hudumika/contract';
import { ServiceCategoryConfigPricingModel } from '@hudumika/contract';

const PRICING_LABEL: Record<string, string> = {
  [ServiceCategoryConfigPricingModel.fixed]: t('service.pricing.fixed'),
  [ServiceCategoryConfigPricingModel.hourly]: t('service.pricing.hourly'),
  [ServiceCategoryConfigPricingModel.quote]: t('service.pricing.quote'),
  [ServiceCategoryConfigPricingModel.dynamic]: t('service.pricing.dynamic'),
};

export default function ServiceDetailScreen() {
  const router = useRouter();
  const { serviceId } = useLocalSearchParams<{ serviceId: string }>();
  const [category, setCategory] = useState<ServiceCategoryConfig | null>(null);
  const [questions, setQuestions] = useState<ServiceQuestion[]>([]);
  const [providers, setProviders] = useState<ProviderPublic[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    setNotFound(false);
    try {
      const categories = await getProvidersRepository().listServices();
      const found = categories.find((c) => c.id === serviceId);
      if (!found) {
        setNotFound(true);
        return;
      }
      setCategory(found);
      const [qs, provs] = await Promise.all([
        getProvidersRepository().getQuestions(found.id),
        // The mock filters trades by substring; the stem bridges the category
        // name to the seeded trade ('Plumbing' → 'plumb' → 'Plumber').
        getProvidersRepository().list({ trade: tradeStem(found.name) }),
      ]);
      setQuestions(qs);
      setProviders(provs);
    } catch {
      setError(t('common.error'));
    }
  }, [serviceId]);

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

  if (notFound) {
    return (
      <Screen>
        <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
        </View>
        <EmptyState icon="construct-outline" title={t('service.notFound')} />
      </Screen>
    );
  }

  if (!category) {
    return (
      <Screen>
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={2} />
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
        <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
        <Text style={styles.title}>{t('service.title')}</Text>
        <View style={{ width: 40 }} />
      </Row>

      <Card style={{ gap: Spacing.md }}>
        <Text style={styles.name}>{category.name}</Text>
        <Row gap={Spacing.sm}>
          <Pill label={PRICING_LABEL[category.pricingModel] ?? category.pricingModel} tone="info" />
          {category.defaultDurationMinutes ? (
            <Pill label={t('service.minutes', { n: category.defaultDurationMinutes })} tone="neutral" />
          ) : null}
        </Row>
        {category.cancellationRules ? (
          <View>
            <Text style={styles.label}>{t('service.cancellation')}</Text>
            <Text style={styles.meta}>{category.cancellationRules}</Text>
          </View>
        ) : null}
        {(category.requiredSkills ?? []).length > 0 ? (
          <View>
            <Text style={styles.label}>{t('service.skills')}</Text>
            <Row gap={Spacing.sm} style={{ flexWrap: 'wrap' }}>
              {category.requiredSkills!.map((s) => (
                <Pill key={s} label={s} tone="neutral" />
              ))}
            </Row>
          </View>
        ) : null}
        {(category.requiredCertifications ?? []).length > 0 ? (
          <View>
            <Text style={styles.label}>{t('service.certifications')}</Text>
            <Row gap={Spacing.sm} style={{ flexWrap: 'wrap' }}>
              {category.requiredCertifications!.map((c) => (
                <Pill key={c} label={c} tone="neutral" />
              ))}
            </Row>
          </View>
        ) : null}
      </Card>

      {/* Intake questionnaire — the real intake runs in /book; this is the
          preview of the questions GET /service-categories/{id}/questions
          ships for the category. */}
      {questions.length > 0 ? (
        <>
          <Text style={styles.section}>{t('service.questionnaire')}</Text>
          <Card style={{ gap: Spacing.sm }}>
            {questions.map((q, i) => (
              <Row key={q.key} gap={Spacing.sm}>
                <Text style={[styles.meta, { color: Colors.primaryDeep, fontFamily: Fonts.sansBold }]}>{i + 1}.</Text>
                <Text style={styles.meta} numberOfLines={2}>{q.label}</Text>
                {q.required ? <Pill label={t('booking.questions.required')} tone="danger" /> : null}
              </Row>
            ))}
          </Card>
        </>
      ) : null}

      <Text style={styles.section}>{t('service.providers')}</Text>
      {providers.length === 0 ? (
        <EmptyState icon="person-outline" title={t('service.emptyProviders')} />
      ) : (
        providers.map((p) => (
          <Card key={p.id} style={styles.card} onPress={() => router.push(`/provider/${p.id}`)}>
            <Row style={{ justifyContent: 'space-between' }}>
              <View style={{ flex: 1 }}>
                <Row gap={6}>
                  <Text style={styles.providerName} numberOfLines={1}>{p.name}</Text>
                  {p.verified ? <Icon name="shield-checkmark" size={14} color={Colors.success} /> : null}
                </Row>
                <Text style={styles.meta}>{p.trade} · {(p.serviceAreas ?? []).join(', ')}</Text>
                <Row gap={Spacing.sm} style={{ marginTop: 4 }}>
                  <Rating rating={p.rating} reviewCount={p.reviewCount} />
                </Row>
              </View>
              {p.baseRateTZS ? (
                <Row gap={2}>
                  <MoneyText amountTZS={p.baseRateTZS} size={FontSize.sm} bold />
                  <Text style={styles.meta}>{t('common.perHour')}</Text>
                </Row>
              ) : null}
            </Row>
          </Card>
        ))
      )}

      <Btn
        label={t('service.book')}
        onPress={() => {
          track({ name: 'category_opened', category: category.name });
          router.push({ pathname: '/book', params: { serviceId: category.id } });
        }}
        size="lg"
        disabled={providers.length === 0}
        style={{ marginTop: Spacing.lg }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text, flex: 1, textAlign: 'center' },
  name: { fontSize: FontSize.xl, fontFamily: Fonts.sansExtraBold, color: Colors.text },
  label: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sansSemibold, marginBottom: Spacing.xs },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  section: { fontSize: FontSize.lg, fontFamily: Fonts.sansExtraBold, color: Colors.text, marginBottom: Spacing.sm, marginTop: Spacing.lg },
  card: { marginBottom: Spacing.md },
  providerName: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text },
});
