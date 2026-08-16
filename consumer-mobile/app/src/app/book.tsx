import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { Btn, Card, Chip, ErrorState, Field, Icon, Row, Screen, SkeletonCard } from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { getBookingsRepository, getPaymentsRepository, getProvidersRepository, type PaymentMethodRecord } from '@/repos';
import { useAddressesStore } from '@/store/addresses';
import { useSessionStore } from '@/store/session';
import { toast } from '@/store/ui';
import { ApiError } from '@/api/client';
import { idempotencyKey } from '@/lib/idempotency';
import { dayLabelISO, fullTimeISO, localSlotISO, weekdayLabelISO } from '@/lib/dates';
import { formatTZS } from '@/lib/format';
import { pickDefaultMethod } from '@/lib/payments';
import type { Booking, BookingEstimate, ServiceQuestion } from '@hudumika/contract';
import { BookingCreatePaymentMethod } from '@hudumika/contract';

type AnswerValue = string | string[] | number | boolean;
type ScheduleMode = 'asap' | 'today' | 'tomorrow' | 'pick';

/** Contract cap for BookingCreate.photos (@maxItems 6) — the form stays
 * under it (max per question below) and the submit slices defensively. */
const BOOKING_PHOTOS_MAX = 6;
const QUESTION_PHOTOS_MAX = 4;

/* Photo/video question intake — expo-image-picker is lazy-imported so the
 * node test bundle never loads it; a missing/unavailable picker degrades to
 * an honest toast and the form stays usable (manual text answers still work). */
async function pickImages(max: number): Promise<string[] | null> {
  try {
    const Picker = await import('expo-image-picker');
    // Library picking on Android 13+/web needs no permission; on iOS the
    // media-library prompt is requested only if required by the platform.
    if (typeof Picker.requestMediaLibraryPermissionsAsync === 'function') {
      const perm = await Picker.requestMediaLibraryPermissionsAsync(true);
      if (!perm.granted) return null;
    }
    const result = await Picker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: max > 1,
      selectionLimit: max,
      quality: 0.7,
    });
    if (result.canceled) return null;
    return result.assets.map((a) => a.uri);
  } catch {
    return null;
  }
}

const TIME_SLOTS = [9, 12, 15, 18];

const timeLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;

const METHOD_LABEL: Record<BookingCreatePaymentMethod, string> = {
  [BookingCreatePaymentMethod.mpesa]: t('payments.mpesa'),
  [BookingCreatePaymentMethod.tigo_pesa]: t('payments.tigoPesa'),
  [BookingCreatePaymentMethod.airtel_money]: t('payments.airtelMoney'),
  [BookingCreatePaymentMethod.ezy_pesa]: t('payments.ezyPesa'),
  [BookingCreatePaymentMethod.halotel]: t('payments.halotel'),
  [BookingCreatePaymentMethod.card]: t('payments.card'),
  [BookingCreatePaymentMethod.cod]: t('payments.cod'),
  [BookingCreatePaymentMethod.bank]: t('payments.bank'),
};

