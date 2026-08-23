import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

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
import type { IconName } from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
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

/* ------------------------------------------------------------------ */
/* Meituan wedding/photography flow — Provider → Portfolio → Package  */
/* → Date → Consultation → Reservation → Payment/deposit → Service     */
/* → Delivery → Review. Portfolio + packages are mock-first; the      */
/* contract carries no portfolio/bio fields yet (ProviderPublic only   */
/* name/trade/rating/...). The fallback "saveComingSoon" card stays   */
/* for empty/live states — portfolio UI renders when mock data        */
/* exists (always, for now).                                           */
/* ------------------------------------------------------------------ */

type PortfolioItem = { id: string; icon: IconName; label: string };
const MOCK_PORTFOLIO: PortfolioItem[] = [
  { id: 'pf_1', icon: 'camera-outline', label: 'Wedding Day' },
  { id: 'pf_2', icon: 'images-outline', label: 'Pre-Wedding' },
  { id: 'pf_3', icon: 'heart-outline', label: 'Couple Portrait' },
  { id: 'pf_4', icon: 'videocam-outline', label: 'Cinematic Film' },
  { id: 'pf_5', icon: 'star-outline', label: 'Editorial' },
  { id: 'pf_6', icon: 'image-outline', label: 'Destination' },
];

type PackageTier = { id: string; name: string; priceTZS: number; features: string[]; popular?: boolean };
const PACKAGE_TIERS: PackageTier[] = [
  { id: 'basic', name: 'Basic', priceTZS: 350000, features: ['4h coverage', '100 edited photos', 'Online gallery'] },
  { id: 'premium', name: 'Premium', priceTZS: 750000, features: ['8h coverage', '250 edited photos', 'Album + highlights'], popular: true },
  { id: 'luxury', name: 'Luxury', priceTZS: 1500000, features: ['Full day', '500 edited photos', 'Album, film & drone'] },
];

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
  const [selectedTier, setSelectedTier] = useState<string>('premium');

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
  const hasPortfolio = MOCK_PORTFOLIO.length > 0;

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

      {hasPortfolio ? (
        <>
          {/* Portfolio — Meituan wedding: Provider → Portfolio → Package → Date */}
          <Card style={{ gap: Spacing.md, marginTop: Spacing.md }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.sectionTitle}>Portfolio</Text>
              <Pill label={`${MOCK_PORTFOLIO.length} works`} tone="neutral" />
            </Row>
            <View style={styles.portfolioGrid}>
              {MOCK_PORTFOLIO.map((item) => (
                <View
                  key={item.id}
                  style={styles.portfolioItem}
                  accessibilityRole="image"
                  accessibilityLabel={item.label}
                >
                  <Icon name={item.icon} size={28} color={Colors.textTertiary} />
                  <Text style={styles.portfolioLabel} numberOfLines={1}>{item.label}</Text>
                </View>
              ))}
            </View>
            <Text style={styles.portfolioHint}>Sample works — consultation tailors the shoot to your wedding vision</Text>
          </Card>

          {/* Package tiers — Basic / Premium / Luxury (Meituan wedding packages) */}
          <Card style={{ gap: Spacing.md, marginTop: Spacing.md }}>
            <Text style={styles.sectionTitle}>Packages</Text>
            <Text style={styles.packageHint}>Choose a tier — your photographer will confirm the date and details in consultation</Text>
            {PACKAGE_TIERS.map((pkg) => {
              const selected = selectedTier === pkg.id;
              return (
                <Pressable
                  key={pkg.id}
                  onPress={() => setSelectedTier(pkg.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`${pkg.name} package`}
                  accessibilityState={{ selected }}
                  style={({ pressed }) => [
                    styles.packageCard,
                    selected && styles.packageCardSelected,
                    pressed && { opacity: 0.88 },
                  ]}
                >
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Row gap={Spacing.sm}>
                      <Text style={[styles.packageName, selected && styles.packageNameSelected]}>{pkg.name}</Text>
                      {pkg.popular ? <Pill label="Popular" tone="success" /> : null}
                    </Row>
                    <MoneyText amountTZS={pkg.priceTZS} size={FontSize.md} bold />
                  </Row>
                  <View style={{ gap: 4, marginTop: Spacing.xs }}>
                    {pkg.features.map((feat) => (
                      <Row key={feat} gap={6}>
                        <Icon name="checkmark-circle" size={14} color={selected ? Colors.primary : Colors.textTertiary} />
                        <Text style={styles.packageFeature}>{feat}</Text>
                      </Row>
                    ))}
                  </View>
                </Pressable>
              );
            })}
          </Card>

          {/* Consultation CTA — Meituan wedding: Date → Consultation → Reservation → Payment */}
          <Btn
            label="Book Consultation"
            icon="chatbubbles-outline"
            onPress={() => {
              if (!bookableServiceId) return;
              track({ name: 'category_opened', category: provider.trade });
              router.push({ pathname: '/book', params: { providerId: provider.id, serviceId: bookableServiceId } });
            }}
            disabled={!bookableServiceId}
            size="lg"
            style={{ marginTop: Spacing.lg }}
          />
          {!bookableServiceId ? (
            <Text style={styles.note}>{t('provider.selectServiceFirst')}</Text>
          ) : (
            <Text style={styles.consultHint}>Free 15-min consultation — confirm date, package, and delivery before deposit</Text>
          )}
        </>
      ) : null}

      {/* Fallback when portfolio is empty (live contract with no portfolio yet) — honest marker, no fakes. */}
      {!hasPortfolio ? (
        <Card style={{ gap: Spacing.sm, marginTop: Spacing.md }}>
          <Row gap={Spacing.sm}>
            <Icon name="bookmark-outline" size={16} color={Colors.textTertiary} />
            <Text style={styles.meta}>{t('provider.saveComingSoon')}</Text>
          </Row>
        </Card>
      ) : null}

      {bookableServiceId ? (
        <Btn
          label={t('booking.confirm')}
          onPress={() => {
            track({ name: 'category_opened', category: provider.trade });
            router.push({ pathname: '/book', params: { providerId: provider.id, serviceId: bookableServiceId } });
          }}
          size="lg"
          style={{ marginTop: Spacing.md }}
        />
      ) : (
        <>
          <Btn label={t('booking.confirm')} disabled size="lg" style={{ marginTop: Spacing.lg }} />
          <Text style={styles.note}>{t('provider.selectServiceFirst')}</Text>
          <Btn
            label={t('provider.browseServices')}
            onPress={() => router.push('/nearby')}
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
  meta: { fontSize: FontSize.xs, color: Colors.textSecondary, fontFamily: Fonts.sans, marginTop: 2 },
  note: { fontSize: FontSize.xs, color: Colors.textSecondary, fontFamily: Fonts.sans, textAlign: 'center', marginTop: Spacing.lg },
  consultHint: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, textAlign: 'center', marginTop: Spacing.sm },
  preferenceDivider: {
    marginTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  sectionTitle: { fontSize: FontSize.md, fontFamily: Fonts.sansBold, color: Colors.text },
  portfolioGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
  },
  portfolioItem: {
    width: '31%',
    aspectRatio: 1,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs,
    padding: Spacing.sm,
  },
  portfolioLabel: { fontSize: 11, color: Colors.textSecondary, fontFamily: Fonts.sansSemibold, textAlign: 'center' },
  portfolioHint: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, textAlign: 'center' },
  packageHint: { fontSize: FontSize.xs, color: Colors.textSecondary, fontFamily: Fonts.sans },
  packageCard: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    padding: Spacing.md,
    backgroundColor: Colors.card,
    gap: Spacing.xs,
  },
  packageCardSelected: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primarySoft,
  },
  packageName: { fontSize: FontSize.md, fontFamily: Fonts.sansBold, color: Colors.text },
  packageNameSelected: { color: Colors.primaryDeep },
  packageFeature: { fontSize: FontSize.xs, color: Colors.textSecondary, fontFamily: Fonts.sans },
});
