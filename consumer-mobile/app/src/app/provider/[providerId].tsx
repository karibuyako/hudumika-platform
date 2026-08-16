import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  Btn,
  Card,
  ErrorState,
  Icon,
  MoneyText,
  Pill,
  Rating,
  Row,
  Screen,
  SkeletonCard,
  ToggleRow,
} from '@/components/ui';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { track } from '@/lib/analytics';
import { idempotencyKey } from '@/lib/idempotency';
import { getProvidersRepository } from '@/repos';
import { toast } from '@/store/ui';
import type { ProviderPublic, ServiceCategoryConfig } from '@hudumika/contract';

/** Map the provider's trade to its service category so "Book" uses a REAL
 * serviceId (ProviderPublic carries no service ids — the contract's
 * provider services live behind /providers/me/*). Exact trade↔category match
 * first; when the trade has no category (e.g. the seeded "Plumber" trade vs
 * the "Plumbing" category), fall back to the first service category — the
 * same derivation the services tab uses. Only an empty category list leaves
 * Book disabled ("select a service first"). */
function serviceIdForTrade(provider: ProviderPublic, categories: ServiceCategoryConfig[]): string | undefined {
  const match = categories.find((c) => c.name.toLowerCase() === provider.trade.toLowerCase());
  return match?.id ?? categories[0]?.id;
}

export default function ProviderDetailScreen() {
  const router = useRouter();
  const { providerId } = useLocalSearchParams<{ providerId: string }>();
  const [provider, setProvider] = useState<ProviderPublic | null>(null);
  const [categories, setCategories] = useState<ServiceCategoryConfig[]>([]);
  const [error, setError] = useState('');
  // null until the preferred list resolves — hides the toggle against a live
  // backend that has not shipped the mock-only preference surface
  // (docs/CONTRACT-ADDITIONS.md #21).
  const [preferred, setPreferred] = useState<boolean | null>(null);
  const [preferenceBusy, setPreferenceBusy] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const [detail, services, preferredList] = await Promise.all([
        getProvidersRepository().get(providerId),
        getProvidersRepository().listServices(),
        getProvidersRepository().listPreferred().catch(() => null),
      ]);
      setProvider(detail);
      setCategories(services);
      setPreferred(preferredList ? preferredList.some((p) => p.id === providerId) : null);
    } catch {
      setError(t('common.error'));
    }
  }, [providerId]);

  useEffect(() => {
    load();
  }, [load]);

  const togglePreferred = async (value: boolean) => {
    setPreferenceBusy(true);
    try {
      await getProvidersRepository().setPreferred(providerId, value, idempotencyKey('cus_1', 'set-preferred'));
      setPreferred(value);
      toast(value ? t('providers.setPreferred') : t('providers.removePreferred'), 'success');
    } catch {
      toast(t('common.error'), 'error');
    } finally {
      setPreferenceBusy(false);
    }
  };

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (!provider) {
    return (
      <Screen>
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={2} />
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  const bookableServiceId = serviceIdForTrade(provider, categories);

  return (
    <Screen scroll>
      <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
        <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
      </Row>

      <Card>
        <Row gap={Spacing.lg}>
          <View style={styles.avatar}>
            <Icon name="person" size={28} color={Colors.textSecondary} />
          </View>
          <View style={{ flex: 1 }}>
            <Row gap={6}>
              <Text style={styles.name} numberOfLines={1}>{provider.name}</Text>
              {provider.verified ? <Icon name="shield-checkmark" size={16} color={Colors.success} /> : null}
            </Row>
            <Text style={styles.meta}>{provider.trade}</Text>
            <Row gap={Spacing.sm} style={{ marginTop: 4 }}>
              <Rating rating={provider.rating} reviewCount={provider.reviewCount} />
            </Row>
          </View>
        </Row>
        <Row gap={Spacing.sm} style={{ marginTop: Spacing.md }}>
          {provider.verified ? <Pill label={t('provider.verified')} tone="success" /> : null}
          {(provider.serviceAreas ?? []).map((area) => (
            <Pill key={area} label={area} tone="info" />
          ))}
        </Row>
        {provider.baseRateTZS ? (
          <Row style={{ justifyContent: 'space-between', marginTop: Spacing.lg }}>
            <Text style={styles.meta}>{t('booking.estimate')}</Text>
            <Row gap={2}>
              <MoneyText amountTZS={provider.baseRateTZS} size={FontSize.md} bold />
              <Text style={styles.meta}>{t('common.perHour')}</Text>
            </Row>
          </Row>
        ) : null}
        {preferred !== null ? (
          <View style={styles.preferenceDivider}>
            <ToggleRow
              label={t('providers.preferred')}
              value={preferred}
              onChange={togglePreferred}
              disabled={preferenceBusy}
            />
          </View>
        ) : null}
      </Card>

      {/* Provider portfolio / bio / certifications are not in the contract yet
          (ProviderPublic: name/trade/rating/reviewCount/verified/serviceAreas/
          baseRateTZS; favorites are merchant-only) — honest marker, no fakes. */}
      <Card style={{ gap: Spacing.sm, marginTop: Spacing.md }}>
        <Row gap={Spacing.sm}>
          <Icon name="bookmark-outline" size={16} color={Colors.textTertiary} />
          <Text style={styles.meta}>{t('provider.saveComingSoon')}</Text>
        </Row>
      </Card>

      {bookableServiceId ? (
        <Btn
          label={t('booking.confirm')}
          onPress={() => {
            track({ name: 'category_opened', category: provider.trade });
            router.push({ pathname: '/book', params: { providerId: provider.id, serviceId: bookableServiceId } });
          }}
          size="lg"
          style={{ marginTop: Spacing.lg }}
        />
      ) : (
        <>
          <Btn label={t('booking.confirm')} disabled size="lg" style={{ marginTop: Spacing.lg }} />
          <Text style={styles.note}>{t('provider.selectServiceFirst')}</Text>
          <Btn
            label={t('provider.browseServices')}
            onPress={() => router.push('/(tabs)/services')}
            variant="ghost"
            size="sm"
            style={{ alignSelf: 'center', marginTop: Spacing.sm }}
          />
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { fontSize: FontSize.xl, fontFamily: Fonts.sansExtraBold, color: Colors.text, flex: 1 },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  note: { fontSize: FontSize.xs, color: Colors.textFaint, fontFamily: Fonts.sans, textAlign: 'center', marginTop: Spacing.lg },
  preferenceDivider: {
    marginTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
});
