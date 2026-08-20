/* Booking detail — GET /bookings/{id} with the event timeline, cancel
 * (with reason), complete (awaiting_customer_confirmation), quote decision
 * (quote_issued → approve/decline), declined / no-show / scheduled states,
 * the pending_payment "Pay" CTA (intent flow) and a "Problem" path to support. */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  Btn,
  Card,
  Divider,
  ErrorState,
  Field,
  Icon,
  MoneyText,
  Pill,
  PriceBreakdown,
  Row,
  Screen,
  SheetModal,
  SkeletonCard,
  StatusPill,
} from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, formatTZS, type I18nKey } from '@/i18n';
import { idempotencyKey } from '@/lib/idempotency';
import { countdownISO, dateISO, fullDateISO } from '@/lib/dates';
import { buildSharePayload, shareContent } from '@/lib/share';
import { toast } from '@/store/ui';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { BOOKING_EVENTS } from '@/store/events';
import { getBookingsRepository, getPaymentsRepository, getProvidersRepository, type BookingsRepository, type BookingInvoice, type BookingProof, type BookingWarranty } from '@/repos';
import type { Booking, BookingDetail, BookingQuote, DecideBookingQuoteBodyDecision, ProviderPublic } from '@hudumika/contract';
import { ApiError } from '@/api/client';

/* BookingDetail on the mock wire may carry the issued quote object (contract
 * types only expose quoteStatus) plus the linked payment intent id/method
 * (contract types only expose status); live responses simply omit them.
 * Quote revisions: the contract has no revision/version fields, so the mock
 * attaches the superseded quote as `previousQuote` and the mock-only
 * `quoteAskProvider` capability flag — both stripped from the live wire. */
type BookingWithQuote = BookingDetail & {
  quote?: BookingQuote | null;
  intentId?: string;
  paymentMethod?: string;
  previousQuote?: BookingQuote;
  quoteAskProvider?: true;
};

/** Mock-only quote decision surface: the contract enum is approved|declined
 * (decideBookingQuoteBodyDecision.ts — verified), so 'ask_provider' exists
 * only in the mock. The screen types the call locally and only ever renders
 * the button when the mock flag is present; the live repo never sees it. */
type QuoteAskRepository = Pick<BookingsRepository, 'decideQuote'> & {
  decideQuote(bookingId: string, decision: 'ask_provider', note: string | undefined, idempotencyKey: string): Promise<Booking>;
};

