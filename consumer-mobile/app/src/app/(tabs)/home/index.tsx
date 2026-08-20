import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  MoneyText,
  Pill,
  Rating,
  Row,
  Screen,
  SectionTitle,
  Skeleton,
  SkeletonCard,
  StatusPill,
  type IconName,
} from '@/components/ui';
import { LocationPermissionSheet } from '@/components/LocationPermissionSheet';
import { CartBar } from '@/components/CartBar';
import { useDealClock } from '@/components/DealCountdown';
import { FlashDealCard } from '@/components/FlashDealCard';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { formatTZS } from '@/lib/format';
import { selectFlashDeals } from '@/lib/flash';
import { CURATED_LISTS, resolveList } from '@/lib/lists';
import { GeoError, reverseGeocode, type GeoPosition } from '@/lib/geolocation';
import { getHomeRepository, getFavoritesRepository, getMerchantsRepository, getGroupBuyRepository, getMarketingRepository, canShowRecommendations, type RecommendedMerchant } from '@/repos';
import { track } from '@/lib/analytics';
import { useLocationStore } from '@/store/location';
import { useSessionStore } from '@/store/session';
import { useCartStore } from '@/store/cart';
import { useConsentStore } from '@/store/consent';
import { toast } from '@/store/ui';
import { LiveDealSessionStatus, PromotionType } from '@hudumika/contract';
import type { GetConsumerHome200, GroupBuyDeal, LiveDealSession, MerchantPublic, OrderDetail } from '@hudumika/contract';

const CATEGORY_ICONS: Record<string, IconName> = {
  Food: 'restaurant',
  Groceries: 'cart',
  Pharmacy: 'medkit',
  'Home Services': 'construct',
  Beauty: 'sparkles',
  Laundry: 'shirt',
  Repairs: 'hammer',
  Logistics: 'cube',
  Rides: 'car',
  Events: 'ticket',
  Retail: 'bag-handle',
  Travel: 'airplane',
};

/* Campaign pill is fetched per merchant (the feed carries platform promotions
 * only — no per-merchant campaigns); cap the fetch to the first visible cards
 * so the home list never fans out N+1 queries. */
const CAMPAIGN_FETCH_LIMIT = 6;

