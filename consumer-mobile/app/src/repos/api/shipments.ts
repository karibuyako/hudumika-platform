/* Live API shipments repository — GET /shipments, GET /shipments/{id}
 * (contract listShipments / getShipment — generated, READ-ONLY). */
import { api } from '@/api/client';
import type { Shipment } from '@hudumika/contract';
import type { ShipmentDetail, ShipmentsRepository } from '../index';

export class ApiShipmentsRepository implements ShipmentsRepository {
  async listMine(params?: { status?: string; cursor?: string; limit?: number }): Promise<Shipment[]> {
    const qs = new URLSearchParams(
      Object.entries(params ?? {}).filter(([, v]) => v !== undefined) as [string, string][],
    ).toString();
    return api.get<Shipment[]>(`/shipments${qs ? `?${qs}` : ''}`);
  }

  async get(shipmentId: string): Promise<ShipmentDetail> {
    const shipment = await api.get<Shipment>(`/shipments/${shipmentId}`);
    // Mock-only until the contract ships the waybill trail, tracking phases
    // and route legs on the shipment payload (docs/CONTRACT-ADDITIONS.md #8):
    // the live payload carries the logistics envelope only — the screen
    // renders the sections from the order surfaces when the extras are null.
    return { ...shipment, waybill: null, phases: null, route: null };
  }
}
