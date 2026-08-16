/* Review form — three entry modes:
 *   /review?orderId=…          merchant review after a delivered/completed order
 *   /review?reviewId=…         edit an existing own review (prefilled)
 *   /review?targetType=…&targetId=…   provider/rider review (Wave 8 CTA)
 *
 * Multi-dimensional ratings (professionalism, punctuality, quality,
 * communication, price transparency, cleanliness) + would-recommend are
 * ReviewCreate.dimensions — shown for home-services (provider) reviews.
 * After submit the review is `pending` until moderation (REVIEWS.md). */
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Btn, Card, EmptyState, ErrorState, Field, Icon, Pill, Row, Screen, SkeletonCard, ToggleRow } from '@/components/ui';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t, type Key } from '@/i18n';
import { toast } from '@/store/ui';
import { getMembershipsRepository, getMerchantsRepository, getOrdersRepository, getProvidersRepository, getReviewsRepository } from '@/repos';
import { track } from '@/lib/analytics';
import { useSessionStore } from '@/store/session';
import type { OrderDetail, Review, ReviewCreate, ReviewCreateTargetType } from '@hudumika/contract';
import { ApiError } from '@/api/client';
import { idempotencyKey } from '@/lib/idempotency';

/** Contract ReviewCreateTargetType values the review form can target. */
const REVIEW_TARGETS: ReviewCreateTargetType[] = ['merchant', 'provider', 'rider'];

/** ReviewCreate.dimensions — multi-dimensional ratings (home services). */
const DIMENSION_KEYS = ['professionalism', 'punctuality', 'quality', 'communication', 'priceTransparency', 'cleanliness'] as const;
type DimensionKey = (typeof DIMENSION_KEYS)[number];
type Dimensions = NonNullable<ReviewCreate['dimensions']>;

const DIMENSION_LABELS: Record<DimensionKey, Key> = {
  professionalism: 'reviews.dimensions.professionalism',
  punctuality: 'reviews.dimensions.punctuality',
  quality: 'reviews.dimensions.quality',
  communication: 'reviews.dimensions.communication',
  priceTransparency: 'reviews.dimensions.priceTransparency',
  cleanliness: 'reviews.dimensions.cleanliness',
};

