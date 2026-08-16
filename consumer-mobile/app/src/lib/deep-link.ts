/* Deep-link allow-list (SECURITY.md). Only these routes navigate from
 * notification/push payloads; every target screen refetches before render
 * (403/404 render as "not visible"); unknown payloads do nothing. */
import type { Href } from 'expo-router';

export const DEEP_LINK_ROUTES = ['order', 'booking', 'ticket', 'conversation', 'dine-in', 'reservation', 'red-packet', 'voucher', 'group-order', 'referral', 'split', 'track-share'] as const;

export type DeepLinkRoute = (typeof DEEP_LINK_ROUTES)[number];

/** True when the payload's first segment is on the allow-list. */
export function isAllowedDeepLink(deepLink?: string | null): deepLink is string {
  if (!deepLink) return false;
  const [route, id] = deepLink.split('/');
  if (!id) return false;
  return (DEEP_LINK_ROUTES as readonly string[]).includes(route);
}

/** Map a validated deepLink to an app route (or null when unknown). */
export function deepLinkHref(deepLink: string): Href | null {
  const [route, id] = deepLink.split('/');
  if (!id) return null;
  switch (route as DeepLinkRoute) {
    case 'order':
      return { pathname: '/order/[orderId]', params: { orderId: id } };
    case 'booking':
      return { pathname: '/booking/[bookingId]', params: { bookingId: id } };
    case 'ticket':
      return { pathname: '/support/[ticketId]', params: { ticketId: id } };
    case 'conversation':
      return { pathname: '/messages/[conversationId]', params: { conversationId: id } };
    // NOTIFICATIONS.md new-resource routes: each screen refetches its list on
    // mount, so the id segment is validated but the screens currently take no
    // param (dine-in.tsx / reservations.tsx / vouchers.tsx read none — the id
    // is carried for payload fidelity and future param-reading screens).
    case 'dine-in':
      return { pathname: '/dine-in' };
    case 'reservation':
      return { pathname: '/reservations' };
    // Red-packet share links (hudumika://red-packet/{shareCode}, P6c): the
    // red-packets screen takes no id param — it refetches the received list
    // on mount, so the shareCode is validated but the screen does not read
    // it (same pattern as dine-in/reservation/voucher above).
    case 'red-packet':
      return { pathname: '/red-packets' };
    case 'voucher':
      return { pathname: '/vouchers' };
    // Group-order invite links (hudumika://group-order/{id}, CONTRACT-ADDITIONS
    // #11): the target route takes an id param, so map the id segment through.
    case 'group-order':
      return { pathname: '/group-order/[groupId]', params: { groupId: id } };
    // Referral share links (hudumika://referral/{code}, M16f): the /referrals
    // screen reads the ?code= param and prefills the claim sheet.
    case 'referral':
      return { pathname: '/referrals', params: { code: id } };
    // Split share links (hudumika://split/{id}, CONTRACT-ADDITIONS #20): the
    // split summary screen takes an id param, so map the id segment through.
    case 'split':
      return { pathname: '/splits/[splitId]', params: { splitId: id } };
    // Trip-share links (hudumika://track-share/{token}, OPERATIONS-COVERAGE
    // #77 "Share live location"): the token is resolved server-side (mock)
    // to the order id and the read-only tracking screen renders; unknown or
    // expired tokens render its unavailable state.
    case 'track-share':
      return { pathname: '/track-share/[token]', params: { token: id } };
    default:
      return null;
  }
}

/**
 * Parse and validate a raw cold-start/background URL against the allow-list.
 * Accepts the custom scheme (`hudumika://order/ord_1`), an https/web host
 * (`https://app.hudumika.tz/order/ord_1`) or a bare payload (`order/ord_1`).
 * Returns the canonical `route/id` string, or null when unknown (the caller
 * then lands on the app root and does nothing further — deep-link.ts contract).
 */
export function parseAndValidateDeepLink(url: string): string | null {
  try {
    let path = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^\/+/, '');
    let segments = path.split(/[?#]/)[0].split('/').filter(Boolean);
    // scheme://host/route/id — drop the host segment (contains '.' or ':').
    if (segments.length >= 3 && (segments[0].includes('.') || segments[0].includes(':'))) {
      segments = segments.slice(1);
    }
    if (segments.length !== 2) return null;
    const [route, id] = segments;
    const deepLink = `${route}/${id}`;
    return isAllowedDeepLink(deepLink) ? deepLink : null;
  } catch {
    return null;
  }
}