export default function BookScreen() {
  const router = useRouter();
  const { providerId, serviceId } = useLocalSearchParams<{ providerId?: string; serviceId: string }>();
  const user = useSessionStore((s) => s.user);
  const addresses = useAddressesStore((s) => s.addresses);
  const selectedId = useAddressesStore((s) => s.selectedId);

  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>('asap');
  const [slotHour, setSlotHour] = useState<number | null>(null);
  const [pickDay, setPickDay] = useState<Date | null>(null);
  const [pickHour, setPickHour] = useState<number | null>(null);
  // Smart default (§37): pre-selected from GET /payments/methods once it
  // arrives; 'mpesa' is only the offline/fallback initial value.
  const [method, setMethod] = useState<BookingCreatePaymentMethod>('mpesa');
  const [methodList, setMethodList] = useState<PaymentMethodRecord[] | null>(null);
  const [methodError, setMethodError] = useState(false);
  const [duration, setDuration] = useState('120');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [retryAfter, setRetryAfter] = useState(0);
  const [createdBooking, setCreatedBooking] = useState<Booking | null>(null);
  const [pendingIntentId, setPendingIntentId] = useState<string | null>(null);

  const [questions, setQuestions] = useState<ServiceQuestion[] | null>(null);
  const [questionsError, setQuestionsError] = useState('');

  const [estimate, setEstimate] = useState<BookingEstimate | null>(null);
  const [estimateError, setEstimateError] = useState('');
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>({});
  // Captured photo/video question intake: question key → local URIs (picked
  // via expo-image-picker). The URIs ride BookingCreate.photos as URL
  // placeholders — a live app uploads each file first and sends the returned
  // server URLs instead (contract: photos?: string[], @maxItems 6).
  const [photosByKey, setPhotosByKey] = useState<Record<string, string[]>>({});
  const [pickerError, setPickerError] = useState(false);

  const address = addresses.find((a) => a.id === selectedId) ?? addresses[0];

  const loadQuestions = useCallback(async () => {
    setQuestionsError('');
    try {
      setQuestions(await getProvidersRepository().getQuestions(serviceId));
    } catch {
      setQuestionsError(t('booking.questions.error'));
    }
  }, [serviceId]);

  // Smart default payment method (§37): the server list wins. The default
  // record (isDefault) is pre-selected; on error the form falls back to the
  // 'mpesa' initial value (the first available method in the demo seed).
  const loadMethods = useCallback(async () => {
    setMethodError(false);
    try {
      const list = await getPaymentsRepository().getPaymentMethods();
      setMethodList(list);
      const preferred = pickDefaultMethod(list);
      if (preferred) setMethod(preferred.method as BookingCreatePaymentMethod);
    } catch {
      setMethodList(null);
      setMethodError(true);
    }
  }, []);

  const loadEstimate = useCallback(async () => {
    setEstimateError('');
    setEstimate(null);
    try {
      setEstimate(await getBookingsRepository().estimate({ serviceId }));
    } catch {
      setEstimateError(t('common.error'));
    }
  }, [serviceId]);

  useEffect(() => {
    loadMethods();
    loadQuestions();
    loadEstimate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // PAYMENT_PROVIDER_ERROR retry countdown (PAYMENTS.md) — never an instant
  // hammer on the provider.
  useEffect(() => {
    if (retryAfter <= 0) return;
    const timer = setTimeout(() => setRetryAfter((r) => r - 1), 1000);
    return () => clearTimeout(timer);
  }, [retryAfter]);

  const toggleChoice = (key: string, option: string, multi: boolean) => {
    setAnswers((prev) => {
      const current = prev[key];
      if (multi) {
        const list = Array.isArray(current) ? (current as string[]) : [];
        return {
          ...prev,
          [key]: list.includes(option) ? list.filter((o) => o !== option) : [...list, option],
        };
      }
      return { ...prev, [key]: current === option ? '' : option };
    });
  };

  /* Local calendar slots → UTC ISO (BOOKING-FLOW.md: local → UTC ISO 8601). */
  const buildScheduledFor = (): string | null => {
    const now = new Date();
    switch (scheduleMode) {
      case 'asap':
        // ASAP = dispatch now — earliest safe slot the server accepts.
        return new Date(now.getTime() + 15 * 60_000).toISOString();
      case 'today':
        return slotHour == null ? null : localSlotISO(now, slotHour);
      case 'tomorrow': {
        const d = new Date(now);
        d.setDate(d.getDate() + 1);
        return slotHour == null ? null : localSlotISO(d, slotHour);
      }
      case 'pick':
        return pickDay && pickHour != null ? localSlotISO(pickDay, pickHour) : null;
    }
  };

  const scheduleError = (): string | null => {
    if (scheduleMode === 'asap') return null;
    const hour = scheduleMode === 'pick' ? pickHour : slotHour;
    if (scheduleMode === 'pick' && !pickDay) return t('booking.pickDay');
    if (hour == null) return t('booking.pickTime');
    return null;
  };

  const pickDates: Date[] = (() => {
    const days: Date[] = [];
    const now = new Date();
    for (let i = 0; i < 7; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      days.push(d);
    }
    return days;
  })();

  // For "Today" only offer hours still ahead of the current local time.
  const todaySlots = TIME_SLOTS.filter((h) => Date.parse(localSlotISO(new Date(), h)) > Date.now() + 60_000);

  const scheduledForPreview = buildScheduledFor();

  const payForBooking = async (bookingId: string, retryIntentId: string | null) => {
    setError('');
    setRetryAfter(0);
    setProcessing(true);
    try {
      const intent = retryIntentId
        ? { id: retryIntentId, status: 'created' as const, amountTZS: createdBooking?.price?.totalTZS ?? 0, method }
        : await getPaymentsRepository().createIntent(bookingId, method, idempotencyKey(user?.id ?? 'customer', 'booking.intent'));
      setPendingIntentId(intent.id);
      // STK-push style wait: the confirm call resolves when the provider webhook
      // flips the intent (mock) or the live provider confirms the push.
      const paid = await getPaymentsRepository().confirm(intent.id, idempotencyKey(user?.id ?? 'customer', 'booking.confirm'));
      if (paid.status === 'paid') {
        toast(t('checkout.paymentSuccess'));
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.replace(`/booking/${bookingId}`);
      } else {
        setError(t('common.error'));
      }
    } catch (e) {
      if (e instanceof ApiError) {
        switch (e.code) {
          case 'PAYMENT_PROVIDER_ERROR': {
            const seconds = typeof e.details?.retryAfterSeconds === 'number' ? e.details.retryAfterSeconds : 10;
            setRetryAfter(seconds);
            setError(t('checkout.paymentFailed', { s: seconds }));
            break;
          }
          case 'PAYMENT_ALREADY_PAID':
            // The server says this booking is settled — land on its detail.
            router.replace(`/booking/${bookingId}`);
            break;
          case 'PAYMENT_INTENT_NOT_FOUND':
            // Recreate the intent on the next attempt (PAYMENTS.md).
            setPendingIntentId(null);
            setError(t('common.error'));
            break;
          case 'PAYMENT_METHOD_UNSUPPORTED':
            setError(t('checkout.methodUnsupported'));
            break;
          default:
            setError(t('common.error'));
        }
      } else {
        setError(t('common.error'));
      }
    } finally {
      setProcessing(false);
    }
  };

  const book = async () => {
    setError('');
    const missing = (questions ?? []).some((q) => {
      if (q.type === 'photo' || q.type === 'video') return q.required && !(photosByKey[q.key] ?? []).length;
      return q.required && !answers[q.key] && answers[q.key] !== false;
    });
    if (missing) {
      setError(t('booking.questions.incomplete'));
      return;
    }
    const scheduleErr = scheduleError();
    if (scheduleErr) {
      setError(scheduleErr);
      return;
    }
    const scheduledFor = buildScheduledFor();
    if (!scheduledFor) {
      setError(t('booking.pickTime'));
      return;
    }
    if (Date.parse(scheduledFor) < Date.now()) {
      setError(t('booking.errorPast'));
      return;
    }
    setSubmitting(true);
    try {
      // Photo/video question intake: local URIs as the answer value (the
      // questionnaire answer travels in BookingCreate.answers, blueprint §9)
      // and flattened into BookingCreate.photos (contract string[] of URLs,
      // max 6) — live apps replace the local URIs with server upload URLs.
      const photoAnswers = Object.entries(photosByKey)
        .filter(([, uris]) => uris.length > 0)
        .reduce<Record<string, string[]>>((acc, [key, uris]) => ({ ...acc, [key]: uris }), {});
      const photos = Object.values(photosByKey).flat().slice(0, BOOKING_PHOTOS_MAX);
      const booking = await getBookingsRepository().create(
        {
          // Category-first flow (/book?serviceId=) has no provider chosen yet —
          // the empty provider id is resolved by the server/mock on create.
          providerId: providerId ?? '',
          serviceId,
          scheduledFor,
          durationMinutes: Number(duration),
          paymentMethod: method,
          address,
          description: description.trim() || undefined,
          photos: photos.length ? photos : undefined,
          answers: Object.keys(answers).length || Object.keys(photoAnswers).length ? { ...answers, ...photoAnswers } : undefined,
        },
        idempotencyKey(user?.id ?? 'customer', 'booking'),
      );
      setCreatedBooking(booking);
      toast(t('booking.created'));
      if (method === 'cod') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.replace(`/booking/${booking.id}`);
        return;
      }
      // Booking is pending_payment — run the intent flow (POST /bookings +
      // POST /payments/intent → confirm, BOOKING-FLOW.md step 5).
      await payForBooking(booking.id, null);
    } catch (e) {
      if (e instanceof ApiError) {
        switch (e.code) {
          case 'BOOKING_TIME_IN_PAST':
            setError(t('booking.errorPast'));
            break;
          case 'BOOKING_DURATION_INVALID':
            setError(t('booking.errorDuration'));
            break;
          case 'BOOKING_PROVIDER_UNAVAILABLE':
            setError(t('booking.errorProvider'));
            break;
          default:
            setError(t('common.error'));
        }
      } else {
        setError(t('common.error'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onSubmit = () => {
    if (createdBooking) {
      payForBooking(createdBooking.id, pendingIntentId);
    } else {
      book();
    }
  };

  const renderQuestion = (q: ServiceQuestion) => {
    if (q.type === 'text' || q.type === 'number') {
      return (
        <Field
          key={q.key}
          label={q.label}
          value={typeof answers[q.key] === 'string' ? (answers[q.key] as string) : ''}
          onChangeText={(v) => setAnswers((prev) => ({ ...prev, [q.key]: v }))}
          keyboardType={q.type === 'number' ? 'number-pad' : undefined}
        />
      );
    }
    if (q.type === 'boolean') {
      const value = answers[q.key];
      return (
        <View key={q.key} style={{ gap: Spacing.sm }}>
          <Text style={styles.questionLabel}>{q.label}{q.required ? t('booking.requiredMark') : ''}</Text>
          <Row gap={Spacing.sm}>
            <Chip label={t('booking.questions.yes')} selected={value === true} onPress={() => setAnswers((prev) => ({ ...prev, [q.key]: value === true ? false : true }))} tone="success" />
            <Chip label={t('booking.questions.no')} selected={value === false} onPress={() => setAnswers((prev) => ({ ...prev, [q.key]: value === false ? true : false }))} tone="danger" />
          </Row>
        </View>
      );
    }
    if (q.type === 'single_choice' || q.type === 'multi_choice') {
      const multi = q.type === 'multi_choice';
      const selected = answers[q.key];
      return (
        <View key={q.key} style={{ gap: Spacing.sm }}>
          <Text style={styles.questionLabel}>{q.label}{q.required ? t('booking.requiredMark') : ''}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm }}>
            {(q.options ?? []).map((option) => (
              <Chip
                key={option}
                label={option}
                selected={multi ? Array.isArray(selected) && (selected as string[]).includes(option) : selected === option}
                onPress={() => toggleChoice(q.key, option, multi)}
              />
            ))}
          </View>
        </View>
      );
    }
    if (q.type === 'photo' || q.type === 'video') {
      const uris = photosByKey[q.key] ?? [];
      const remaining = Math.max(0, QUESTION_PHOTOS_MAX - uris.length);
      const add = async () => {
        if (remaining === 0) return;
        const picked = await pickImages(remaining);
        if (picked === null) {
          if (!pickerError) setPickerError(true);
          return;
        }
        setPickerError(false);
        if (picked.length) setPhotosByKey((prev) => ({ ...prev, [q.key]: [...(prev[q.key] ?? []), ...picked] }));
      };
      return (
        <View key={q.key} style={{ gap: Spacing.sm }}>
          <Text style={styles.questionLabel}>{q.label}{q.required ? t('booking.requiredMark') : ''}</Text>
          <Row gap={Spacing.sm} style={{ flexWrap: 'wrap' }}>
            {uris.map((uri) => (
              <View key={uri} style={styles.thumbWrap}>
                <Image source={{ uri }} style={styles.thumb} accessibilityLabel={t('booking.photos.add')} />
                <Pressable
                  onPress={() => setPhotosByKey((prev) => ({ ...prev, [q.key]: (prev[q.key] ?? []).filter((u) => u !== uri) }))}
                  accessibilityRole="button"
                  accessibilityLabel={t('booking.photos.remove')}
                  hitSlop={8}
                  style={styles.thumbRemove}>
                  <Icon name="close" size={12} color={Colors.white} />
                </Pressable>
              </View>
            ))}
          </Row>
          <Btn
            label={t('booking.photos.add')}
            onPress={add}
            variant="outline"
            icon="camera-outline"
            disabled={remaining === 0}
          />
          {remaining > 0 ? (
            <Text style={styles.meta}>{t('booking.photos.limit', { n: QUESTION_PHOTOS_MAX })}</Text>
          ) : null}
          {pickerError ? (
            <Text style={styles.error} accessibilityRole="alert">{t('booking.photos.unavailable')}</Text>
          ) : null}
        </View>
      );
    }
    // photo / video intake has no capture UI yet — skip silently.
    return null;
  };

  const timeChips = (mode: 'today' | 'tomorrow' | 'pick') => {
    const slots = mode === 'today' ? todaySlots : TIME_SLOTS;
    return (
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm }}>
        {slots.map((h) => (
          <Chip
            key={h}
            label={timeLabel(h)}
            selected={(mode === 'pick' ? pickHour : slotHour) === h}
            onPress={() => (mode === 'pick' ? setPickHour(h) : setSlotHour(h))}
          />
        ))}
      </View>
    );
  };

  return (
    <Screen scroll>
      <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
        <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
        <Text style={styles.title}>{t('booking.title')}</Text>
      </Row>

      <Card style={{ gap: Spacing.md }}>
        <Text style={styles.section}>{t('booking.when')}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm }}>
          <Chip label={t('booking.asap')} selected={scheduleMode === 'asap'} onPress={() => setScheduleMode('asap')} />
          <Chip label={t('booking.today')} selected={scheduleMode === 'today'} onPress={() => setScheduleMode('today')} />
          <Chip label={t('booking.tomorrow')} selected={scheduleMode === 'tomorrow'} onPress={() => setScheduleMode('tomorrow')} />
          <Chip label={t('booking.pickDate')} selected={scheduleMode === 'pick'} onPress={() => setScheduleMode('pick')} />
        </View>
        {scheduleMode === 'asap' ? <Text style={styles.meta}>{t('booking.asapHint')}</Text> : null}
        {scheduleMode === 'today' || scheduleMode === 'tomorrow' ? (
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.meta}>{scheduleMode === 'today' ? t('booking.today') : t('booking.tomorrow')}</Text>
            {timeChips(scheduleMode)}
          </View>
        ) : null}
        {scheduleMode === 'pick' ? (
          <View style={{ gap: Spacing.sm }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm }}>
              {pickDates.map((d) => (
                <Chip
                  key={d.toISOString()}
                  label={`${weekdayLabelISO(d.toISOString())}, ${dayLabelISO(d.toISOString())}`}
                  selected={pickDay?.getTime() === d.getTime()}
                  onPress={() => setPickDay(d)}
                />
              ))}
            </View>
            {timeChips('pick')}
          </View>
        ) : null}
        {scheduledForPreview ? <Text style={styles.meta}>{t('booking.scheduledFor')}: {fullTimeISO(scheduledForPreview)}</Text> : null}
        <Field label={t('booking.duration')} value={duration} onChangeText={setDuration} keyboardType="number-pad" hint={t('booking.durationHint')} />
        <Field label={t('booking.description')} value={description} onChangeText={setDescription} multiline maxLength={2000} />
        {address ? (
          <Text style={styles.meta}>{t('checkout.address')}: {address.label} — {address.lines}</Text>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {processing ? (
          <Card style={{ gap: Spacing.sm, backgroundColor: Colors.primarySoft }}>
            <Text style={{ color: Colors.primaryDeep, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, textAlign: 'center' }}>
              {t('checkout.stkPush', { method: method.toUpperCase().replace('_', ' ') })}
            </Text>
          </Card>
        ) : null}
        <Btn
          label={processing ? '…' : retryAfter > 0 ? t('checkout.paymentFailed', { s: retryAfter }) : createdBooking ? t('booking.pay', { amount: formatTZS(createdBooking.price?.totalTZS ?? 0) }) : t('booking.confirm')}
          onPress={processing ? undefined : onSubmit}
          size="lg"
          loading={submitting || processing}
          disabled={retryAfter > 0 || (!createdBooking && (!address || scheduleError() !== null))}
        />
      </Card>

      <Text style={styles.section}>{t('checkout.payment')}</Text>
      <Card style={{ gap: Spacing.sm }}>
        {methodList === null && !methodError ? (
          <SkeletonCard rows={1} />
        ) : (
          (() => {
            const chips = methodList
              ? methodList.map((m) => ({ key: m.method, label: m.label }))
              : Object.values(BookingCreatePaymentMethod).map((m) => ({ key: m, label: METHOD_LABEL[m] }));
            return (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm }}>
                {chips.map((chip) => (
                  <Chip
                    key={chip.key}
                    label={chip.label}
                    selected={method === chip.key}
                    onPress={() => setMethod(chip.key as BookingCreatePaymentMethod)}
                  />
                ))}
              </View>
            );
          })()
        )}
      </Card>

      <Text style={styles.section}>{t('booking.estimate')}</Text>
      {estimateError ? (
        <ErrorState message={estimateError} onRetry={loadEstimate} />
      ) : !estimate ? (
        <SkeletonCard rows={2} />
      ) : (
        <Card style={{ gap: Spacing.sm }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={styles.value}>{t('booking.estimate.range', { low: formatTZS(estimate.lowTZS), high: formatTZS(estimate.highTZS) })}</Text>
            {estimate.estimatedDurationMinutes ? <Text style={styles.meta}>{t('booking.estimate.duration', { m: estimate.estimatedDurationMinutes })}</Text> : null}
          </Row>
          <Text style={styles.meta}>{t('booking.estimate.tripFee', { amount: formatTZS(estimate.tripFeeTZS) })}</Text>
          {estimate.disclaimer ? <Text style={styles.note}>{estimate.disclaimer}</Text> : null}
        </Card>
      )}

      <Text style={styles.section}>{t('booking.questions.title')}</Text>
      {questionsError ? (
        <ErrorState message={questionsError} onRetry={loadQuestions} />
      ) : !questions ? (
        <SkeletonCard rows={3} />
      ) : questions.length === 0 ? null : (
        <Card style={{ gap: Spacing.lg }}>
          {questions.map(renderQuestion)}
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text, flex: 1, textAlign: 'center' },
  section: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sansSemibold, marginBottom: Spacing.sm },
  questionLabel: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansSemibold },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans },
  value: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansMedium },
  note: { fontSize: FontSize.xs, color: Colors.textFaint, fontFamily: Fonts.sans, marginTop: Spacing.sm },
  error: { color: Colors.danger, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold },
  thumbWrap: { width: 64, height: 64 },
  thumb: { width: 64, height: 64, borderRadius: Radius.md, backgroundColor: Colors.surface },
  thumbRemove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: Colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