export default function BookingDetailScreen() {
  const router = useRouter();
  const { bookingId } = useLocalSearchParams<{ bookingId: string }>();
  const [booking, setBooking] = useState<BookingWithQuote | null>(null);
  const [provider, setProvider] = useState<ProviderPublic | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState('');
  const [retryAfter, setRetryAfter] = useState(0);
  const [askOpen, setAskOpen] = useState(false);
  const [askNote, setAskNote] = useState('');

  /* Customer documents (GET /bookings/{id}/invoice|warranty|proof-of-service —
   * mock-only until the contract ships them, CONTRACT-ADDITIONS #9). Loaded
   * only for completed bookings; each card keeps its own loading/error/retry
   * and falls back to the coming-soon copy when the document is null. */
  const [docsLoading, setDocsLoading] = useState(false);
  const [docError, setDocError] = useState(false);
  const [invoice, setInvoice] = useState<BookingInvoice | null>(null);
  const [warranty, setWarranty] = useState<BookingWarranty | null>(null);
  const [proof, setProof] = useState<BookingProof | null>(null);

  const loadDocuments = useCallback(async () => {
    setDocsLoading(true);
    setDocError(false);
    try {
      const [inv, war, prf] = await Promise.all([
        getBookingsRepository().getInvoice(bookingId),
        getBookingsRepository().getWarranty(bookingId),
        getBookingsRepository().getProofOfService(bookingId),
      ]);
      setInvoice(inv);
      setWarranty(war);
      setProof(prf);
    } catch {
      setDocError(true);
    } finally {
      setDocsLoading(false);
    }
  }, [bookingId]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setError('');
    try {
      const detail = await getBookingsRepository().get(bookingId);
      setBooking(detail as BookingWithQuote);
      if (detail.status === 'completed') void loadDocuments();
      try {
        setProvider(await getProvidersRepository().get(detail.providerId));
      } catch {
        setProvider(null);
      }
    } catch (e) {
      if (!silent) setError(e instanceof ApiError && e.status === 404 ? t('booking.notFound') : t('common.error'));
    }
  }, [bookingId, loadDocuments]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Realtime (BOOKING-FLOW.md): booking lifecycle, quote re-issues and the
  // document events (proof of service / invoice / warranty) refetch the detail.
  useLiveRefresh(BOOKING_EVENTS, () => load(true));

  // PAYMENT_PROVIDER_ERROR retry countdown (PAYMENTS.md).
  useEffect(() => {
    if (retryAfter <= 0) return;
    const timer = setTimeout(() => setRetryAfter((r) => r - 1), 1000);
    return () => clearTimeout(timer);
  }, [retryAfter]);

  // Share sheet (#138): message + hudumika://booking/{id} deep link; on web
  // it copies to the clipboard, and if no share surface exists the button
  // reports failure (the booking reference is already visible on the screen).
  const shareBooking = async () => {
    if (!booking) return;
    const shared = await shareContent(
      buildSharePayload({
        kind: 'booking',
        id: booking.id,
        title: booking.id.slice(-6),
        detail: `${t(`status.${booking.status}` as I18nKey)} · ${formatTZS(booking.price?.totalTZS ?? 0)}`,
      }),
    );
    if (!shared) toast(t('share.failed'));
  };

  const cancel = async () => {
    setBusy(true);
    try {
      await getBookingsRepository().cancel(bookingId, reason.trim(), idempotencyKey('cus_1', 'booking.cancel'));
      setCancelOpen(false);
      setReason('');
      toast(t('booking.cancelled'));
      load(true);
    } catch {
      toast(t('common.error'), 'error');
    } finally {
      setBusy(false);
    }
  };

  // declined → "Cancel with refund" (BOOKING-FLOW.md cancellation rules).
  const cancelWithRefund = async () => {
    setBusy(true);
    try {
      await getBookingsRepository().cancel(bookingId, t('booking.declined.refundReason'), idempotencyKey('cus_1', 'booking.cancel.refund'));
      toast(t('booking.declined.refunded'));
      load(true);
    } catch {
      toast(t('common.error'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const complete = async () => {
    setBusy(true);
    try {
      await getBookingsRepository().complete(bookingId, idempotencyKey('cus_1', 'booking.complete'));
      toast(t('booking.completed'));
      load(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // BOOKING_STATUS_CONFLICT — provider/customer state race; the server
        // state wins, refetch to resync (BOOKING-FLOW.md).
        toast(t('booking.completeConflict'));
        load(true);
      } else {
        toast(e instanceof ApiError ? e.message : t('common.error'), 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  // pending_payment → re-attach to the intent and confirm (same pattern as
  // the checkout flow: createIntent is idempotent and returns the booking's
  // linked intent; the mock carries intentId/paymentMethod on the wire).
  const pay = async () => {
    if (!booking) return;
    setPaying(true);
    setPayError('');
    setRetryAfter(0);
    try {
      const intent = booking.intentId
        ? { id: booking.intentId, status: 'created' as const, amountTZS: booking.price?.totalTZS ?? 0, method: booking.paymentMethod ?? 'mpesa' }
        : await getPaymentsRepository().createIntent(booking.id, (booking.paymentMethod ?? 'mpesa') as 'mpesa', idempotencyKey('cus_1', 'booking.pay.intent'));
      const paid = await getPaymentsRepository().confirm(intent.id, idempotencyKey('cus_1', 'booking.pay.confirm'));
      if (paid.status === 'paid') {
        toast(t('checkout.paymentSuccess'));
        load(true);
      } else {
        setPayError(t('common.error'));
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PAYMENT_PROVIDER_ERROR') {
        const seconds = typeof e.details?.retryAfterSeconds === 'number' ? e.details.retryAfterSeconds : 10;
        setRetryAfter(seconds);
        setPayError(t('checkout.paymentFailed', { s: seconds }));
      } else if (e instanceof ApiError && e.code === 'PAYMENT_ALREADY_PAID') {
        load(true);
      } else if (e instanceof ApiError && e.code === 'PAYMENT_INTENT_NOT_FOUND') {
        setPayError(t('common.error'));
      } else {
        setPayError(e instanceof ApiError ? e.message : t('common.error'));
      }
    } finally {
      setPaying(false);
    }
  };

  const decideQuote = async (decision: DecideBookingQuoteBodyDecision | 'ask_provider') => {
    setBusy(true);
    try {
      if (decision === 'ask_provider') {
        // Mock-only: contract enum is approved|declined — the button only
        // renders when the mock flag is present (QuoteAskRepository).
        await (getBookingsRepository() as unknown as QuoteAskRepository).decideQuote(
          bookingId,
          'ask_provider',
          askNote.trim() || undefined,
          idempotencyKey('cus_1', 'booking.quote.ask_provider'),
        );
      } else {
        const note = decision === 'declined' ? rejectReason.trim() || undefined : undefined;
        await getBookingsRepository().decideQuote(
          bookingId,
          decision,
          note,
          idempotencyKey('cus_1', `booking.quote.${decision}`),
        );
      }
      setRejectOpen(false);
      setRejectReason('');
      setAskOpen(false);
      setAskNote('');
      toast(decision === 'approved' ? t('booking.quote.approved') : decision === 'declined' ? t('booking.quote.declined') : t('booking.quote.asked'));
      load(true);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : t('booking.quote.error'), 'error');
      // 409 = state conflict — the server state wins, refetch to resync.
      if (e instanceof ApiError && e.status === 409) load(true);
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (!booking) {
    return (
      <Screen>
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={3} />
          <SkeletonCard rows={4} />
        </View>
      </Screen>
    );
  }

  const cancellable = ['pending_payment', 'paid', 'provider_requested', 'provider_accepted'].includes(booking.status);
  const confirmable = booking.status === 'awaiting_customer_confirmation';
  const quotePending = booking.quoteStatus === 'quote_issued' && !!booking.quote;

  const quote = booking.quote;
  const quoteTotal = (q: BookingQuote) => {
    const partsTZS = (q.parts ?? []).reduce((acc, p) => acc + p.unitCostTZS * p.quantity, 0);
    // Advisory client sum of server-provided integer fields — the server is the
    // authority for the final billed total (PriceBreakdown pattern).
    return q.laborTZS + q.tripFeeTZS + partsTZS;
  };
  const quoteTotalTZS = quote ? quoteTotal(quote) : 0;
  const previousQuoteTotalTZS = booking.previousQuote ? quoteTotal(booking.previousQuote) : null;

  const statusTone: Record<string, 'success' | 'info' | 'neutral' | 'danger' | 'warning'> = {
    pending_payment: 'warning',
    paid: 'info',
    provider_requested: 'info',
    provider_accepted: 'info',
    scheduled: 'info',
    quote_required: 'warning',
    quote_submitted: 'warning',
    quote_accepted: 'success',
    in_progress: 'info',
    awaiting_customer_confirmation: 'warning',
    completed: 'success',
    cancelled: 'danger',
    declined: 'danger',
    no_show: 'warning',
    refunded: 'success',
    disputed: 'danger',
  };

  return (
    <Screen>
      <View style={{ padding: Spacing.lg, flex: 1 }}>
        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <Row gap={Spacing.sm}>
            <StatusPill status={booking.status} />
            <Btn label={t('share.booking')} onPress={shareBooking} variant="subtle" size="sm" icon="share-social-outline" />
          </Row>
        </Row>

        <Text style={styles.title}>{t('booking.title')} #{booking.id.slice(-6)}</Text>

        <Card style={{ gap: Spacing.md }}>
          <Row gap={Spacing.md}>
            <View style={styles.avatar}>
              <Icon name="construct-outline" size={22} color={Colors.primaryDeep} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.value}>{provider?.name ?? booking.providerId}</Text>
              <Text style={styles.meta}>{booking.description || booking.serviceId}</Text>
            </View>
          </Row>
          <Divider />
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={styles.meta}>{t('booking.scheduledFor')}</Text>
            <Text style={styles.value}>{dateISO(booking.scheduledFor)}</Text>
          </Row>
          <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <Text style={styles.meta}>{t('booking.address')}</Text>
            <Text style={[styles.value, { flex: 1, textAlign: 'right', marginLeft: Spacing.md }]} numberOfLines={2}>
              {[booking.address.label, booking.address.lines, booking.address.landmark].filter(Boolean).join(', ')}
            </Text>
          </Row>
          <Divider />
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={styles.meta}>{t('booking.total')}</Text>
            {booking.price ? <MoneyText amountTZS={booking.price.totalTZS} size={FontSize.md} bold /> : null}
          </Row>
        </Card>

        {booking.status === 'declined' ? (
          <Card style={{ gap: Spacing.md, backgroundColor: Colors.dangerSoft, marginTop: Spacing.md }}>
            <Text style={[styles.value, { color: Colors.danger, fontFamily: Fonts.sansBold }]}>{t('booking.declined.title')}</Text>
            <Text style={styles.meta}>{t('booking.declined.info')}</Text>
            <Row gap={Spacing.sm}>
              <Btn
                label={t('booking.declined.requestAnother')}
                onPress={() => router.push({ pathname: '/book', params: { serviceId: booking.serviceId, providerId: booking.providerId } })}
                loading={busy}
                style={{ flex: 1 }}
              />
              <Btn label={t('booking.declined.cancelRefund')} onPress={cancelWithRefund} loading={busy} variant="outline" style={{ flex: 1 }} />
            </Row>
          </Card>
        ) : null}

        {booking.status === 'no_show' ? (
          <Card style={{ gap: Spacing.md, backgroundColor: Colors.warningSoft, marginTop: Spacing.md }}>
            <Text style={[styles.value, { color: Colors.warning, fontFamily: Fonts.sansBold }]}>{t('booking.noShow.title')}</Text>
            <Text style={styles.meta}>{t('booking.noShow.info')}</Text>
            <Btn
              label={t('booking.noShow.cta')}
              onPress={() => router.push({ pathname: '/support', params: { bookingId } })}
              variant="outline"
              icon="chatbubble-ellipses-outline"
            />
          </Card>
        ) : null}

        {booking.status === 'scheduled' ? (
          <Card style={{ gap: Spacing.sm, marginTop: Spacing.md }}>
            <Text style={styles.value}>{t('booking.scheduledFor')}: {dateISO(booking.scheduledFor)}</Text>
            <Text style={styles.meta}>{t('booking.scheduledCountdown', { t: countdownISO(booking.scheduledFor) })}</Text>
          </Card>
        ) : null}

        {booking.status === 'pending_payment' ? (
          <Card style={{ gap: Spacing.md, marginTop: Spacing.md }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.meta}>{t('booking.payment')}</Text>
              <Pill label={t('status.pending_payment')} tone="warning" />
            </Row>
            {paying ? (
              <Text style={{ color: Colors.primaryDeep, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, textAlign: 'center' }}>
                {t('checkout.stkPush', { method: (booking.paymentMethod ?? 'mpesa').toUpperCase().replace('_', ' ') })}
              </Text>
            ) : null}
            {payError ? <Text style={[styles.meta, { color: Colors.danger }]}>{payError}</Text> : null}
            <Btn
              label={paying ? '…' : retryAfter > 0 ? t('checkout.paymentFailed', { s: retryAfter }) : t('booking.payNow')}
              onPress={paying ? undefined : pay}
              loading={paying}
              disabled={retryAfter > 0}
              variant="success"
            />
            {/* Vertical checkout shell — pending-payment booking paid from /book/checkout. */}
            <Btn
              label={t('booking.payViaCheckout')}
              onPress={() => router.push({ pathname: '/book/checkout', params: { bookingId } })}
              variant="outline"
            />
          </Card>
        ) : null}

        {quotePending && quote ? (
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.section}>{t('booking.quote.title')}</Text>
            <Card style={{ gap: Spacing.md }}>
              {booking.previousQuote && previousQuoteTotalTZS !== null ? (
                <Card style={[styles.revisedBanner, { backgroundColor: Colors.warningSoft }]}>
                  <Row gap={Spacing.md}>
                    <Icon name="refresh" size={16} color={Colors.warning} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.value, { color: Colors.warning, fontFamily: Fonts.sansBold }]}>{t('booking.quote.revised')}</Text>
                      <Text style={[styles.meta, { color: Colors.textSecondary }]}>
                        {t('booking.quote.previous')}: {formatTZS(previousQuoteTotalTZS)} → {formatTZS(quoteTotalTZS)}
                      </Text>
                    </View>
                  </Row>
                </Card>
              ) : null}
              <PriceBreakdown
                totalLabel={t('booking.quote.total')}
                totalTZS={quoteTotalTZS}
                rows={[
                  { label: t('booking.quote.labor'), amountTZS: quote.laborTZS },
                  ...(quote.parts ?? []).map((p) => ({
                    label: t('booking.quote.partsQty', { name: p.name, qty: p.quantity }),
                    amountTZS: p.unitCostTZS * p.quantity,
                  })),
                  { label: t('booking.quote.tripFee'), amountTZS: quote.tripFeeTZS },
                ]}
              />
              {quote.note ? <Text style={styles.meta}>{t('booking.quote.note')}: {quote.note}</Text> : null}
              {quote.expiresAt ? (
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={styles.meta}>{t('booking.quote.expires')}</Text>
                  <Text style={styles.value}>{dateISO(quote.expiresAt)}</Text>
                </Row>
              ) : null}
              <Row gap={Spacing.sm}>
                <Btn label={t('booking.quote.approve')} onPress={() => decideQuote('approved')} loading={busy} variant="success" style={{ flex: 1 }} />
                {booking.quoteAskProvider ? (
                  <Btn label={t('booking.quote.askProvider')} onPress={() => setAskOpen(true)} disabled={busy} variant="outline" style={{ flex: 1 }} />
                ) : null}
                <Btn label={t('booking.quote.reject')} onPress={() => setRejectOpen(true)} disabled={busy} variant="outline" style={{ flex: 1 }} />
              </Row>
            </Card>
          </View>
        ) : null}

        {booking.status === 'completed' ? (
          <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
            <Card style={{ gap: Spacing.sm }}>
              <Text style={styles.value}>{t('booking.rateProvider')}</Text>
              <Text style={styles.meta}>{t('booking.rateProviderHint')}</Text>
              <Row gap={Spacing.sm}>
                <Btn
                  label={t('booking.rateProvider')}
                  onPress={() => router.push({ pathname: '/review', params: { targetType: 'provider', targetId: booking.providerId } })}
                  variant="success"
                  icon="star"
                  style={{ flex: 1 }}
                />
                <Btn
                  label={t('booking.bookAgain')}
                  onPress={() => router.push({ pathname: '/book', params: { serviceId: booking.serviceId, providerId: booking.providerId } })}
                  variant="outline"
                  icon="refresh"
                  style={{ flex: 1 }}
                />
              </Row>
            </Card>

            {/* Customer documents — read-only cards backed by the document
                GETs (mock-only until the contract ships them,
                CONTRACT-ADDITIONS #9). Each card renders the document when
                present, otherwise a "not issued" fallback; a fetch failure
                surfaces a per-card retry. */}
            <Text style={styles.section}>{t('booking.documents.title')}</Text>

            {docsLoading ? (
              <SkeletonCard rows={2} />
            ) : (
              <>
                <Card style={{ gap: Spacing.sm }}>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Text style={styles.value}>{t('booking.invoice.title')}</Text>
                    {invoice ? <Pill label={t('status.issued')} tone="success" /> : null}
                  </Row>
                  {docError ? (
                    <Text style={[styles.meta, { color: Colors.danger }]}>{t('booking.docs.error')}</Text>
                  ) : invoice ? (
                    <>
                      {invoice.lineItems.map((li, i) => (
                        <Row key={i} style={{ justifyContent: 'space-between' }}>
                          <Text style={styles.meta} numberOfLines={1}>{li.name} × {li.quantity}</Text>
                          <Text style={styles.value}>{formatTZS(li.unitPriceTZS * li.quantity)}</Text>
                        </Row>
                      ))}
                      <Divider />
                      <Row style={{ justifyContent: 'space-between' }}>
                        <Text style={styles.meta}>{t('booking.invoice.subtotal')}</Text>
                        <Text style={styles.value}>{formatTZS(invoice.subtotalTZS)}</Text>
                      </Row>
                      <Row style={{ justifyContent: 'space-between' }}>
                        <Text style={styles.meta}>{t('booking.invoice.fees')}</Text>
                        <Text style={styles.value}>{formatTZS(invoice.feesTZS)}</Text>
                      </Row>
                      <Row style={{ justifyContent: 'space-between' }}>
                        <Text style={[styles.value, { fontFamily: Fonts.sansBold }]}>{t('booking.total')}</Text>
                        <Text style={[styles.value, { fontFamily: Fonts.sansBold }]}>{formatTZS(invoice.totalTZS)}</Text>
                      </Row>
                      <Text style={styles.meta}>{t('booking.invoice.issued', { t: fullDateISO(invoice.issuedAt) })}</Text>
                    </>
                  ) : (
                    <Text style={styles.meta}>{t('booking.invoice.notIssued')}</Text>
                  )}
                </Card>

                <Card style={{ gap: Spacing.sm }}>
                  <Text style={styles.value}>{t('booking.warranty.title')}</Text>
                  {docError ? (
                    <Text style={[styles.meta, { color: Colors.danger }]}>{t('booking.docs.error')}</Text>
                  ) : warranty ? (
                    <>
                      <Text style={styles.meta}>{warranty.coverage}</Text>
                      <Text style={styles.meta}>{t('booking.warranty.expires', { t: fullDateISO(warranty.expiresAt) })}</Text>
                    </>
                  ) : (
                    <Text style={styles.meta}>{t('booking.warranty.notIssued')}</Text>
                  )}
                </Card>

                <Card style={{ gap: Spacing.sm }}>
                  <Text style={styles.value}>{t('booking.proof.title')}</Text>
                  {docError ? (
                    <Text style={[styles.meta, { color: Colors.danger }]}>{t('booking.docs.error')}</Text>
                  ) : proof ? (
                    <>
                      <Row style={{ justifyContent: 'space-between' }}>
                        <Text style={styles.meta}>{t('booking.proof.photos', { n: proof.photos.length })}</Text>
                        <Pill
                          label={proof.signatureStatus === 'signed' ? t('booking.proof.signed') : t('booking.proof.unsigned')}
                          tone={proof.signatureStatus === 'signed' ? 'success' : 'warning'}
                        />
                      </Row>
                      <Text style={styles.meta}>{t('booking.proof.completed', { t: fullDateISO(proof.completedAt) })}</Text>
                    </>
                  ) : (
                    <Text style={styles.meta}>{t('booking.proof.notIssued')}</Text>
                  )}
                </Card>

                {docError ? (
                  <Btn label={t('common.retry')} onPress={loadDocuments} variant="outline" size="sm" icon="refresh" />
                ) : null}
              </>
            )}
          </View>
        ) : null}

        <Text style={styles.section}>{t('booking.timeline')}</Text>
        <Card style={{ gap: Spacing.md }}>
          {booking.events.length === 0 ? (
            <Text style={styles.meta}>{t('booking.noEvents')}</Text>
          ) : (
            [...booking.events].reverse().map((ev, i) => (
              <View key={i}>
                <Row style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: Spacing.sm }}>
                  <Row gap={Spacing.sm} style={{ flex: 1, flexWrap: 'wrap' }}>
                    <Pill label={t(`status.${ev.status}` as I18nKey)} tone={statusTone[ev.status] ?? 'neutral'} />
                    <Text style={styles.value} numberOfLines={1}>{ev.by}</Text>
                  </Row>
                  <Text style={[styles.meta, { flexShrink: 0 }]}>{fullDateISO(ev.at)}</Text>
                </Row>
                {ev.note ? <Text style={[styles.meta, { marginTop: 2 }]}>{ev.note}</Text> : null}
                {i < booking.events.length - 1 ? <Divider style={{ marginTop: Spacing.sm }} /> : null}
              </View>
            ))
          )}
        </Card>

        <View style={{ gap: Spacing.md, marginTop: Spacing.lg }}>
          {confirmable ? (
            <Row gap={Spacing.sm}>
              <Btn label={t('booking.complete')} onPress={complete} loading={busy} variant="success" style={{ flex: 1 }} />
              <Btn
                label={t('booking.problem')}
                onPress={() => router.push({ pathname: '/support', params: { bookingId } })}
                variant="outline"
                style={{ flex: 1 }}
              />
            </Row>
          ) : null}
          {cancellable ? <Btn label={t('booking.cancel')} onPress={() => setCancelOpen(true)} variant="outline" /> : null}
          <Btn
            label={t('order.support')}
            onPress={() => router.push({ pathname: '/support', params: { bookingId } })}
            variant="subtle"
            icon="chatbubble-ellipses-outline"
          />
        </View>

        <SheetModal visible={cancelOpen} onClose={() => setCancelOpen(false)} title={t('booking.cancelTitle')}>
          <Field label={t('booking.cancelReason')} value={reason} onChangeText={setReason} placeholder={t('booking.cancelReasonPlaceholder')} multiline />
          <Btn label={t('booking.cancel')} onPress={cancel} loading={busy} variant="danger" />
        </SheetModal>

        <SheetModal visible={rejectOpen} onClose={() => setRejectOpen(false)} title={t('booking.quote.rejectTitle')}>
          <Field
            label={t('booking.quote.rejectReason')}
            value={rejectReason}
            onChangeText={setRejectReason}
            placeholder={t('booking.quote.rejectReasonPlaceholder')}
            multiline
            maxLength={500}
          />
          <Btn label={t('booking.quote.reject')} onPress={() => decideQuote('declined')} loading={busy} variant="danger" />
        </SheetModal>

        {booking.quoteAskProvider ? (
          <SheetModal visible={askOpen} onClose={() => setAskOpen(false)} title={t('booking.quote.askTitle')}>
            <Field
              label={t('booking.quote.askNote')}
              value={askNote}
              onChangeText={setAskNote}
              placeholder={t('booking.quote.askNotePlaceholder')}
              multiline
              maxLength={500}
            />
            <Btn label={t('booking.quote.askProvider')} onPress={() => decideQuote('ask_provider')} loading={busy} variant="outline" />
          </SheetModal>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text, marginBottom: Spacing.md },
  section: { fontSize: FontSize.lg, fontFamily: Fonts.sansExtraBold, color: Colors.text, marginTop: Spacing.lg, marginBottom: Spacing.sm },
  avatar: { width: 48, height: 48, borderRadius: Radius.md, backgroundColor: Colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  value: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansMedium },
  meta: { fontSize: FontSize.xs, color: Colors.textSecondary, fontFamily: Fonts.sans, marginTop: 2 },
  revisedBanner: { borderWidth: 1, borderColor: Colors.warning, paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md, borderRadius: Radius.md, overflow: 'hidden' },
});
