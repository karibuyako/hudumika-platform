/* Read-only shared tracking (OPERATIONS-COVERAGE #77 "Share live location —
 * trip-share pattern", docs/CONTRACT-ADDITIONS.md #27, mock-first).
 *
 * The recipient of a trip-share link (hudumika://track-share/{token} — the
 * deep-link allow-list maps it here) resolves the token to the order id,
 * loads the order's tracking surfaces and renders the SAME tracking UI as
 * the owner screen through OrderTrackingView with readOnly: no share/support/
 * review/masked-call actions, no dev delay trigger — just the rider map,
 * ETA, phases and waybill trail. Unknown or expired tokens (404 NOT_FOUND /
 * 410 TRIP_SHARE_EXPIRED) render the "Tracking unavailable" state; the token
 * is generated + validated by the mock. */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';

import { ErrorState, Screen, SkeletonCard } from '@/components/ui';
import { OrderTrackingView } from '@/components/OrderTrackingView';
import { Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { getOrdersRepository } from '@/repos';
import { useNetworkStore } from '@/store/network';
import type { GetOrderWaybill200, OrderDetail, RouteSegment, TrackingEvent, TrackingPhase } from '@hudumika/contract';
import { ApiError } from '@/api/client';
import type { DeliveryWindow, RouteCities } from '@/repos';

const POLL_MS = 15000;

export default function TrackShareScreen() {
  const router = useRouter();
  const { token } = useLocalSearchParams<{ token: string }>();
  const online = useNetworkStore((s) => s.online);
  const [tracking, setTracking] = useState<TrackingEvent | null>(null);
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [phases, setPhases] = useState<TrackingPhase[] | null>(null);
  const [route, setRoute] = useState<RouteSegment[] | null>(null);
  const [waybill, setWaybill] = useState<GetOrderWaybill200 | null>(null);
  const [deliveryWindow, setDeliveryWindow] = useState<DeliveryWindow | null>(null);
  const [routeCities, setRouteCities] = useState<RouteCities | null>(null);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setError('');
    try {
      // The token is the only credential: resolve it (404/410 → unavailable),
      // then load the order's tracking surfaces like the owner screen.
      const resolved = await getOrdersRepository().resolveTrackingShare(token);
      if (!resolved) {
        setNotFound(true);
        setError(t('track.unavailable'));
        return;
      }
      const [track, detail] = await Promise.all([
        getOrdersRepository().track(resolved.orderId),
        getOrdersRepository().get(resolved.orderId),
      ]);
      setTracking(track);
      setOrder(detail);
      setNotFound(false);
      if (detail.fulfillmentType === 'intercity' || detail.fulfillmentType === 'relay') {
        try {
          const [ph, rt, wb, dw, rc] = await Promise.all([
            getOrdersRepository().getTrackingPhases(resolved.orderId),
            getOrdersRepository().getRoute(resolved.orderId),
            getOrdersRepository().getWaybill(resolved.orderId),
            getOrdersRepository().getDeliveryWindow(resolved.orderId),
            getOrdersRepository().getRouteCities(resolved.orderId),
          ]);
          setPhases(ph);
          setRoute(rt);
          setWaybill(wb);
          setDeliveryWindow(dw);
          setRouteCities(rc);
        } catch (e) {
          if (e instanceof ApiError && e.status === 404) {
            setNotFound(true);
            setError(t('track.unavailable'));
            return;
          }
          setPhases((prev) => prev ?? []);
          setRoute((prev) => prev ?? []);
          setWaybill((prev) => prev ?? null);
        }
      } else if (detail.fulfillmentSource === 'warehouse') {
        try {
          setPhases(await getOrdersRepository().getTrackingPhases(resolved.orderId));
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
      // Expired/unknown share tokens (410 TRIP_SHARE_EXPIRED / 404) and an
      // order the token no longer exposes render as "Tracking unavailable".
      if (e instanceof ApiError && (e.status === 403 || e.status === 404 || e.status === 410 || e.code === 'TRIP_SHARE_EXPIRED')) {
        setNotFound(true);
        setError(t('track.unavailable'));
      } else if (!silent) {
        setError(t('common.error'));
      }
    }
  }, [token]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The shared view stays live: same 15s poll as the owner screen (the
  // safety net for live rider-location updates).
  useEffect(() => {
    const timer = setInterval(() => load(true), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (notFound || error) {
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
      readOnly
      onBack={() => router.back()}
    />
  );
}