export default function HomeScreen() {
  const router = useRouter();
  const [feed, setFeed] = useState<GetConsumerHome200 | null>(null);
  const [flashDeals, setFlashDeals] = useState<GroupBuyDeal[] | null>(null);
  const [liveSessions, setLiveSessions] = useState<LiveDealSession[]>([]);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [sheetVisible, setSheetVisible] = useState(false);
  const [detectError, setDetectError] = useState('');
  const [promoIndex, setPromoIndex] = useState(0);
  const [campaigns, setCampaigns] = useState<Record<string, string>>({});
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const campaignFetch = useRef<Set<string>>(new Set());
  const { width } = useWindowDimensions();
  const promoCardWidth = width - Spacing.lg * 2 - 56;
  const now = useDealClock();
  const city = useLocationStore((s) => s.city);
  const user = useSessionStore((s) => s.user);

  /* Personalization (MASTER-BLUEPRINT §5, docs/CONTRACT-ADDITIONS.md #25):
   * the "Recommended for you" rail is consent-gated on the personalization
   * purpose (src/store/consent.ts — READ-ONLY). Without consent the section
   * renders an honest "Enable recommendations" hint into /privacy instead of
   * pretending; with consent the repo drives loading/error/retry. */
  const personalizationConsent = useConsentStore((s) => s.consents.personalization);
  const [recommendations, setRecommendations] = useState<RecommendedMerchant[] | null>(null);
  const [recommendationsError, setRecommendationsError] = useState('');

  const loadRecommendations = useCallback(async () => {
    if (!canShowRecommendations(personalizationConsent)) return;
    setRecommendationsError('');
    try {
      setRecommendations(await getHomeRepository().getRecommendations());
    } catch {
      setRecommendationsError(t('home.recommendedError'));
    }
  }, [personalizationConsent]);

  useEffect(() => {
    if (!canShowRecommendations(personalizationConsent)) {
      // Consent revoked — drop any served data: the section must not linger.
      setRecommendations(null);
      setRecommendationsError('');
      return;
    }
    void loadRecommendations();
  }, [loadRecommendations, personalizationConsent]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setError('');
    try {
      // Feed + flash-deal source in one pass: the flash rail needs live
      // group-buy deals (src/lib/flash.ts — the contract's FlashSale resource
      // has no repo surface yet), so both load together. Live-deals sessions
      // (GET /marketing/live-deals) feed the "Live now" banner below.
      const [data, deals, live] = await Promise.all([
        getHomeRepository().getHomeFeed(),
        getGroupBuyRepository().list(),
        getMarketingRepository().listLiveDeals(),
      ]);
      setFeed(data);
      setFlashDeals(deals);
      setLiveSessions(live.sessions.filter((s) => s.status === LiveDealSessionStatus.live));
    } catch {
      if (!silent) setError(t('home.error'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Favorite hearts — reload whenever the tab regains focus so a heart
  // toggled on the merchant detail page is reflected on the cards.
  const loadFavorites = useCallback(async () => {
    try {
      const favs = await getFavoritesRepository().list();
      setFavoriteIds(new Set(favs.map((f) => f.id)));
    } catch {
      /* non-fatal — hearts start hollow */
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadFavorites();
    }, [loadFavorites]),
  );

  const toggleFavorite = async (merchant: MerchantPublic) => {
    const isFav = favoriteIds.has(merchant.id);
    setFavoriteIds((prev) => {
      const next = new Set(prev);
      if (isFav) next.delete(merchant.id);
      else next.add(merchant.id);
      return next;
    });
    try {
      if (isFav) await getFavoritesRepository().remove(merchant.id, `fav-${merchant.id}-${Date.now()}`);
      else await getFavoritesRepository().add(merchant.id, `fav-${merchant.id}-${Date.now()}`);
    } catch {
      setFavoriteIds((prev) => {
        const next = new Set(prev);
        if (isFav) next.add(merchant.id);
        else next.delete(merchant.id);
        return next;
      });
    }
  };

  // Per-merchant coupon campaigns for the first visible cards only (the home
  // feed has platform promotions, not per-merchant ones). One fetch per card,
  // memoized by merchant id; failures just leave the pill hidden.
  useEffect(() => {
    const merchants = (feed?.merchants ?? []).slice(0, CAMPAIGN_FETCH_LIMIT);
    for (const m of merchants) {
      if (campaignFetch.current.has(m.id)) continue;
      campaignFetch.current.add(m.id);
      getMerchantsRepository()
        .getPromotions(m.id)
        .then((promos) => {
          const live = promos.find((p) => p.type === PromotionType.coupon && p.status === 'live');
          const title = live?.title ?? '';
          setCampaigns((prev) => (prev[m.id] === title ? prev : { ...prev, [m.id]: title }));
        })
        .catch(() => {});
    }
  }, [feed]);

  const onPromoScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const index = Math.round(e.nativeEvent.contentOffset.x / (promoCardWidth + Spacing.md));
    setPromoIndex(Math.max(0, Math.min(index, (feed?.promotions ?? []).length - 1)));
  };

  useEffect(() => {
    track({ name: 'home_viewed', cityId: city?.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await load(true);
    void loadRecommendations();
    setRefreshing(false);
  };

  // GPS detect (same flow as the city picker): permission sheet → fix →
  // nearest seeded city → update the location store (service area included).
  const onDetected = async (position: GeoPosition) => {
    setSheetVisible(false);
    setDetectError('');
    try {
      const list = await getHomeRepository().listCities();
      const result = await reverseGeocode(position.lat, position.lon, list);
      const matched = result.cityId ? list.find((c) => c.id === result.cityId) : undefined;
      if (!matched) {
        setDetectError(t('location.notFound'));
        return;
      }
      useLocationStore.getState().setCity({
        id: matched.id,
        name: matched.name,
        serviceArea: result.serviceArea,
        serviceAreas: matched.serviceAreas,
      });
      toast(t('location.detectedArea', { area: result.serviceArea ?? matched.name }));
    } catch {
      setDetectError(t('location.unavailable'));
    }
  };

  const onGeoError = (e: GeoError) => {
    setSheetVisible(false);
    setDetectError(e.code === 'PERMISSION_DENIED' ? t('location.permissionDenied') : t('location.unavailable'));
  };

  const renderMerchant = ({ item }: { item: MerchantPublic }) => {
    const isFav = favoriteIds.has(item.id);
    return (
      <Card style={styles.merchantCard} onPress={() => router.push(`/merchant/${item.id}`)} accessibilityLabel={t('home.merchantLabel', { name: item.businessName })}>
        <Row gap={Spacing.md}>
          <View style={styles.merchantLogo}>
            <Icon name="storefront" size={20} color={Colors.textSecondary} />
          </View>
          <View style={{ flex: 1 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.merchantName} numberOfLines={1}>{item.businessName}</Text>
              <Row gap={Spacing.sm}>
                {campaigns[item.id] ? (
                  <View style={styles.campaignPill} accessibilityLabel={t('home.campaignA11y', { title: campaigns[item.id] })}>
                    <Text style={styles.campaignPillText} numberOfLines={1}>{campaigns[item.id]}</Text>
                  </View>
                ) : null}
                <Pill label={item.isOpen ? t('merchant.open') : t('merchant.closed')} tone={item.isOpen ? 'success' : 'danger'} />
              </Row>
            </Row>
            <Row gap={Spacing.sm} style={{ marginTop: 4 }}>
              <Rating rating={item.rating} reviewCount={item.reviewCount} />
              {item.deliveryMinutes ? (
                <Text style={styles.merchantMeta}>{t('order.estimated', { m: item.deliveryMinutes })}</Text>
              ) : null}
            </Row>
          </View>
        </Row>
        <Pressable
          onPress={() => toggleFavorite(item)}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={isFav ? t('favorite.remove') : t('favorite.add')}
          style={styles.heartOverlay}>
          <Icon name={isFav ? 'heart' : 'heart-outline'} size={20} color={isFav ? Colors.danger : Colors.textTertiary} />
        </Pressable>
      </Card>
    );
  };

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={() => load()} />
      </Screen>
    );
  }

  if (!feed) {
    return (
      <Screen>
        <View style={{ paddingHorizontal: Spacing.lg }}>
          <SectionTitle title={t('home.categories')} icon="grid" />
          <SkeletonCard rows={3} />
          <SectionTitle title={t('home.promotions')} icon="pricetag" />
          <SkeletonCard rows={2} />
          <SectionTitle title={t('home.flashDeals')} icon="timer" />
          <SkeletonCard rows={1} />
          <SectionTitle title={t('lists.title')} icon="trophy" />
          <SkeletonCard rows={1} />
          <SectionTitle title={t('home.nearby')} icon="storefront" />
          <SkeletonCard rows={2} />
          <SkeletonCard rows={2} />
        </View>
      </Screen>
    );
  }

  const activeOrder = (feed.recentOrders ?? []).find((o) => ['paid', 'merchant_accepted', 'preparing', 'rider_assigned', 'picked_up', 'delivering'].includes(o.status));

  /* Quick actions — reorder from the most recent order, track the active one,
   * scan a table QR (dine-in), or browse coupons. */
  const recentOrder = (feed.recentOrders ?? [])[0];
  const canReorder = !!recentOrder && ((recentOrder as OrderDetail).items?.length ?? 0) > 0;

  const reorderMostRecent = () => {
    if (!canReorder || !recentOrder) return;
    const merchantName = feed.merchants?.find((m) => m.id === recentOrder.merchantId)?.businessName ?? t('common.merchant');
    const cart = useCartStore.getState();
    for (const item of (recentOrder as OrderDetail).items ?? []) {
      cart.addItem(
        { merchantId: recentOrder.merchantId, merchantName },
        { catalogueItemId: item.catalogueItemId, name: item.name, unitPriceTZS: item.unitPriceTZS, quantity: item.quantity },
      );
    }
    router.push('/cart');
  };

  const quickActions: { key: string; label: string; icon: IconName; onPress?: () => void; disabled?: boolean }[] = [
    { key: 'reorder', label: t('home.quick.reorder'), icon: 'repeat', onPress: reorderMostRecent, disabled: !canReorder },
    { key: 'track', label: t('home.quick.track'), icon: 'navigate', onPress: activeOrder ? () => router.push(`/order/${activeOrder.id}/tracking`) : undefined, disabled: !activeOrder },
    { key: 'scan', label: t('home.quick.scan'), icon: 'qr-code-outline', onPress: () => router.push('/dine-in') },
    { key: 'coupons', label: t('home.quick.coupons'), icon: 'pricetags', onPress: () => router.push('/coupons') },
    { key: 'assistant', label: t('home.quick.assistant'), icon: 'chatbubble-ellipses', onPress: () => router.push('/assistant') },
  ];

  return (
    <Screen>
      <FlatList
        data={feed.merchants ?? []}
        keyExtractor={(m) => m.id}
        renderItem={renderMerchant}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} colors={[Colors.primary]} />}
        refreshing={refreshing}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 96 }}
        ListHeaderComponent={
          <View style={{ paddingHorizontal: Spacing.lg }}>
            <Row style={{ justifyContent: 'space-between', marginTop: Spacing.md }}>
              <View style={{ flex: 1 }}>
                <Row gap={6}>
                  <Icon name="location" size={14} color={Colors.primary} />
                  <Text style={styles.cityLabel}>{t('home.location')}</Text>
                </Row>
                <Row gap={Spacing.sm}>
                  <Text style={styles.cityName}>{city?.name ?? t('onboard.title')}</Text>
                  <Pressable
                    onPress={() => setSheetVisible(true)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('location.detectA11y')}>
                    <Icon name="locate" size={16} color={Colors.primaryDeep} />
                  </Pressable>
                </Row>
                {city?.serviceArea ? <Text style={styles.cityArea}>{city.serviceArea}</Text> : null}
                {detectError ? <Text style={styles.detectError}>{detectError}</Text> : null}
              </View>
              <Row gap={Spacing.sm}>
                <Pressable onPress={() => router.push('/notifications')} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('notifications.title')} style={styles.bellWrap}>
                  <Icon name="notifications-outline" size={22} color={Colors.text} />
                  {feed.unreadCount ? (
                    <View style={styles.bellBadge}>
                      <Badge count={feed.unreadCount} />
                    </View>
                  ) : null}
                </Pressable>
              </Row>
            </Row>

            {user?.fullName ? <Text style={styles.greeting}>{t('home.greeting', { name: user.fullName.split(' ')[0] })}</Text> : null}

            <Pressable
              onPress={() => router.push('/search')}
              accessibilityRole="button"
              accessibilityLabel={t('search.placeholder')}
              style={({ pressed }) => [styles.searchBar, pressed && { opacity: 0.8 }]}>
              <Icon name="search" size={18} color={Colors.textTertiary} />
              <Text style={styles.searchText}>{t('home.search')}</Text>
            </Pressable>

            {feed.membership ? (
              <Card
                onPress={() => router.push('/membership')}
                accessibilityLabel={t('membership.title')}
                style={{ marginTop: Spacing.md }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Row gap={Spacing.md}>
                    <View style={styles.membershipIcon}>
                      <Icon name="ribbon" size={20} color={Colors.gold} />
                    </View>
                    <View>
                      <Text style={styles.membershipLevel}>{feed.membership.level}</Text>
                      <Text style={styles.membershipPoints}>{t('membership.points', { n: feed.membership.points })}</Text>
                    </View>
                  </Row>
                  <Row gap={4}>
                    <Text style={styles.membershipView}>{t('common.view')}</Text>
                    <Icon name="chevron-forward" size={15} color={Colors.textTertiary} />
                  </Row>
                </Row>
              </Card>
            ) : null}

            {(feed.recentOrders ?? []).length > 0 ? (
              <>
                <SectionTitle title={t('home.recentOrders')} icon="repeat" />
                <FlatList
                  horizontal
                  data={feed.recentOrders ?? []}
                  keyExtractor={(o) => o.id}
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: Spacing.md }}
                  renderItem={({ item: o }) => (
                    <Card style={styles.recentCard} onPress={() => router.push(`/order/${o.id}`)}>
                      <Text style={styles.recentNo} numberOfLines={1}>{o.no ?? o.id}</Text>
                      <StatusPill status={o.status} />
                      <MoneyText amountTZS={o.totals.totalTZS} size={FontSize.sm} bold />
                    </Card>
                  )}
                />
              </>
            ) : null}

            <View style={styles.quickActions}>
              {quickActions.map((qa) => (
                <Pressable
                  key={qa.key}
                  onPress={qa.onPress}
                  disabled={qa.disabled}
                  accessibilityRole="button"
                  accessibilityLabel={qa.label}
                  accessibilityState={qa.disabled ? { disabled: true } : undefined}
                  style={({ pressed }) => [styles.quickAction, qa.disabled && styles.quickActionDisabled, pressed && !qa.disabled && { opacity: 0.8 }]}>
                  <View style={[styles.quickActionIcon, qa.disabled && styles.quickActionIconDisabled]}>
                    <Icon name={qa.icon} size={20} color={qa.disabled ? Colors.textTertiary : Colors.primaryDeep} />
                  </View>
                  <Text style={[styles.quickActionLabel, qa.disabled && styles.quickActionLabelDisabled]}>{qa.label}</Text>
                </Pressable>
              ))}
            </View>

            {activeOrder ? (
              <Card
                onPress={() => router.push(`/order/${activeOrder.id}`)}
                style={{ backgroundColor: Colors.primarySoft, marginTop: Spacing.md }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Row gap={Spacing.sm}>
                    <Icon name="bicycle" size={20} color={Colors.primaryDeep} />
                    <Text style={{ color: Colors.primaryDeep, fontSize: FontSize.md, fontFamily: Fonts.sansBold }}>
                      {t('order.title')} {activeOrder.no ?? ''}
                    </Text>
                  </Row>
                  <StatusPill status={activeOrder.status} />
                </Row>
                <Text style={{ color: Colors.primaryDeep, fontSize: FontSize.xs, fontFamily: Fonts.sans, marginTop: 4 }}>
                  {t('order.track')} ›
                </Text>
              </Card>
            ) : null}

            <SectionTitle title={t('home.categories')} icon="grid" />
            <View style={styles.categoryGrid}>
              {(feed.categories ?? []).slice(0, 8).map((cat) => {
                const icon = CATEGORY_ICONS[cat.name] ?? 'grid-outline';
                return (
                  <Pressable
                    key={cat.id}
                    onPress={() => router.push({ pathname: '/search', params: { category: cat.name } })}
                    accessibilityRole="button"
                    accessibilityLabel={cat.name}
                    style={styles.categoryItem}>
                    <View style={styles.categoryIcon}>
                      <Icon name={icon} size={20} color={Colors.primaryDeep} />
                    </View>
                    <Text style={styles.categoryName} numberOfLines={2}>{cat.name}</Text>
                  </Pressable>
                );
              })}
            </View>

            <SectionTitle title={t('home.promotions')} icon="pricetag" />
            {(feed.promotions ?? []).length > 0 ? (
              <>
                <FlatList
                  horizontal
                  data={feed.promotions ?? []}
                  keyExtractor={(p) => p.id ?? p.title}
                  showsHorizontalScrollIndicator={false}
                  snapToInterval={promoCardWidth + Spacing.md}
                  decelerationRate="fast"
                  onMomentumScrollEnd={onPromoScrollEnd}
                  contentContainerStyle={{ gap: Spacing.md }}
                  renderItem={({ item: p }) => (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('home.promoA11y', { title: p.title })}
                      style={({ pressed }) => [pressed && { opacity: 0.85 }]}>
                      <View style={[styles.promoCard, { width: promoCardWidth, backgroundColor: Colors.primaryDeep }]}>
                        <View style={{ flex: 1, gap: 4 }}>
                          <Text style={{ color: Colors.white, fontSize: FontSize.md, fontFamily: Fonts.sansBold }}>{p.title}</Text>
                          <Text style={{ color: Colors.gold, fontSize: FontSize.xs, fontFamily: Fonts.sansMedium }}>{p.description}</Text>
                        </View>
                        <Icon name="pricetag" size={22} color={Colors.gold} />
                      </View>
                    </Pressable>
                  )}
                />
                {(feed.promotions ?? []).length > 1 ? (
                  <Row style={styles.pageDots}>
                    {(feed.promotions ?? []).map((p, i) => (
                      <View key={p.id ?? p.title} style={[styles.dot, i === promoIndex && styles.dotActive]} />
                    ))}
                  </Row>
                ) : null}
              </>
            ) : (
              <EmptyState icon="pricetag-outline" title={t('home.emptyPromos')} />
            )}

            {/* Flash deals (神抢手-lite) — live group-buy sales ending soon
                (src/lib/flash.ts). Hidden entirely when none qualify
                (per-section honesty: no deals, no section). */}
            {flashDeals === null ? (
              <>
                <SectionTitle title={t('home.flashDeals')} icon="timer" />
                <Row style={{ gap: Spacing.md }}>
                  <Card style={styles.flashSkeleton}><Skeleton height={14} width="80%" /></Card>
                  <Card style={styles.flashSkeleton}><Skeleton height={14} width="60%" /></Card>
                </Row>
              </>
            ) : selectFlashDeals(flashDeals, now).length > 0 ? (
              <>
                <SectionTitle title={t('home.flashDeals')} icon="timer" />
                <FlatList
                  horizontal
                  data={selectFlashDeals(flashDeals, now)}
                  keyExtractor={(d) => d.id ?? d.title}
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: Spacing.md }}
                  renderItem={({ item }) => (
                    <FlashDealCard deal={item} now={now} onPress={() => router.push(`/group-buys/${item.id}`)} />
                  )}
                />
              </>
            ) : null}

            {/* Live deals zone (神抢手-lite sessions) — a "Live now" banner
                into the full zone when a session is running (GET
                /marketing/live-deals; per-section honesty: no live session,
                no banner). */}
            {liveSessions.length > 0 ? (
              <Pressable
                onPress={() => router.push('/live-deals')}
                accessibilityRole="button"
                accessibilityLabel={t('liveDeals.title')}
                style={({ pressed }) => [pressed && { opacity: 0.85 }]}>
                <View style={styles.liveBanner}>
                  <Row gap={Spacing.sm}>
                    <Icon name="radio" size={18} color={Colors.danger} />
                    <Text style={styles.liveBannerTitle} numberOfLines={1}>{liveSessions[0].title}</Text>
                  </Row>
                  <Row gap={4}>
                    <View style={styles.liveDot} />
                    <Text style={styles.liveBannerCta}>{t('liveDeals.liveNow')}</Text>
                    <Icon name="chevron-forward" size={15} color={Colors.danger} />
                  </Row>
                </View>
              </Pressable>
            ) : null}

            {/* Curated lists (必吃榜-lite) — demo seed in src/lib/lists.ts;
                production feeds this rail from a Lists API. */}
            <SectionTitle title={t('lists.title')} icon="trophy" />
            <FlatList
              horizontal
              data={CURATED_LISTS}
              keyExtractor={(l) => l.id}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: Spacing.md }}
              renderItem={({ item }) => {
                const resolved = resolveList(item.id, feed.merchants ?? []);
                return (
                  <Card
                    style={styles.listCard}
                    onPress={() => router.push(`/list/${item.id}`)}
                    accessibilityLabel={t(item.titleKey)}>
                    <Text style={styles.listCardTitle} numberOfLines={2}>{t(item.titleKey)}</Text>
                    <Text style={styles.listCardTagline} numberOfLines={2}>{t(item.taglineKey)}</Text>
                    <Row style={{ justifyContent: 'space-between', marginTop: 'auto' }}>
                      <Text style={styles.listCardMeta}>{t('lists.merchants', { n: resolved?.merchants.length ?? 0 })}</Text>
                      <Text style={styles.listCardView}>{t('lists.viewAll')} ›</Text>
                    </Row>
                  </Card>
                );
              }}
            />

            {/* Recommended for you (MASTER-BLUEPRINT §5 personalization,
                docs/CONTRACT-ADDITIONS.md #25, mock-only-until-adopted).
                Consent-gated: without the personalization purpose the section
                renders nothing but an honest "Enable recommendations" hint
                into /privacy (recommendations require consent per the
                blueprint); with consent it shows a per-section skeleton,
                error/retry, or the horizontal rail. The reason caption is
                SERVER copy — rendered verbatim, never through i18n. */}
            {canShowRecommendations(personalizationConsent) ? (
              recommendations === null ? (
                <>
                  <SectionTitle title={t('home.recommended')} icon="star" />
                  <Row style={{ gap: Spacing.md }}>
                    <Card style={styles.recSkeleton}><Skeleton height={14} width="80%" /></Card>
                    <Card style={styles.recSkeleton}><Skeleton height={14} width="60%" /></Card>
                  </Row>
                </>
              ) : recommendationsError ? (
                <>
                  <SectionTitle title={t('home.recommended')} icon="star" />
                  <ErrorState message={recommendationsError} onRetry={() => void loadRecommendations()} />
                </>
              ) : recommendations.length > 0 ? (
                <>
                  <SectionTitle title={t('home.recommended')} icon="star" />
                  <FlatList
                    horizontal
                    data={recommendations}
                    keyExtractor={(r) => r.merchantId}
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{ gap: Spacing.md }}
                    renderItem={({ item }) => (
                      <Card
                        style={styles.recCard}
                        onPress={() => router.push(`/merchant/${item.merchantId}`)}
                        accessibilityLabel={t('home.recommendedA11y', { name: item.businessName })}>
                        <Text style={styles.recName} numberOfLines={1}>{item.businessName}</Text>
                        <Rating rating={item.rating} reviewCount={item.reviewCount} />
                        <Text style={styles.recReason} numberOfLines={2}>{item.reason}</Text>
                        {item.deliveryMinutes ? (
                          <Text style={styles.recMeta}>{t('order.estimated', { m: item.deliveryMinutes })}</Text>
                        ) : null}
                      </Card>
                    )}
                  />
                </>
              ) : null
            ) : (
              <Pressable
                onPress={() => router.push('/privacy')}
                accessibilityRole="button"
                accessibilityLabel={t('home.enableRecommendations')}
                style={({ pressed }) => [styles.enableRow, pressed && { opacity: 0.85 }]}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Row gap={Spacing.sm}>
                    <Icon name="sparkles" size={16} color={Colors.primaryDeep} />
                    <Text style={styles.enableRowText}>{t('home.enableRecommendations')}</Text>
                  </Row>
                  <Icon name="chevron-forward" size={15} color={Colors.textTertiary} />
                </Row>
              </Pressable>
            )}

            {(feed.providers ?? []).length > 0 ? (
              <>
                <SectionTitle title={t('home.providers')} icon="construct" />
                <View>{feed.providers!.map((p) => (
                  <Card
                    key={p.id}
                    style={styles.merchantCard}
                    onPress={() => router.push(`/provider/${p.id}`)}
                    accessibilityRole="button">
                    <Row gap={Spacing.md}>
                      <View style={styles.merchantLogo}>
                        <Icon name="person" size={20} color={Colors.textSecondary} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Row style={{ justifyContent: 'space-between' }}>
                          <Text style={styles.merchantName} numberOfLines={1}>{p.name}</Text>
                          {p.verified ? <Icon name="shield-checkmark" size={16} color={Colors.success} /> : null}
                        </Row>
                        <Row gap={Spacing.sm} style={{ marginTop: 4 }}>
                          <Text style={styles.merchantMeta}>{p.trade}</Text>
                          {p.baseRateTZS ? <Text style={styles.merchantMeta}>{formatTZS(p.baseRateTZS)}{t('common.perHour')}</Text> : null}
                        </Row>
                      </View>
                    </Row>
                  </Card>
                ))}</View>
              </>
            ) : null}

            <SectionTitle title={t('home.nearby')} icon="storefront" />
          </View>
        }
        ListEmptyComponent={
          <View style={{ paddingHorizontal: Spacing.lg }}>
            <EmptyState icon="storefront-outline" title={t('home.emptyNearby')} />
          </View>
        }
      />

      <LocationPermissionSheet visible={sheetVisible} onClose={() => setSheetVisible(false)} onDetected={onDetected} onError={onGeoError} />
      <CartBar />
    </Screen>
  );
}

