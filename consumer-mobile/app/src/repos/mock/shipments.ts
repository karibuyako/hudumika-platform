/* In-memory shipments repository — GET /shipments, GET /shipments/{id}.
 *
 * The contract Shipment payload carries the logistics envelope only (id,
 * shipmentNumber, orderId, packages, status); the consumer shipment surface
 * (waybill trail, tracking phases, route legs) is a mock-only extension
 * (docs/CONTRACT-ADDITIONS.md #8) served here from the seeded orders'
 * route/waybill/phases data — the same data tracking already renders.
 *
 * The shipment route is reached with an ORDER id today (/shipment/{order.id},
 * src/app/order/[orderId].tsx), so get() resolves records by shipment id OR
 * orderId; everything else 404s SHIPMENT_NOT_FOUND.
 */
import { ApiError } from '@/api/client';
import { clone, getState, nowIso, phaseForOrder } from './mockState';
import type { RouteSegment, Shipment, ShipmentStatus } from '@hudumika/contract';
import type { ShipmentDetail, ShipmentsRepository } from '../index';

/** Mock-only local route for the warehouse shipment — the seeded warehouse
 * order has no intercity/relay route (its dispatch is a warehouse first-mile
 * + last-mile hop), so the shipment builds its own two-leg route. */
function warehouseRoute(): RouteSegment[] {
  return [
    { legId: 'leg_w1', sequence: 1, type: 'first_mile', mode: 'van', status: 'completed', plannedStartAt: nowIso(), startedAt: nowIso(), completedAt: nowIso() },
    { legId: 'leg_w2', sequence: 2, type: 'last_mile', mode: 'motorcycle', status: 'in_progress', plannedStartAt: nowIso(), etaAt: new Date(Date.now() + 45 * 60_000).toISOString() },
  ];
}

/** Seeded shipment records — one per shipment-capable order. Status mirrors
 * the logistics state the tracking surfaces already render (intercity/relay
 * linehaul in motion → in_transit; warehouse out_for_delivery phase active). */
const SEEDED_SHIPMENTS: { id: string; orderId: string; shipmentNumber: string; status: ShipmentStatus; route?: () => RouteSegment[] }[] = [
  { id: 'shp_1042', orderId: 'ord_intercity_002', shipmentNumber: 'SH-1042-MWZ', status: 'in_transit' },
  { id: 'shp_2048', orderId: 'ord_relay_005', shipmentNumber: 'SH-2048-DAR', status: 'in_transit' },
  { id: 'shp_1107', orderId: 'ord_warehouse_003', shipmentNumber: 'SH-1107-DAR', status: 'out_for_delivery', route: warehouseRoute },
];

function buildDetail(seed: (typeof SEEDED_SHIPMENTS)[number]): ShipmentDetail {
  const state = getState();
  const order = state.orders.find((o) => o.id === seed.orderId);
  if (!order) throw new ApiError(404, 'SHIPMENT_NOT_FOUND', `Shipment for order ${seed.orderId} not found`);
  return {
    id: seed.id,
    shipmentNumber: seed.shipmentNumber,
    orderId: seed.orderId,
    status: seed.status,
    createdAt: order.createdAt,
    waybill: state.waybills.get(seed.orderId) ?? null,
    phases: phaseForOrder(order),
    route: seed.route ? seed.route() : (state.routes.get(seed.orderId) ?? null),
  };
}

export class MockShipmentsRepository implements ShipmentsRepository {
  async listMine(params?: { status?: string; cursor?: string; limit?: number }): Promise<Shipment[]> {
    let list: ShipmentDetail[] = SEEDED_SHIPMENTS.map(buildDetail);
    if (params?.status) list = list.filter((s) => s.status === params.status);
    const offset = params?.cursor ? Number(params.cursor) : 0;
    const limit = params?.limit ?? 20;
    return clone(list.slice(offset, offset + limit).map(({ waybill: _w, phases: _p, route: _r, ...rest }) => rest));
  }

  async get(shipmentId: string): Promise<ShipmentDetail> {
    const seed = SEEDED_SHIPMENTS.find((s) => s.id === shipmentId || s.orderId === shipmentId);
    if (!seed) throw new ApiError(404, 'SHIPMENT_NOT_FOUND', `Shipment ${shipmentId} not found`);
    return clone(buildDetail(seed));
  }
}
