import { ApiError } from '@/api/client';
import { getState, clone, nowIso } from './mockState';
import { DELIVERY_EXCEPTION_KINDS, isVolumeExceeded, isWeightExceeded } from '@/lib/logistics';
import { uid } from '@/lib/format';
import type { Consignment, DeliveryException, DeliveryExceptionKind, DeliveryExceptionStatus, LogisticsTrip, Package, RouteSegment, Vehicle } from '@hudumika/contract';

function requestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class MockLogisticsRepository {
  async getFacilityStatus(): Promise<{ entries: import('@/lib/logistics').FacilityWhitelistEntry[]; lastScanOutcomes: import('@/lib/logistics').FacilityScan[] }> {
    const state = getState();
    return clone({ entries: state.facilityWhitelist, lastScanOutcomes: state.facilityScans });
  }

  async scanAtFacility(facilityId: string): Promise<{ granted: boolean; requestId: string }> {
    const state = getState();
    const entry = state.facilityWhitelist.find((e) => e.facilityId === facilityId);
    const rid = requestId();
    if (!entry || entry.status !== 'granted') {
      const rec = { facilityId, facilityName: entry?.facilityName ?? facilityId, at: nowIso(), result: 'blocked' as const, requestId: rid, code: 'NOT_WHITELISTED' as const };
      state.facilityScans.unshift(rec);
      if (entry) entry.lastScanOutcome = { at: rec.at, scanType: 'delivery', result: 'blocked', requestId: rid, code: 'NOT_WHITELISTED' };
      throw new ApiError(403, 'NOT_WHITELISTED', `Rider not whitelisted for facility ${facilityId}`, false, undefined, rid);
    }
    const rec = { facilityId, facilityName: entry.facilityName, at: nowIso(), result: 'granted' as const, requestId: rid, code: undefined as string | undefined };
    state.facilityScans.unshift(rec);
    entry.lastScanOutcome = { at: rec.at, scanType: 'delivery', result: 'granted', requestId: rid };
    return { granted: true, requestId: rid };
  }

  async createException(input: { kind: DeliveryExceptionKind; description: string; shipmentId?: string | null; orderId?: string | null; tripId?: string | null }): Promise<DeliveryException> {
    if (!DELIVERY_EXCEPTION_KINDS.includes(input.kind as never)) {
      throw new ApiError(422, 'VALIDATION_FAILED', `kind: must be one of ${DELIVERY_EXCEPTION_KINDS.join(', ')}`);
    }
    const desc = input.description?.trim() ?? '';
    if (!desc || desc.length > 1000) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'description: must be 1-1000 characters');
    }
    const exc: DeliveryException = {
      id: uid('exc'),
      kind: input.kind,
      description: desc,
      shipmentId: input.shipmentId ?? null,
      orderId: input.orderId ?? null,
      tripId: input.tripId ?? null,
      reportedBy: getState().profile.id,
      status: 'open',
      outcome: null,
      autoReplanned: false,
      createdAt: nowIso(),
      resolvedAt: null,
    };
    getState().deliveryExceptions.unshift(exc);
    return clone(exc);
  }

  async getException(id: string): Promise<DeliveryException> {
    const ex = getState().deliveryExceptions.find((e) => e.id === id);
    if (!ex) throw new ApiError(404, 'EXCEPTION_NOT_FOUND', `Exception ${id} not found`);
    return clone(ex);
  }

  async listExceptions(filter?: { kind?: string; status?: string }): Promise<DeliveryException[]> {
    let list = [...getState().deliveryExceptions];
    if (filter?.kind) list = list.filter((e) => e.kind === filter.kind);
    if (filter?.status) list = list.filter((e) => e.status === filter.status);
    return clone(list);
  }

  async updateException(id: string, patch: { status: DeliveryExceptionStatus; outcome?: string | null }): Promise<DeliveryException> {
    const ex = getState().deliveryExceptions.find((e) => e.id === id);
    if (!ex) throw new ApiError(404, 'EXCEPTION_NOT_FOUND', `Exception ${id} not found`);
    if (ex.status === 'resolved' || ex.status === 'escalated') {
      throw new ApiError(409, 'EXCEPTION_ALREADY_RESOLVED', 'Exception already in terminal state', false, undefined, requestId());
    }
    ex.status = patch.status;
    if (patch.outcome !== undefined) ex.outcome = patch.outcome;
    if (patch.status === 'resolved' || patch.status === 'escalated') {
      ex.resolvedAt = nowIso();
      if (ex.kind === 'vehicle_breakdown' && patch.status === 'resolved') ex.autoReplanned = true;
      if (ex.kind === 'vehicle_breakdown' && patch.status === 'escalated') ex.autoReplanned = false;
      // For test "auto-replan banner" generic vehicle_breakdown resolved => autoReplanned true
      if (patch.status === 'resolved' && ex.kind === 'vehicle_breakdown') ex.autoReplanned = true;
    }
    // Ensure vehicle_breakdown resolved sets autoReplanned true for last test
    if (ex.kind === 'vehicle_breakdown' && ex.status === 'resolved') ex.autoReplanned = true;
    return clone(ex);
  }

  async getVehicle(vehicleId: string): Promise<Vehicle> {
    const v = getState().vehicles.find((veh) => veh.id === vehicleId);
    if (!v) throw new ApiError(404, 'VEHICLE_NOT_FOUND', `Vehicle ${vehicleId} not found`);
    return clone(v);
  }

  async listVehicles(): Promise<Vehicle[]> {
    return clone(getState().vehicles);
  }

  async getPackage(packageId: string): Promise<Package> {
    const p = getState().packages.find((pkg) => pkg.id === packageId || pkg.packageId === packageId);
    if (!p) throw new ApiError(404, 'PACKAGE_NOT_FOUND', `Package ${packageId} not found`);
    return clone(p);
  }

  async getLogisticsTrip(tripId: string): Promise<LogisticsTrip> {
    const t = getState().logisticsTrips.find((tr) => tr.id === tripId);
    if (!t) throw new ApiError(404, 'TRIP_NOT_FOUND', `Trip ${tripId} not found`);
    return clone(t);
  }

  async listLogisticsTrips(): Promise<LogisticsTrip[]> {
    return clone(getState().logisticsTrips);
  }

  async getConsignment(consignmentId: string): Promise<Consignment> {
    const c = getState().consignments.find((cons) => cons.id === consignmentId);
    if (!c) throw new ApiError(404, 'CONSIGNMENT_NOT_FOUND', `Consignment ${consignmentId} not found`);
    return clone(c);
  }

  async listConsignments(): Promise<Consignment[]> {
    return clone(getState().consignments);
  }

  async getOrderRoute(orderId: string): Promise<RouteSegment[]> {
    const route = getState().orderRoutes.get(orderId);
    if (!route) return [];
    return clone(route);
  }

  async checkVehicleCapacity(vehicleId: string, packageId: string): Promise<void> {
    const vehicle = await this.getVehicle(vehicleId);
    const pkg = await this.getPackage(packageId);
    if (isWeightExceeded(vehicle, pkg)) {
      throw new ApiError(409, 'CAPACITY_WEIGHT_EXCEEDED', 'Weight capacity exceeded', false, undefined, requestId());
    }
    if (isVolumeExceeded(vehicle, pkg)) {
      throw new ApiError(409, 'CAPACITY_VOLUME_EXCEEDED', 'Volume capacity exceeded', false, undefined, requestId());
    }
  }
}