const styles = StyleSheet.create({
  categoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.md,
    justifyContent: 'space-between',
  },
  categoryItem: { width: '22%', alignItems: 'center', gap: Spacing.sm, marginBottom: Spacing.md },
  categoryIcon: {
    width: 48,
    height: 48,
    borderRadius: Radius.md,
    backgroundColor: Colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryName: { fontSize: FontSize.xs, color: Colors.textSecondary, fontFamily: Fonts.sansMedium, textAlign: 'center' },
  quickActions: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.lg },
  quickAction: { flex: 1, alignItems: 'center', gap: Spacing.sm },
  quickActionDisabled: { opacity: 0.55 },
  quickActionIcon: {
    width: 48,
    height: 48,
    borderRadius: Radius.md,
    backgroundColor: Colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickActionIconDisabled: { backgroundColor: Colors.surface, opacity: 0.7 },
  quickActionLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, fontFamily: Fonts.sansMedium, textAlign: 'center' },
  quickActionLabelDisabled: { color: Colors.textTertiary },
  cityLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans },
  cityName: { fontSize: FontSize.lg, fontFamily: Fonts.sansExtraBold, color: Colors.text },
  cityArea: { fontSize: FontSize.xs, color: Colors.primaryDeep, fontFamily: Fonts.sansSemibold, marginTop: 2 },
  detectError: { color: Colors.danger, fontSize: FontSize.xs, fontFamily: Fonts.sansSemibold, marginTop: 4 },
  greeting: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.card,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    marginTop: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  searchText: { color: Colors.textTertiary, fontSize: FontSize.sm, fontFamily: Fonts.sans, flex: 1 },
  merchantCard: { marginHorizontal: Spacing.lg, marginBottom: Spacing.md },
  heartOverlay: { position: 'absolute', top: Spacing.sm, right: Spacing.sm, zIndex: 1 },
  merchantLogo: {
    width: 44,
    height: 44,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  merchantName: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text, flex: 1 },
  merchantMeta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans },
  promoCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
  },
  pageDots: { justifyContent: 'center', gap: Spacing.sm, marginTop: Spacing.sm, marginBottom: Spacing.xs },
  dot: {
    width: Spacing.sm - 2,
    height: Spacing.sm - 2,
    borderRadius: Radius.pill,
    backgroundColor: Colors.borderStrong,
  },
  dotActive: { backgroundColor: Colors.primaryDeep, width: 16 },
  membershipIcon: {
    width: 40,
    height: 40,
    borderRadius: Radius.md,
    backgroundColor: Colors.goldSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  membershipLevel: {
    fontSize: FontSize.md,
    fontFamily: Fonts.sansBold,
    color: Colors.text,
    textTransform: 'capitalize',
  },
  membershipPoints: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  membershipView: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sansMedium },
  recentCard: { width: 200, gap: Spacing.sm },
  recentNo: { fontSize: FontSize.sm, fontFamily: Fonts.sansBold, color: Colors.text },
  campaignPill: {
    maxWidth: 110,
    backgroundColor: Colors.goldSoft,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs - 1,
  },
  campaignPillText: {
    color: Colors.gold,
    fontSize: FontSize.xs,
    fontFamily: Fonts.sansBold,
    letterSpacing: 0.2,
  },
  flashSkeleton: { width: 220, gap: Spacing.sm },
  liveBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.dangerSoft,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    marginBottom: Spacing.sm,
  },
  liveBannerTitle: { flex: 1, fontSize: FontSize.sm, fontFamily: Fonts.sansBold, color: Colors.danger },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.danger },
  liveBannerCta: { color: Colors.danger, fontSize: FontSize.xs, fontFamily: Fonts.sansBold, letterSpacing: 0.3 },
  listCard: { width: 200, gap: Spacing.sm, minHeight: 130 },
  listCardTitle: { fontSize: FontSize.md, fontFamily: Fonts.sansBold, color: Colors.text },
  listCardTagline: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, lineHeight: 16 },
  listCardMeta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sansMedium },
  listCardView: { fontSize: FontSize.xs, color: Colors.primaryDeep, fontFamily: Fonts.sansBold },
  recCard: { width: 200, gap: Spacing.sm, minHeight: 110 },
  recSkeleton: { width: 200, gap: Spacing.sm },
  recName: { fontSize: FontSize.md, fontFamily: Fonts.sansBold, color: Colors.text },
  recReason: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, lineHeight: 16 },
  recMeta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 'auto' },
  enableRow: {
    backgroundColor: Colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    marginTop: Spacing.lg,
    marginBottom: Spacing.xs,
  },
  enableRowText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sansMedium },
  bellWrap: { position: 'relative', alignItems: 'center', justifyContent: 'center', padding: 4 },
  bellBadge: { position: 'absolute', top: -6, right: -8 },
});