export default function ReviewScreen() {
  const router = useRouter();
  const { orderId, reviewId, targetType, targetId } = useLocalSearchParams<{
    orderId?: string;
    reviewId?: string;
    targetType?: string;
    targetId?: string;
  }>();
  const user = useSessionStore((s) => s.user);
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [existing, setExisting] = useState<Review | null>(null);
  const [targetName, setTargetName] = useState('');
  const [rating, setRating] = useState(0);
  const [dims, setDims] = useState<Partial<Record<DimensionKey, number>>>({});
  const [wouldRecommend, setWouldRecommend] = useState(false);
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  // Created-review id + points earned (P6d, docs/CONTRACT-ADDITIONS.md #28):
  // the mock awards 50 pts per review at create; the success pill renders
  // from the earningsForReview getter (mock-only — the live repo returns
  // null until the contract ships the accrual surface).
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [earnedPoints, setEarnedPoints] = useState<number | null>(null);

  useEffect(() => {
    if (!createdId) return;
    let cancelled = false;
    getMembershipsRepository()
      .earningsForReview(createdId)
      .then((earnings) => {
        if (!cancelled) setEarnedPoints(earnings?.points ?? null);
      })
      .catch(() => {
        if (!cancelled) setEarnedPoints(null);
      });
    return () => {
      cancelled = true;
    };
  }, [createdId]);

  const isEdit = !!reviewId;

  /** Resolve a display name for the reviewed target (best-effort). */
  const resolveTargetName = useCallback(async (type: string, id: string): Promise<string> => {
    try {
      if (type === 'merchant') return (await getMerchantsRepository().get(id)).businessName;
      if (type === 'provider') return (await getProvidersRepository().get(id)).name;
      if (type === 'rider') return t('reviews.targetRider');
    } catch {
      /* fall through to the raw id */
    }
    return id;
  }, []);

  const load = useCallback(async () => {
    setError('');
    try {
      if (isEdit && reviewId) {
        const mine = await getReviewsRepository().listMine();
        const found = mine.find((r) => r.id === reviewId);
        if (!found) {
          setError(t('reviews.notFound'));
          return;
        }
        if (found.state === 'hidden' || found.state === 'deleted') {
          setError(t('reviews.notEditable'));
          return;
        }
        setExisting(found);
        setRating(found.rating);
        setBody(found.body ?? '');
        setTargetName(await resolveTargetName(found.targetType, found.targetId));
        return;
      }
      if (orderId) {
        const detail = await getOrdersRepository().get(orderId);
        setOrder(detail);
        setTargetName(await resolveTargetName('merchant', detail.merchantId));
        return;
      }
      if (targetType && targetId) {
        if (!REVIEW_TARGETS.includes(targetType as ReviewCreateTargetType)) {
          setError(t('common.error'));
          return;
        }
        setTargetName(await resolveTargetName(targetType, targetId));
      }
    } catch {
      setError(t('common.error'));
    }
  }, [isEdit, orderId, reviewId, targetId, targetType, resolveTargetName]);

  useEffect(() => {
    load();
  }, [load]);

  const eligible = order && ['delivered', 'completed'].includes(order.status);

  /** Target resolved for submission: edit keeps the review's own target. */
  const target: { targetType?: ReviewCreateTargetType; targetId?: string } = isEdit
    ? { targetType: existing?.targetType as ReviewCreateTargetType | undefined, targetId: existing?.targetId }
    : orderId
      ? { targetType: 'merchant', targetId: order?.merchantId }
      : { targetType: targetType as ReviewCreateTargetType | undefined, targetId };

  /** Only non-zero dimensions + a set would-recommend are sent (contract allows partial). */
  const dimsPayload = (() => {
    const stars: Dimensions = {};
    for (const [k, v] of Object.entries(dims) as [DimensionKey, number][]) {
      if (v > 0) stars[k] = v;
    }
    if (Object.keys(stars).length === 0 && !wouldRecommend) return undefined;
    return { ...stars, ...(wouldRecommend ? { wouldRecommend: true } : {}) } as Dimensions;
  })();

  const submit = async () => {
    if (!target.targetType || !target.targetId || rating < 1) return;
    setSubmitting(true);
    try {
      if (isEdit && existing) {
        await getReviewsRepository().update(
          existing.id,
          { rating, body: body.trim(), ...(dimsPayload ? { dimensions: dimsPayload } : {}) },
          idempotencyKey(user?.id ?? 'customer', 'review.edit'),
        );
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        toast(t('reviews.updated'));
        router.back();
        return;
      }
      const created = await getReviewsRepository().create(
        { targetType: target.targetType, targetId: target.targetId, rating, body: body.trim(), ...(dimsPayload ? { dimensions: dimsPayload } : {}) },
        idempotencyKey(user?.id ?? 'customer', 'review'),
      );
      setCreatedId(created.id);
      track({ name: 'review_submitted', targetType: target.targetType, targetId: target.targetId });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      toast(t('reviews.submitted'));
      setDone(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'REVIEW_NOT_ELIGIBLE') {
        setError(t('reviews.notEligible'));
        load();
      } else if (e instanceof ApiError && e.code === 'REVIEW_ALREADY_EXISTS') {
        setError(t('reviews.exists'));
      } else {
        setError(e instanceof ApiError ? e.message : t('common.error'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (done) {
    return (
      <Screen scroll contentStyle={{ justifyContent: 'center', flexGrow: 1 }}>
        <View style={{ alignItems: 'center', gap: Spacing.md }}>
          <View style={styles.doneIcon}>
            <Icon name="checkmark" size={30} color={Colors.white} />
          </View>
          <Pill label={t('reviews.pending')} tone="warning" />
          <Text style={styles.doneText}>{t('reviews.thanks')}</Text>
          {earnedPoints !== null && earnedPoints > 0 ? (
            <Pill label={t('review.pointsEarned', { n: earnedPoints })} tone="success" />
          ) : null}
          <Btn label={t('common.done')} onPress={() => router.back()} size="lg" />
        </View>
      </Screen>
    );
  }

  if ((orderId && !order) || (isEdit && !existing)) {
    return (
      <Screen>
        <SkeletonCard rows={3} />
      </Screen>
    );
  }

  if (orderId && !eligible) {
    return (
      <Screen>
        <EmptyState icon="star-outline" title={t('reviews.notEligible')} />
      </Screen>
    );
  }

  const showDimensions = target.targetType === 'provider';

  return (
    <Screen scroll>
      <Text style={styles.title}>{isEdit ? t('reviews.editTitle') : t('reviews.title')}</Text>
      {targetName ? <Text style={styles.target}>{t('reviews.forTarget', { name: targetName })}</Text> : null}
      <Card>
        <Text style={styles.section}>{t('reviews.rating')}</Text>
        <Row gap={Spacing.sm} style={{ justifyContent: 'center', paddingVertical: Spacing.md }}>
          {[1, 2, 3, 4, 5].map((i) => (
            <Pressable key={i} onPress={() => setRating(i)} accessibilityRole="button" accessibilityLabel={`${i} stars`} hitSlop={6}>
              <Icon name={i <= rating ? 'star' : 'star-outline'} size={36} color={i <= rating ? Colors.gold : Colors.borderStrong} />
            </Pressable>
          ))}
        </Row>

        {showDimensions ? (
          <>
            <Text style={styles.section}>{t('reviews.dimensions.title')}</Text>
            {DIMENSION_KEYS.map((k) => (
              <View key={k} style={{ marginBottom: Spacing.md }}>
                <Text style={styles.dimLabel}>{t(DIMENSION_LABELS[k])}</Text>
                <Row gap={Spacing.sm}>
                  {[1, 2, 3, 4, 5].map((i) => (
                    <Pressable key={i} onPress={() => setDims((d) => ({ ...d, [k]: i }))} accessibilityRole="button" accessibilityLabel={`${k} ${i} stars`} hitSlop={6}>
                      <Icon name={i <= (dims[k] ?? 0) ? 'star' : 'star-outline'} size={24} color={i <= (dims[k] ?? 0) ? Colors.gold : Colors.borderStrong} />
                    </Pressable>
                  ))}
                </Row>
              </View>
            ))}
            <ToggleRow label={t('reviews.wouldRecommend')} value={wouldRecommend} onChange={setWouldRecommend} />
          </>
        ) : null}

        <Field label={t('reviews.body')} value={body} onChangeText={setBody} multiline maxLength={2000} hint={`${body.length}/2000`} />
        <Btn
          label={isEdit ? t('reviews.editTitle') : t('reviews.submit')}
          onPress={submit}
          size="lg"
          loading={submitting}
          disabled={rating < 1}
          style={{ marginTop: Spacing.md }}
        />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text, marginBottom: Spacing.md },
  target: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sansMedium, marginBottom: Spacing.md },
  section: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sansSemibold },
  dimLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sansMedium, marginBottom: 4 },
  doneIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Colors.success,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneText: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text },
});
