import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { CountdownPill } from '@/components/CountdownPill';
import { InvoiceCard } from '@/components/InvoiceCard';
import { ProofUpload } from '@/components/ProofUpload';
import { QuoteComposer } from '@/components/QuoteComposer';
import { StatusPill } from '@/components/StatusPill';
import { Btn, Card, ConfirmDialog, Field, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, NumberStyle, Radius, Spacing } from '@/constants/theme';
import { formatTZS, t } from '@/i18n';
import type { I18nKey } from '@/i18n';
import { advanceStepFor, CANCELLABLE_STATUSES, isDisputeHeld, quoteStatusMeta } from '@/lib/booking';
import { capitalize, dateISO, DECLINE_REASONS, maskPhone, minutesLabel } from '@/lib/format';
import { navigateToCoords } from '@/lib/config';
import { announce } from '@/lib/motion';
import { getBookingsRepository, getDispatchRepository, getServicesRepository, getTechniciansRepository } from '@/repos';
import { useSessionStore } from '@/store/session';
import type {
  BookingDetail,
  BookingQuote,
  PartsLine,
  ProofOfService,
  ServiceInvoice,
  ServiceWarranty,
  Technician,
} from '@hudumika/contract';

type BookingDetailExt = BookingDetail & {
  paused?: boolean;
  proof?: ProofOfService;
  invoice?: ServiceInvoice;
  warranty?: ServiceWarranty;
  manualOverride?: boolean;
};

/** Simulated device position — near the mock address so the happy path passes the geofence. */
const DEVICE_POS = { lat: -6.79, lon: 39.21 };

const INCOMING_ACCEPT_STATUSES = ['offered', 'provider_requested', 'provider_accepted', 'scheduled'];
const INVOICE_ISSUABLE = ['in_progress', 'completion_review', 'awaiting_customer_confirmation', 'completed', 'settled', 'warranty'];

