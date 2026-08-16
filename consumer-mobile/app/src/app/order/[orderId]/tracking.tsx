import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';

import { ErrorState, Screen, SkeletonCard } from '@/components/ui';
import { OrderTrackingView } from '@/components/OrderTrackingView';
import { Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { getOrdersRepository } from '@/repos';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { TRACKING_EVENTS } from '@/store/events';
import { track } from '@/lib/analytics';
import type { GetOrderWaybill200, OrderDetail, RouteSegment, TrackingEvent, TrackingPhase } from '@hudumika/contract';
import { ApiError } from '@/api/client';
import { idempotencyKey } from '@/lib/idempotency';
import { shareContent } from '@/lib/share';
import { useNetworkStore } from '@/store/network';
import { toast } from '@/store/ui';
import type { DeliveryWindow, RouteCities } from '@/repos';

const POLL_MS = 15000;

export default function TrackingScreen() {
  const router = useRouter();
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  const online = useNetworkStore((s) => s.online);
  const [tracking, setTracking] = useState<TrackingEvent | null>(null);
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [phases, setPhases] = useState<TrackingPhase[] | null>(null);
  const [route, setRoute] = useState<RouteSegment[] | null>(null);
  const [waybill, setWaybill] = useState<GetOrderWaybill200 | null>(null);
  // Mock-only until the contract carries the window/city fields
  // (docs/CONTRACT-ADDITIONS.md #5): the live repo returns null, so the
  // window card and the origin → destination line render only on data.
  const [deliveryWindow, setDeliveryWindow] = useState<DeliveryWindow | null>(null);
  const [routeCities, setRouteCities] = useState<RouteCities | null>(null);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setError('');
    try {
      const [track, detail] = await Promise.all([
        getOrdersRepository().track(orderId),
        getOrdersRepository().get(orderId),
      ]);
      setTracking(track);
      setOrder(detail);
      setNotFound(false);
      if (detail.fulfillmentType === 'intercity' || detail.fulfillmentType === 'relay') {
        try {
          const [ph, rt, wb, dw, rc] = await Promise.all([
            getOrdersRepository().getTrackingPhases(orderId),
            getOrdersRepository().getRoute(orderId),
            getOrdersRepository().getWaybill(orderId),
            getOrdersRepository().getDeliveryWindow(orderId),
            getOrdersRepository().getRouteCities(orderId),
          ]);
          setPhases(ph);
          setRoute(rt);
          setWaybill(wb);
          setDeliveryWindow(dw);
          setRouteCities(rc);
        } catch (e) {
          // 404 on any of the three endpoints is a hard "Tracking unavailable"
          // state — never silently fall back to "No tracking events yet".
          if (e instanceof ApiError && e.status === 404) {
            setNotFound(true);
            setError(t('track.unavailable'));
            return;
          }
          // Transient failure (e.g. a poll hit a 5xx): keep last-known data.
          setPhases((prev) => prev ?? []);
          setRoute((prev) => prev ?? []);
          setWaybill((prev) => prev ?? null);
        }
      } else if (detail.fulfillmentSource === 'warehouse') {
        try {
          setPhases(await getOrdersRepository().getTrackingPhases(orderId));
        } catch (e) {
          if (e instanceof ApiError && e.status === 404) {
            setNotFound(true);
            setError(t('track.unavailable'));
            return;
          }
          setPhases((prev) => prev ?? []);
        }
      }
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        setNotFound(true);
        setError(t('track.unavailable'));
      } else if (!silent) {
        setError(t('common.error'));
      }
    }
  }, [orderId]);

  useEffect(() => {
    load();
    track({ name: 'tracking_viewed', orderId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll ~15s (React Query-style refetchInterval). Never compute an ETA client-side.
  useEffect(() => {
    const timer = setInterval(() => load(true), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Realtime (blueprint §25 + NOTIFICATIONS.md logistics table): the full
  // customer-facing logistics set refetches route + waybill + phases
  // immediately instead of waiting for the next poll tick. The 15s poll stays
  // as the safety net for events that never fire.
  useLiveRefresh(TRACKING_EVENTS, () => load(true));

  /* Dev-only demo hook for the intercity delay simulation (E2E T3/T6): the
   * mock's simulateIntercityDelay pushes a waybill exception + shifts the
   * linehaul ETA, then publishes intercity.eta_updated/waybill.updated —
   * the same events the tracking live-refresh refetches on. Screens never
   * import mock modules; this lazy import stays inside the dev gate so the
   * production bundle only carries the chunk behind the dev check. */
  const isDev = process.env.EXPO_PUBLIC_ENV !== 'production';
  const simulateDelay = async () => {
    if (!isDev || order?.id !== 'ord_intercity_002') return;
    const mock = await import('@/repos/mock/mockState');
    mock.simulateIntercityDelay(mock.getState());
    load(true);
  };

  // Masked call — POST /orders/{id}/masked-call (number privacy, blueprint §19).
  const [maskedBusy, setMaskedBusy] = useState(false);
  const startMaskedCall = async () => {
    setMaskedBusy(true);
    try {
      const session = await getOrdersRepository().createMaskedCall(orderId, idempotencyKey('cus_1', 'masked-call'));
      toast(t('track.maskedCallReady', { number: session.maskedNumber }));
    } catch {
      toast(t('common.error'), 'error');
    } finally {
      setMaskedBusy(false);
    }
  };

  /* Trip share (OPERATIONS-COVERAGE #77, docs/CONTRACT-ADDITIONS.md #27,
   * mock-first): POST /orders/{id}/tracking-share issues the short-lived
   * token, then the share sheet carries the payload with the
   * hudumika://track-share/{token} deep link (share.ts node-safe helper — on
   * web it copies to the clipboard, and without any share surface it reports
   * failure, same as the order share button). */
  const [sharing, setSharing] = useState(false);
  const shareTrip = async () => {
    if (!order) return;
    setSharing(true);
    try {
      const share = await getOrdersRepository().createTrackingShare(orderId, idempotencyKey('cus_1', 'tracking-share'));
      const shared = await shareContent(t('tripShare.message', { link: `hudumika://track-share/${share.token}` }));
      if (!shared) toast(t('share.failed'));
    } catch {
      toast(t('common.error'), 'error');
    } finally {
      setSharing(false);
    }
  };

  if (notFound) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (!tracking || !order) {
    return (
      <Screen>
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={3} />
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  return (
    <OrderTrackingView
      order={order}
      tracking={tracking}
      phases={phases}
      route={route}
      waybill={waybill}
      deliveryWindow={deliveryWindow}
      routeCities={routeCities}
      online={online}
      sharing={sharing}
      onShare={shareTrip}
      onBack={() => router.back()}
      onSupport={() => router.push({ pathname: '/support', params: { orderId } })}
      onReview={() => router.push({ pathname: '/review', params: { orderId } })}
      onMaskedCall={startMaskedCall}
      maskedBusy={maskedBusy}
      onSimulateDelay={isDev ? simulateDelay : undefined}
    />
  );
}
