import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { Btn, Card, Empty, Field, Icon, Row, Screen, SectionTitle, SheetModal, Stars } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { hapticSuccess } from '@/lib/motion';
import { dateISO } from '@/lib/format';
import { getBookingsRepository, getReviewsRepository } from '@/repos';
import { useSessionStore } from '@/store/session';
import type { Booking, ReviewCreate } from '@hudumika/contract';

const DIMENSIONS: { key: keyof NonNullable<ReviewCreate['dimensions']>; labelKey: 'reviews.dimensions.professionalism' | 'reviews.dimensions.punctuality' | 'reviews.dimensions.quality' | 'reviews.dimensions.communication' | 'reviews.dimensions.priceTransparency' | 'reviews.dimensions.cleanliness' }[] = [
  { key: 'professionalism', labelKey: 'reviews.dimensions.professionalism' },
  { key: 'punctuality', labelKey: 'reviews.dimensions.punctuality' },
  { key: 'quality', labelKey: 'reviews.dimensions.quality' },
  { key: 'communication', labelKey: 'reviews.dimensions.communication' },
  { key: 'priceTransparency', labelKey: 'reviews.dimensions.priceTransparency' },
  { key: 'cleanliness', labelKey: 'reviews.dimensions.cleanliness' },
];

export default function ReviewsScreen() {
  const provider = useSessionStore((s) => s.provider);
  const [completed, setCompleted] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [reviewing, setReviewing] = useState<Booking | null>(null);
  const [rating, setRating] = useState(5);
  const [body, setBody] = useState('');
  const [dimensions, setDimensions] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const bookings = await getBookingsRepository().listMyBookings();
      const done = bookings.filter((b) => ['completed', 'settled', 'warranty'].includes(b.status));
      setCompleted(done);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load reviews');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const submit = async () => {
    if (!reviewing) return;
    setSubmitting(true);
    setFormError('');
    try {
      await getReviewsRepository().createForCustomer(reviewing.id, {
        targetType: 'customer',
        targetId: reviewing.id,
        rating,
        body: body.trim() || 'Job completed',
        dimensions: {
          professionalism: dimensions.professionalism ?? rating,
          punctuality: dimensions.punctuality ?? rating,
          quality: dimensions.quality ?? rating,
          communication: dimensions.communication ?? rating,
          priceTransparency: dimensions.priceTransparency ?? rating,
          cleanliness: dimensions.cleanliness ?? rating,
          wouldRecommend: rating >= 4,
        },
      });
      hapticSuccess();
      setReviewing(null);
      setBody('');
      setRating(5);
      setDimensions({});
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : 'Could not submit the review');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen scroll>
      <Text style={styles.heading}>{t('reviews.title')}</Text>

      {/* Rating summary from the profile — received-reviews feed lands with GET /reviews/me */}
      <Card style={{ gap: Spacing.sm }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.cardLabel}>{t('home.rating')}</Text>
          <Text style={styles.reviewCount}>{provider?.reviewCount ?? 0} {t('reviews.title')}</Text>
        </Row>
        <Stars rating={provider?.rating ?? 0} size={18} showValue />
        <Text style={styles.note}>{t('reviews.receivedNote')}</Text>
      </Card>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={Colors.primary} />
        </View>
      ) : error ? (
        <Card style={{ gap: Spacing.sm }}>
          <Text style={styles.error}>{error}</Text>
          <Btn label={t('misc.retry')} variant="ghost" size="sm" onPress={load} />
        </Card>
      ) : (
        <>
          <SectionTitle title={t('reviews.rateCustomer')} icon="star-outline" />
          {completed.length === 0 ? (
            <Empty icon="star-outline" title={t('reviews.notEligible')} sub={t('reviews.eligible')} />
          ) : (
            <View style={{ gap: Spacing.md }}>
              {completed.map((b) => (
                <Card key={b.id} style={{ gap: Spacing.sm }}>
                  <Text style={styles.service}>{b.serviceId}</Text>
                  <Text style={styles.meta}>{dateISO(b.scheduledFor)}</Text>
                  <Btn label={t('reviews.rateCustomer')} size="sm" icon="star" onPress={() => setReviewing(b)} />
                </Card>
              ))}
            </View>
          )}
        </>
      )}

      <SheetModal visible={!!reviewing} onClose={() => setReviewing(null)} title={t('reviews.rateCustomer')}>
        <View style={{ gap: Spacing.md }}>
          <View style={{ alignItems: 'center' }}>
            <Text style={styles.cardLabel}>{t('reviews.rating')}</Text>
            <Row gap={4} style={{ marginTop: Spacing.sm }}>
              {[1, 2, 3, 4, 5].map((i) => (
                <StarTap key={i} active={i <= rating} onPress={() => setRating(i)} />
              ))}
            </Row>
          </View>
          {DIMENSIONS.map((d) => (
            <Row key={d.key} style={{ justifyContent: 'space-between' }}>
              <Text style={styles.dimLabel}>{t(d.labelKey)}</Text>
              <Row gap={4}>
                {[1, 2, 3, 4, 5].map((i) => (
                  <StarTap key={i} small active={(dimensions[d.key] ?? rating) >= i} onPress={() => setDimensions((dm) => ({ ...dm, [d.key]: i }))} />
                ))}
              </Row>
            </Row>
          ))}
          <Field label={t('reviews.body')} value={body} onChangeText={setBody} multiline placeholder={t('reviews.body')} maxLength={2000} />
          {formError ? <Text style={styles.error}>{formError}</Text> : null}
          <Btn label={t('reviews.submit')} onPress={submit} loading={submitting} size="lg" />
        </View>
      </SheetModal>
    </Screen>
  );
}

function StarTap({ active, onPress, small }: { active: boolean; onPress: () => void; small?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={active ? 'star selected' : 'star'}
      accessibilityState={{ selected: active }}
      style={({ pressed }) => ({
        minWidth: small ? 36 : 44,
        minHeight: small ? 36 : 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: Radius.sm,
        opacity: pressed ? 0.6 : 1,
      })}>
      <Icon name={active ? 'star' : 'star-outline'} size={small ? 18 : 24} color={active ? Colors.gold : Colors.borderStrong} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: FontSize.xxl, fontFamily: 'PlusJakartaSans_800ExtraBold', color: Colors.text, marginBottom: Spacing.lg },
  center: { paddingVertical: Spacing.xxl, alignItems: 'center' },
  error: { color: Colors.danger, fontSize: FontSize.sm },
  cardLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: 'PlusJakartaSans_700Bold' },
  reviewCount: { fontSize: FontSize.xs, color: Colors.textTertiary },
  note: { fontSize: FontSize.xs, color: Colors.textFaint, lineHeight: 16 },
  service: { fontSize: FontSize.md, fontFamily: 'PlusJakartaSans_700Bold', color: Colors.text },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary },
  dimLabel: { fontSize: FontSize.sm, color: Colors.textSecondary },
});