export default function BookingDetailScreen() {
  const { bookingId } = useLocalSearchParams<{ bookingId: string }>();
  const capabilities = useSessionStore((s) => s.capabilities);

  const [booking, setBooking] = useState<BookingDetailExt | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [estimateHint, setEstimateHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [sheetError, setSheetError] = useState('');

  const [advancing, setAdvancing] = useState(false);
  const [checkingIn, setCheckingIn] = useState(false);
  const [geofenceBlocked, setGeofenceBlocked] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [proofing, setProofing] = useState(false);
  const [partSing, setPartSing] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [invoicing, setInvoicing] = useState(false);
  const [warrantying, setWarrantying] = useState(false);

  const [assignVisible, setAssignVisible] = useState(false);
  const [technicians, setTechnicians] = useState<Technician[]>([]);
  const [techniciansLoading, setTechniciansLoading] = useState(false);

  const [declineVisible, setDeclineVisible] = useState(false);
  const [declineReason, setDeclineReason] = useState('');

  const [quoteVisible, setQuoteVisible] = useState(false);
  const [proofVisible, setProofVisible] = useState(false);

  const [partsVisible, setPartsVisible] = useState(false);
  const [partsRows, setPartsRows] = useState<PartsLine[]>([]);

  const [cancelVisible, setCancelVisible] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [pauseVisible, setPauseVisible] = useState(false);
  const [pauseReason, setPauseReason] = useState('');
  const [completeVisible, setCompleteVisible] = useState(false);

  const [invoiceVisible, setInvoiceVisible] = useState(false);
  const [labor, setLabor] = useState('');
  const [discount, setDiscount] = useState('');
  const [invoiceNote, setInvoiceNote] = useState('');

  const [warrantyVisible, setWarrantyVisible] = useState(false);
  const [validDays, setValidDays] = useState('');
  const [coverage, setCoverage] = useState('');
  const [followUp, setFollowUp] = useState('');

  const load = useCallback(
    async (silent = false) => {
      if (!silent) {
        setLoading(true);
        setError('');
      }
      try {
        const b = (await getBookingsRepository().getBooking(bookingId)) as BookingDetailExt;
        setBooking(b);
        getServicesRepository()
          .list()
          .then((svcs) => {
            const s = svcs.find((x) => x.id === b.serviceId);
            if (s) setDuration(s.durationMinutes);
          })
          .catch(() => undefined);
        getBookingsRepository()
          .getEstimatePreview(bookingId)
          .then((e) => setEstimateHint(`${formatTZS(e.lowTZS)}–${formatTZS(e.highTZS)}`))
          .catch(() => undefined);
      } catch (e) {
        if (!silent) {
          const err = e instanceof ApiError ? e : null;
          if (err && (err.status === 403 || err.status === 404)) {
            // Deep-link validation: the booking is not yours or does not exist
            // for this role — bounce back to the jobs list.
            announce(t('booking.announceNotFound'));
            router.replace('/jobs');
            return;
          }
          setError(err ? err.message : t('misc.error'));
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [bookingId],
  );

  useEffect(() => {
    load();
  }, [load]);

  const openAssign = useCallback(() => {
    setAssignVisible(true);
    setSheetError('');
    setTechniciansLoading(true);
    getTechniciansRepository()
      .list()
      .then((techs) => setTechnicians([...techs].sort((a, b) => (a.status === 'idle' ? -1 : b.status === 'idle' ? 1 : 0))))
      .catch((e) => setSheetError(e instanceof ApiError ? e.message : t('misc.error')))
      .finally(() => setTechniciansLoading(false));
  }, []);

  const runBookingMutation = useCallback(
    async (fn: () => Promise<BookingDetailExt | void>, onSuccess?: (b: BookingDetailExt) => void) => {
      setActionError('');
      try {
        const res = await fn();
        if (res) {
          setBooking(res);
          onSuccess?.(res);
        }
      } catch (e) {
        const err = e instanceof ApiError ? e : null;
        if (err?.status === 409) {
          setActionError(err.message);
          announce(t('booking.announceUpdated'));
          load(true);
        } else {
          setActionError(err ? err.message : t('misc.error'));
        }
      }
    },
    [load],
  );

  const onAdvance = async () => {
    if (!booking) return;
    const step = advanceStepFor(booking.status, booking.quoteStatus !== undefined);
    if (!step) return;
    setAdvancing(true);
    await runBookingMutation(async () => {
      const updated = await getBookingsRepository().advance(booking.id, step.to);
      return updated as BookingDetailExt;
    });
    setAdvancing(false);
  };

  const onCheckIn = async () => {
    if (!booking) return;
    setCheckingIn(true);
    setGeofenceBlocked(false);
    try {
      const updated = await getBookingsRepository().checkIn(booking.id, DEVICE_POS.lat, DEVICE_POS.lon);
      setBooking(updated as BookingDetailExt);
      load(true);
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.status === 409 && err.code === 'CHECK_IN_NOT_ALLOWED') {
        setGeofenceBlocked(true);
      } else if (err?.status === 409) {
        setActionError(err.message);
        load(true);
      } else {
        setActionError(err ? err.message : t('misc.error'));
      }
    } finally {
      setCheckingIn(false);
    }
  };

  const onAccept = async () => {
    if (!booking) return;
    setAccepting(true);
    await runBookingMutation(async () => {
      const updated = await getBookingsRepository().accept(booking.id);
      return updated as BookingDetailExt;
    });
    setAccepting(false);
  };

  const onDecline = async () => {
    if (!booking) return;
    setDeclining(true);
    setSheetError('');
    try {
      await getBookingsRepository().decline(booking.id, declineReason.trim() || undefined);
      setDeclineVisible(false);
      load(true);
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.status === 409) {
        setSheetError(err.message);
        load(true);
      } else {
        setSheetError(err ? err.message : t('misc.error'));
      }
    } finally {
      setDeclining(false);
    }
  };

  const onAssign = async (tech: Technician) => {
    if (!booking) return;
    setAssigning(true);
    setSheetError('');
    try {
      await getDispatchRepository().assignTechnician(booking.id, tech.id ?? '');
      setAssignVisible(false);
      load(true);
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.status === 409) {
        setSheetError(err.message);
        load(true);
      } else {
        setSheetError(err ? err.message : t('dispatcher.assignError'));
      }
    } finally {
      setAssigning(false);
    }
  };

  const onSubmitQuote = async (quote: BookingQuote) => {
    if (!booking) return;
    setQuoting(true);
    setSheetError('');
    try {
      const updated = await getBookingsRepository().submitQuote(booking.id, quote);
      setBooking(updated as BookingDetailExt);
      setQuoteVisible(false);
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.status === 409) {
        setSheetError(err.message);
        load(true);
      } else {
        setSheetError(err ? err.message : t('misc.error'));
      }
    } finally {
      setQuoting(false);
    }
  };

  const onSubmitProof = async (type: ProofOfService['type'], value: string) => {
    if (!booking) return;
    setProofing(true);
    setSheetError('');
    try {
      const updated = await getBookingsRepository().submitProof(booking.id, type, value);
      setBooking(updated as BookingDetailExt);
      setProofVisible(false);
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.status === 409) {
        setSheetError(err.message);
        load(true);
      } else {
        setSheetError(err ? err.message : t('misc.error'));
      }
    } finally {
      setProofing(false);
    }
  };

  const onSubmitParts = async () => {
    if (!booking) return;
    const clean = partsRows.filter((p) => p.name.trim()).map((p) => ({ name: p.name.trim(), quantity: Math.max(1, Math.round(p.quantity)), unitCostTZS: Math.round(p.unitCostTZS) }));
    if (clean.length === 0) return;
    setPartSing(true);
    setSheetError('');
    try {
      const updated = await getBookingsRepository().addParts(booking.id, clean);
      setBooking(updated as BookingDetailExt);
      setPartsVisible(false);
      setPartsRows([]);
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.status === 409) {
        setSheetError(err.message);
        load(true);
      } else {
        setSheetError(err ? err.message : t('misc.error'));
      }
    } finally {
      setPartSing(false);
    }
  };

  const onComplete = async () => {
    if (!booking) return;
    setCompleting(true);
    await runBookingMutation(async () => {
      const updated = await getBookingsRepository().complete(booking.id);
      return updated as BookingDetailExt;
    });
    setCompleting(false);
    setCompleteVisible(false);
  };

  const onCancel = async () => {
    if (!booking) return;
    setCancelling(true);
    setSheetError('');
    try {
      await getBookingsRepository().cancel(booking.id, cancelReason.trim() || t('booking.cancelReasonPlaceholder'));
      setCancelVisible(false);
      load(true);
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.status === 409) {
        setSheetError(err.message);
        load(true);
      } else {
        setSheetError(err ? err.message : t('misc.error'));
      }
    } finally {
      setCancelling(false);
    }
  };

  const onPause = async () => {
    if (!booking) return;
    setPausing(true);
    setSheetError('');
    try {
      const updated = await getBookingsRepository().pause(booking.id, pauseReason.trim());
      setBooking(updated as BookingDetailExt);
      setPauseVisible(false);
      setPauseReason('');
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.status === 409) {
        setSheetError(err.message);
        load(true);
      } else {
        setSheetError(err ? err.message : t('misc.error'));
      }
    } finally {
      setPausing(false);
    }
  };

  const onResume = async () => {
    if (!booking) return;
    setResuming(true);
    await runBookingMutation(async () => {
      const updated = await getBookingsRepository().resume(booking.id);
      return updated as BookingDetailExt;
    });
    setResuming(false);
  };

  const onSubmitInvoice = async () => {
    if (!booking) return;
    const laborTZS = Number(labor);
    if (!Number.isInteger(laborTZS) || laborTZS <= 0) {
      setSheetError(t('misc.error'));
      return;
    }
    setInvoicing(true);
    setSheetError('');
    try {
      const invoice = await getBookingsRepository().issueInvoice(booking.id, laborTZS, discount ? Math.round(Number(discount)) : undefined, invoiceNote.trim() || undefined);
      setBooking((prev) => (prev ? { ...prev, invoice } : prev));
      setInvoiceVisible(false);
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.status === 409) {
        setSheetError(err.message);
        load(true);
      } else {
        setSheetError(err ? err.message : t('misc.error'));
      }
    } finally {
      setInvoicing(false);
    }
  };

  const onSubmitWarranty = async () => {
    if (!booking) return;
    const days = Number(validDays);
    if (!Number.isInteger(days) || days < 1) {
      setSheetError(t('misc.error'));
      return;
    }
    setWarrantying(true);
    setSheetError('');
    try {
      const warranty = await getBookingsRepository().issueWarranty(booking.id, days, coverage.trim() || undefined, followUp.trim() || undefined);
      setBooking((prev) => (prev ? { ...prev, warranty } : prev));
      setWarrantyVisible(false);
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.status === 409) {
        setSheetError(err.message);
        load(true);
      } else {
        setSheetError(err ? err.message : t('misc.error'));
      }
    } finally {
      setWarrantying(false);
    }
  };

  const onNavigate = () => {
    if (!booking) return;
    const { lat, lon } = booking.address;
    if (typeof lat !== 'number' || typeof lon !== 'number') return;
    void Linking.openURL(navigateToCoords(lat, lon));
  };

  if (loading) {
    return (
      <Screen>
        <View style={styles.center}>
          <ActivityIndicator color={Colors.primary} />
        </View>
      </Screen>
    );
  }

  if (error || !booking) {
    return (
      <Screen>
        <View style={styles.center}>
          <Text style={styles.error}>{error || t('misc.error')}</Text>
          <Btn label={t('misc.retry')} variant="ghost" onPress={load} />
        </View>
      </Screen>
    );
  }

  const quoteMeta = quoteStatusMeta(booking.quoteStatus);
  const isQuoteJob = booking.quoteStatus !== undefined;
  const step = advanceStepFor(booking.status, isQuoteJob);
  const needsQuote = booking.status === 'quote_required' || (booking.status === 'diagnosing' && isQuoteJob);
  // provider_arrived uses the geofenced check-in button instead of the plain advance step.
  const arrived = booking.status === 'provider_arrived';
  const showAdvance = !!step && !arrived && !(booking.status === 'diagnosing' && isQuoteJob);
  const isIncoming = INCOMING_ACCEPT_STATUSES.includes(booking.status);
  const cancellable = CANCELLABLE_STATUSES.includes(booking.status);
  const paused = booking.paused === true;
  const pausable = booking.status === 'in_progress' || booking.status === 'completion_review';
  const quoteDeclined = booking.quoteStatus === 'quote_declined';
  const slaDeadline = booking.slaDeadlineAt ? Date.parse(booking.slaDeadlineAt) : null;
  const hasProof = !!booking.proof;
  const invoice = booking.invoice ?? null;
  const warranty = booking.warranty ?? null;
  const canAssign = capabilities.includes('assign_technician');
  const hasCoords = typeof booking.address.lat === 'number' && typeof booking.address.lon === 'number';
  const invoiceIssuable = INVOICE_ISSUABLE.includes(booking.status);
  const busy = advancing || checkingIn || accepting || declining || assigning;

  const hasActions =
    isIncoming ||
    needsQuote ||
    showAdvance ||
    booking.status === 'completion_review' ||
    invoiceIssuable ||
    pausable ||
    cancellable;

  const sortedEvents = [...booking.events].reverse();

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Header */}
        <Card style={{ gap: Spacing.sm }}>
          <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <View style={{ flex: 1, paddingRight: Spacing.sm }}>
              <Text style={styles.serviceId}>{booking.serviceId}</Text>
              <Text style={styles.meta}>{dateISO(booking.scheduledFor)}</Text>
            </View>
            <StatusPill status={booking.status} />
          </Row>
          <Row gap={Spacing.sm} style={{ flexWrap: 'wrap' }}>
            {quoteMeta ? <Pill label={quoteMeta.label} tone={quoteMeta.tone} /> : null}
            {slaDeadline !== null ? <CountdownPill expiresAt={slaDeadline} dangerUnder={0} /> : null}
          </Row>
          {duration ? (
            <Row gap={6}>
              <Icon name="time-outline" size={13} color={Colors.textTertiary} />
              <Text style={styles.meta}>{t('booking.duration')} · {minutesLabel(duration)}</Text>
            </Row>
          ) : null}
          {booking.price ? (
            <Row style={{ justifyContent: 'space-between', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border, paddingTop: Spacing.sm }}>
              <Text style={styles.totalLabel}>{t('invoice.total')}</Text>
              <Text style={styles.total}>{formatTZS(booking.price.totalTZS)}</Text>
            </Row>
          ) : null}
        </Card>

        {/* Customer */}
        <Card style={{ gap: Spacing.md }}>
          <Text style={styles.cardTitle}>{t('booking.customer')}</Text>
          <View style={{ gap: 2 }}>
            <Text style={styles.metaLabel}>{t('booking.address')}</Text>
            <Text style={styles.address}>
              {booking.address.label}
              {booking.address.lines ? `\n${booking.address.lines}` : ''}
              {booking.address.landmark ? `\n${booking.address.landmark}` : ''}
            </Text>
          </View>
          <Row gap={Spacing.sm}>
            <Icon name="call" size={13} color={Colors.textTertiary} />
            <Text style={styles.meta}>{maskPhone(booking.address.contactPhone)}</Text>
          </Row>
          {booking.description ? (
            <View style={{ gap: 2 }}>
              <Text style={styles.metaLabel}>{t('booking.description')}</Text>
              <Text style={styles.address}>{booking.description}</Text>
            </View>
          ) : null}
          {hasCoords ? (
            <Btn label={t('booking.action.navigate')} icon="navigate" variant="outline" size="sm" onPress={onNavigate} style={{ alignSelf: 'flex-start' }} />
          ) : null}
        </Card>

        {/* Technician */}
        <Card style={{ gap: Spacing.sm }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={styles.cardTitle}>{t('booking.technician')}</Text>
            {canAssign ? <Btn label={t('booking.action.assign')} variant="ghost" size="sm" onPress={openAssign} /> : null}
          </Row>
          {booking.technicianId ? (
            <Row gap={6}>
              <Icon name="person" size={14} color={Colors.textSecondary} />
              <Text style={styles.meta}>{booking.technicianId}</Text>
            </Row>
          ) : (
            <Text style={styles.meta}>{t('booking.unassigned')}</Text>
          )}
        </Card>

        {/* Banners */}
        {quoteDeclined ? (
          <View style={styles.warnBox}>
            <Icon name="alert-circle" size={14} color={Colors.danger} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.warnTitle}>{t('quotes.declined')}</Text>
              <Text style={styles.warnText}>{t('quotes.declinedSub')}</Text>
            </View>
            <Btn label={t('quotes.requote')} variant="ghost" size="sm" onPress={() => setQuoteVisible(true)} disabled={busy} />
          </View>
        ) : null}
        {booking.status === 'quote_required' ? (
          <View style={styles.infoBox}>
            <Icon name="information-circle" size={14} color={Colors.info} />
            <Text style={styles.infoText}>{t('booking.quoteRequired')}</Text>
          </View>
        ) : null}
        {arrived ? (
          geofenceBlocked ? (
            <View style={styles.warnBox}>
              <Icon name="alert-circle" size={14} color={Colors.warning} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.warnTitle}>{t('booking.checkInOutOfRange')}</Text>
                <Text style={styles.warnText}>{t('booking.checkInHint')}</Text>
              </View>
              <Btn label={t('booking.checkInManual')} variant="ghost" size="sm" onPress={onCheckIn} loading={checkingIn} disabled={busy} />
            </View>
          ) : (
            <View style={styles.infoBox}>
              <Icon name="information-circle" size={14} color={Colors.info} />
              <Text style={styles.infoText}>{t('booking.checkInHint')}</Text>
            </View>
          )
        ) : null}
        {booking.status === 'awaiting_customer_confirmation' ? (
          <View style={styles.infoBox}>
            <Icon name="information-circle" size={14} color={Colors.info} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.infoText}>{t('booking.awaitingConfirmSub')}</Text>
              {!hasProof ? <Text style={styles.meta}>{t('proof.required')}</Text> : null}
            </View>
          </View>
        ) : null}
        {paused ? (
          <View style={styles.warnBox}>
            <Icon name="pause-circle" size={14} color={Colors.warning} />
            <View style={{ flex: 1 }}>
              <Text style={styles.warnText}>{t('booking.pausedSub')}</Text>
            </View>
            <Btn label={t('booking.action.resume')} variant="ghost" size="sm" onPress={onResume} loading={resuming} />
          </View>
        ) : null}
        {isDisputeHeld(booking.status) ? (
          <View style={styles.dangerBox}>
            <Icon name="alert-circle" size={14} color={Colors.danger} />
            <Text style={styles.dangerText}>{t('booking.disputedSub')}</Text>
          </View>
        ) : null}
        {booking.status === 'escalated' ? (
          <View style={styles.dangerBox}>
            <Icon name="alert-circle" size={14} color={Colors.danger} />
            <Text style={styles.dangerText}>{t('booking.escalatedSub')}</Text>
          </View>
        ) : null}
        {booking.status === 'no_show' ? (
          <View style={styles.dangerBox}>
            <Icon name="person-remove-outline" size={14} color={Colors.danger} />
            <Text style={styles.dangerText}>{t('booking.noShow')}</Text>
          </View>
        ) : null}
        {booking.status === 'provider_late' ? (
          <View style={styles.warnBox}>
            <Icon name="time-outline" size={14} color={Colors.warning} />
            <View style={{ flex: 1 }}>
              <Text style={styles.warnText}>{t('booking.providerLate')}</Text>
            </View>
          </View>
        ) : null}
        {booking.status === 'reassignment' ? (
          <View style={styles.dangerBox}>
            <Icon name="git-branch-outline" size={14} color={Colors.danger} />
            <Text style={styles.dangerText}>{t('booking.reassignmentSub')}</Text>
          </View>
        ) : null}

        {/* Completion docs */}
        {hasProof ? (
          <Card style={{ gap: Spacing.sm }}>
            <Row gap={6}>
              <Icon name="checkmark-circle" size={16} color={Colors.success} />
              <Text style={styles.successText}>{t('proof.submitted')}</Text>
            </Row>
          </Card>
        ) : null}
        {invoice ? <InvoiceCard invoice={invoice} showStatus /> : null}
        {warranty ? (
          <Card style={{ gap: Spacing.sm }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.cardTitle}>{t('warranty.title')}</Text>
              {warranty.status ? <Pill label={t(`warranty.status.${warranty.status}`)} tone={warranty.status === 'active' ? 'success' : 'neutral'} /> : null}
            </Row>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.meta}>{t('warranty.validDays')}</Text>
              <Text style={styles.metaNum}>{warranty.validDays}</Text>
            </Row>
            {warranty.coverage ? (
              <View style={{ gap: 2 }}>
                <Text style={styles.metaLabel}>{t('warranty.coverage')}</Text>
                <Text style={styles.address}>{warranty.coverage}</Text>
              </View>
            ) : null}
            {warranty.followUpAt ? (
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={styles.meta}>{t('warranty.followUp')}</Text>
                <Text style={styles.meta}>{dateISO(warranty.followUpAt)}</Text>
              </Row>
            ) : null}
          </Card>
        ) : null}

        {/* Timeline */}
        {sortedEvents.length > 0 ? (
          <Card style={{ gap: Spacing.sm }}>
            <Text style={styles.cardTitle}>{t('booking.timeline')}</Text>
            {sortedEvents.map((ev, i) => (
              <View key={i} style={[styles.timelineRow, i > 0 && styles.timelineBorder]}>
                <View style={styles.timelineDot} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <StatusPill status={ev.status} />
                    <Text style={styles.meta}>{dateISO(ev.at)}</Text>
                  </Row>
                  <Text style={styles.meta}>{capitalize(ev.by)}</Text>
                  {ev.note ? <Text style={styles.note}>{ev.note}</Text> : null}
                </View>
              </View>
            ))}
          </Card>
        ) : null}
      </ScrollView>

      {/* Action bar */}
      {hasActions ? (
        <View style={styles.actionBar}>
          {actionError ? <Text style={styles.error}>{actionError}</Text> : null}

          {isIncoming ? (
            <Row gap={Spacing.md}>
              <Btn label={t('booking.action.accept')} icon="checkmark" onPress={onAccept} loading={accepting} disabled={busy} style={{ flex: 1 }} />
              <Btn label={t('booking.action.decline')} variant="outline" onPress={() => setDeclineVisible(true)} disabled={busy} style={{ flex: 1 }} />
            </Row>
          ) : null}

          {needsQuote ? (
            <Btn label={t('booking.action.quote')} icon="document-text" onPress={() => setQuoteVisible(true)} disabled={busy} />
          ) : arrived ? (
            <Btn
              label={geofenceBlocked ? t('booking.checkInManual') : t('booking.action.checkIn')}
              icon="location"
              onPress={onCheckIn}
              loading={checkingIn}
              disabled={busy}
            />
          ) : showAdvance ? (
            <Btn label={t(step.labelKey as I18nKey)} icon="arrow-forward" onPress={onAdvance} loading={advancing} disabled={busy} />
          ) : null}

          {booking.status === 'completion_review' ? (
            <>
              <Row gap={Spacing.md}>
                <Btn label={t('booking.action.proof')} variant="outline" icon="camera" onPress={() => setProofVisible(true)} disabled={busy} style={{ flex: 1 }} />
                <Btn label={t('booking.action.parts')} variant="outline" icon="construct" onPress={() => setPartsVisible(true)} disabled={busy} style={{ flex: 1 }} />
              </Row>
              <Btn
                label={t('booking.action.complete')}
                variant="success"
                icon="checkmark-done"
                onPress={() => setCompleteVisible(true)}
                loading={completing}
                disabled={busy}
              />
            </>
          ) : null}

          {invoiceIssuable ? (
            <Row gap={Spacing.md}>
              {invoice ? null : (
                <Btn label={t('booking.action.invoice')} variant="outline" icon="receipt-outline" onPress={() => setInvoiceVisible(true)} disabled={busy} style={{ flex: 1 }} />
              )}
              {warranty ? null : (
                <Btn label={t('booking.action.warranty')} variant="outline" icon="shield-checkmark-outline" onPress={() => setWarrantyVisible(true)} disabled={busy} style={{ flex: 1 }} />
              )}
            </Row>
          ) : null}

          {pausable ? (
            paused ? (
              <Btn label={t('booking.action.resume')} variant="ghost" onPress={onResume} loading={resuming} disabled={busy} />
            ) : (
              <Btn label={t('booking.action.pause')} variant="ghost" onPress={() => setPauseVisible(true)} disabled={busy} />
            )
          ) : null}

          {cancellable ? (
            <Btn label={t('booking.action.cancel')} variant="ghost" size="sm" onPress={() => setCancelVisible(true)} disabled={busy} style={{ alignSelf: 'center' }} />
          ) : null}
        </View>
      ) : null}

      {/* Technician picker */}
      <SheetModal visible={assignVisible} onClose={() => setAssignVisible(false)} title={t('booking.action.assign')}>
        {techniciansLoading ? <ActivityIndicator color={Colors.primary} /> : null}
        {sheetError && !techniciansLoading ? <Text style={styles.error}>{sheetError}</Text> : null}
        {technicians.map((tech) => {
          const onJob = tech.status === 'on_job';
          return (
            <Pressable
              key={tech.id ?? tech.phone}
              onPress={() => onAssign(tech)}
              disabled={onJob || assigning}
              accessibilityRole="button"
              accessibilityLabel={tech.name}
              style={({ pressed }) => [styles.techRow, onJob && styles.techRowBusy, pressed && { opacity: 0.7 }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.techName, onJob && { color: Colors.textTertiary }]}>{tech.name}</Text>
                <Text style={styles.meta}>{tech.trade}{tech.skills && tech.skills.length ? ` · ${tech.skills.slice(0, 2).join(', ')}` : ''}</Text>
              </View>
              {onJob ? <Pill label={t('technicians.status.on_job')} tone="warning" /> : <Pill label={t('technicians.status.idle')} tone="success" />}
            </Pressable>
          );
        })}
      </SheetModal>

      {/* Decline */}
      <SheetModal visible={declineVisible} onClose={() => setDeclineVisible(false)} title={t('booking.action.decline')}>
        {DECLINE_REASONS.map((r) => (
          <Pressable
            key={r}
            onPress={() => setDeclineReason(r)}
            accessibilityRole="button"
            accessibilityLabel={r}
            style={({ pressed }) => [styles.reasonRow, declineReason === r && styles.reasonRowActive, pressed && { opacity: 0.7 }]}>
            <Text style={styles.reasonText}>{r}</Text>
            {declineReason === r ? <Icon name="checkmark-circle" size={16} color={Colors.primaryDeep} /> : null}
          </Pressable>
        ))}
        <Field
          label={`${t('booking.declineReason')} (${t('misc.optional')})`}
          value={declineReason}
          onChangeText={setDeclineReason}
          maxLength={500}
          hint={t('booking.declineReasonMax')}
        />
        {sheetError ? <Text style={styles.error}>{sheetError}</Text> : null}
        <Btn label={t('booking.action.decline')} variant="danger" onPress={onDecline} loading={declining} size="lg" />
        <Btn label={t('misc.cancel')} variant="ghost" onPress={() => setDeclineVisible(false)} disabled={declining} />
      </SheetModal>

      {/* Quote */}
      <SheetModal visible={quoteVisible} onClose={() => setQuoteVisible(false)} title={t('quotes.title')}>
        <QuoteComposer onCancel={() => setQuoteVisible(false)} onSubmit={onSubmitQuote} loading={quoting} estimateHint={estimateHint} />
        {sheetError ? <Text style={styles.error}>{sheetError}</Text> : null}
      </SheetModal>

      {/* Proof */}
      <SheetModal visible={proofVisible} onClose={() => setProofVisible(false)} title={t('proof.title')}>
        <ProofUpload onSubmit={onSubmitProof} loading={proofing} onCancel={() => setProofVisible(false)} />
        {sheetError ? <Text style={styles.error}>{sheetError}</Text> : null}
      </SheetModal>

      {/* Parts */}
      <SheetModal visible={partsVisible} onClose={() => setPartsVisible(false)} title={t('parts.title')}>
        {partsRows.map((p, i) => (
          <Row key={i} gap={Spacing.sm}>
            <View style={{ flex: 2 }}>
              <Field label={t('parts.name')} value={p.name} onChangeText={(v) => setPartsRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, name: v } : r)))} />
            </View>
            <View style={{ flex: 1 }}>
              <Field label={t('parts.qty')} value={String(p.quantity)} onChangeText={(v) => setPartsRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, quantity: Number(v) || 1 } : r)))} keyboardType="number-pad" />
            </View>
            <View style={{ flex: 1 }}>
              <Field label={t('parts.unitCost')} value={String(p.unitCostTZS)} onChangeText={(v) => setPartsRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, unitCostTZS: Number(v) || 0 } : r)))} keyboardType="number-pad" />
            </View>
            <Pressable onPress={() => setPartsRows((rows) => rows.filter((_, idx) => idx !== i))} accessibilityRole="button" accessibilityLabel={t('parts.title')} hitSlop={8} style={{ paddingTop: Spacing.lg }}>
              <Icon name="trash-outline" size={18} color={Colors.danger} />
            </Pressable>
          </Row>
        ))}
        <Pressable
          onPress={() => setPartsRows((rows) => [...rows, { name: '', quantity: 1, unitCostTZS: 0 }])}
          accessibilityRole="button"
          style={({ pressed }) => [styles.addRow, pressed && { opacity: 0.7 }]}>
          <Icon name="add" size={16} color={Colors.primaryDeep} />
          <Text style={styles.addText}>{t('parts.add')}</Text>
        </Pressable>
        {sheetError ? <Text style={styles.error}>{sheetError}</Text> : null}
        <Btn label={t('parts.submit')} onPress={onSubmitParts} loading={partSing} disabled={partsRows.length === 0} size="lg" />
      </SheetModal>

      {/* Complete */}
      <ConfirmDialog
        visible={completeVisible}
        title={t('booking.action.complete')}
        sub={hasProof ? undefined : t('proof.required')}
        confirmLabel={t('booking.action.complete')}
        cancelLabel={t('misc.cancel')}
        onConfirm={onComplete}
        onCancel={() => setCompleteVisible(false)}
        loading={completing}
      />

      {/* Cancel */}
      <SheetModal visible={cancelVisible} onClose={() => setCancelVisible(false)} title={t('booking.cancelConfirm')}>
        <Text style={styles.sheetSub}>{t('booking.cancelConfirmSub')}</Text>
        <Field
          label={t('booking.cancelReason')}
          value={cancelReason}
          onChangeText={setCancelReason}
          placeholder={t('booking.cancelReasonPlaceholder')}
          maxLength={500}
        />
        {sheetError ? <Text style={styles.error}>{sheetError}</Text> : null}
        <Btn label={t('booking.action.cancel')} variant="danger" onPress={onCancel} loading={cancelling} size="lg" />
        <Btn label={t('misc.cancel')} variant="ghost" onPress={() => setCancelVisible(false)} disabled={cancelling} />
      </SheetModal>

      {/* Pause */}
      <SheetModal visible={pauseVisible} onClose={() => setPauseVisible(false)} title={t('booking.action.pause')}>
        <Field
          label={t('booking.cancelReason')}
          value={pauseReason}
          onChangeText={setPauseReason}
          placeholder={t('booking.cancelReasonPlaceholder')}
          maxLength={300}
        />
        {sheetError ? <Text style={styles.error}>{sheetError}</Text> : null}
        <Btn label={t('booking.action.pause')} onPress={onPause} loading={pausing} disabled={!pauseReason.trim()} size="lg" />
        <Btn label={t('misc.cancel')} variant="ghost" onPress={() => setPauseVisible(false)} disabled={pausing} />
      </SheetModal>

      {/* Invoice */}
      <SheetModal visible={invoiceVisible} onClose={() => setInvoiceVisible(false)} title={t('invoice.title')}>
        <Field label={`${t('invoice.labor')} (TZS)`} value={labor} onChangeText={setLabor} keyboardType="number-pad" />
        <Field label={`${t('invoice.discount')} (TZS)`} value={discount} onChangeText={setDiscount} keyboardType="number-pad" hint={t('misc.optional')} />
        <Field label={t('invoice.note')} value={invoiceNote} onChangeText={setInvoiceNote} multiline placeholder={t('quotes.notePlaceholder')} maxLength={500} />
        {sheetError ? <Text style={styles.error}>{sheetError}</Text> : null}
        <Btn label={t('invoice.issue')} onPress={onSubmitInvoice} loading={invoicing} size="lg" />
        <Btn label={t('misc.cancel')} variant="ghost" onPress={() => setInvoiceVisible(false)} disabled={invoicing} />
      </SheetModal>

      {/* Warranty */}
      <SheetModal visible={warrantyVisible} onClose={() => setWarrantyVisible(false)} title={t('warranty.title')}>
        <Field label={t('warranty.validDays')} value={validDays} onChangeText={setValidDays} keyboardType="number-pad" />
        <Field label={t('warranty.coverage')} value={coverage} onChangeText={setCoverage} multiline placeholder={t('warranty.coveragePlaceholder')} maxLength={1000} />
        <Field label={t('warranty.followUp')} value={followUp} onChangeText={setFollowUp} placeholder="YYYY-MM-DD" />
        {sheetError ? <Text style={styles.error}>{sheetError}</Text> : null}
        <Btn label={t('warranty.issue')} onPress={onSubmitWarranty} loading={warrantying} size="lg" />
        <Btn label={t('misc.cancel')} variant="ghost" onPress={() => setWarrantyVisible(false)} disabled={warrantying} />
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: Spacing.lg, paddingBottom: Spacing.xl, gap: Spacing.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md },
  error: { color: Colors.danger, fontSize: FontSize.sm },
  serviceId: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, letterSpacing: 0.2 },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600' },
  metaLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '700' },
  address: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 19 },
  cardTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  totalLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  total: { fontSize: FontSize.lg, color: Colors.primaryDeep, fontWeight: '800', fontVariant: NumberStyle.fontVariant },
  metaNum: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600', fontVariant: NumberStyle.fontVariant },
  warnBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.warningSoft,
    borderRadius: Radius.sm,
    padding: Spacing.sm,
  },
  warnTitle: { fontSize: FontSize.sm, color: Colors.warning, fontWeight: '800' },
  warnText: { fontSize: FontSize.xs, color: Colors.warning, fontWeight: '700' },
  infoBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.infoSoft,
    borderRadius: Radius.sm,
    padding: Spacing.sm,
  },
  infoText: { flex: 1, fontSize: FontSize.xs, color: Colors.info, fontWeight: '700' },
  dangerBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.dangerSoft,
    borderRadius: Radius.sm,
    padding: Spacing.sm,
  },
  dangerText: { flex: 1, fontSize: FontSize.xs, color: Colors.danger, fontWeight: '700' },
  successText: { fontSize: FontSize.sm, color: Colors.success, fontWeight: '700' },
  timelineRow: { flexDirection: 'row', gap: Spacing.sm },
  timelineBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border, paddingTop: Spacing.sm },
  timelineDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.borderStrong, marginTop: 4 },
  note: { fontSize: FontSize.xs, color: Colors.textSecondary, lineHeight: 16 },
  actionBar: {
    backgroundColor: Colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
    padding: Spacing.lg,
    gap: Spacing.sm,
  },
  techRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
  },
  techRowBusy: { opacity: 0.6 },
  techName: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '700' },
  reasonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.surface,
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  reasonRowActive: { borderColor: Colors.primary, backgroundColor: Colors.primarySoft },
  reasonText: { color: Colors.text, fontSize: FontSize.sm, fontWeight: '500' },
  sheetSub: { color: Colors.textSecondary, fontSize: FontSize.sm, textAlign: 'center', lineHeight: 19 },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
  addText: { color: Colors.primaryDeep, fontSize: FontSize.sm, fontWeight: '700' },
});
