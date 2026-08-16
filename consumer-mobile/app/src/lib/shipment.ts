/* Shipment surface helpers — shared by order/[orderId]/tracking.tsx and the
 * shipment/[shipmentId] screen (MASTER-BLUEPRINT §13 "Shipment view").
 *
 * Pure, server-data-only: day sections come from the route leg plan, the
 * delay banner ONLY from waybill exception events, and the header flag from
 * the order's fulfillmentType/waybillNumber. Nothing is fabricated here.
 */
import type { GetOrderWaybill200, OrderDetail, RouteSegment } from '@hudumika/contract';
import { dateISO } from '@/lib/dates';

/** Route legs grouped into Day 1 / Day 2 sections (label only — the times
 * stay server-side; `date` is the section label timestamp, `key` the group
 * id). Legs without any timestamp land in a trailing 'plan' group. */
export interface DaySection {
  key: string;
  date: string;
  day: number;
  legs: RouteSegment[];
}

export function buildDaySections(route?: RouteSegment[] | null): DaySection[] {
  if (!route || route.length === 0) return [];
  const out: { key: string; date: string; legs: RouteSegment[] }[] = [];
  for (const leg of route) {
    const at = leg.plannedStartAt ?? leg.startedAt ?? leg.etaAt ?? null;
    const day = at ? dateISO(at).slice(0, 10) : 'plan';
    let bucket = out.find((b) => b.key === day);
    if (!bucket) {
      bucket = { key: day, date: at ?? '', legs: [] };
      out.push(bucket);
    }
    bucket.legs.push(leg);
  }
  return out.map((b, i) => ({ ...b, day: i + 1 }));
}

/** Header facts for the shipment header card — the fulfillment pill shows for
 * intercity/relay orders only; the waybill number renders when present. */
export interface ShipmentHeaderData {
  fulfillmentType: 'intercity' | 'relay' | null;
  waybillNumber: string | null;
}

export function shipmentHeaderData(order?: OrderDetail | null): ShipmentHeaderData {
  const fulfillmentType =
    order && (order.fulfillmentType === 'intercity' || order.fulfillmentType === 'relay') ? order.fulfillmentType : null;
  return { fulfillmentType, waybillNumber: order?.waybillNumber ?? null };
}

/** Delay banner — present ONLY when the waybill carries an exception event;
 * the note comes from the latest exception event (never composed client-side). */
export interface DelayBanner {
  note: string | null;
}

export function delayBannerData(waybill?: GetOrderWaybill200 | null): DelayBanner | null {
  const exceptions = (waybill?.events ?? []).filter((e) => e.type === 'exception');
  if (exceptions.length === 0) return null;
  return { note: exceptions[exceptions.length - 1].note ?? null };
}
