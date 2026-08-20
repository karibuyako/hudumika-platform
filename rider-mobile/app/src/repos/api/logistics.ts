import { api } from '@/api/client';
import type { Consignment, DeliveryException, DeliveryExceptionKind, LogisticsTrip, Package, RouteSegment, Vehicle } from '@hudumika/contract';
import type { FacilityWhitelistEntry, FacilityScan } from '@/lib/logistics';

export class ApiLogisticsRepository {
  async getFacilityStatus(): Promise<{ entries: FacilityWhitelistEntry[]; lastScanOutcomes: FacilityScan[] }> {
    return api.get('/riders/me/facility-status');
  }

  async scanAtFacility(facilityId: string): Promise<{ granted: boolean; requestId: string }> {
    return api.post('/riders/me/facility-scan', { facilityId });
  }

  async createException(input: { kind: DeliveryExceptionKind; description: string }): Promise<DeliveryException> {
    return api.post('/delivery-exceptions', input);
  }

  async getException(id: string): Promise<DeliveryException> {
    return api.get(`/delivery-exceptions/${id}`);
  }

  async listExceptions(filter?: { kind?: string; status?: string }): Promise<DeliveryException[]> {
    const qs = new URLSearchParams(filter as Record<string, string>).toString();
    return api.get(`/delivery-exceptions${qs ? `?${qs}` : ''}`);
  }

  async updateException(id: string, patch: { status: string; outcome?: string | null }): Promise<DeliveryException> {
    return api.patch(`/delivery-exceptions/${id}`, patch);
  }

  async getVehicle(vehicleId: string): Promise<Vehicle> {
    return api.get(`/rider-vehicles/${vehicleId}`);
  }

  async listVehicles(): Promise<Vehicle[]> {
    return api.get('/rider-vehicles');
  }

  async getPackage(packageId: string): Promise<Package> {
    return api.get(`/packages/${packageId}`);
  }

  async getLogisticsTrip(tripId: string): Promise<LogisticsTrip> {
    return api.get(`/logistics-trips/${tripId}`);
  }

  async listLogisticsTrips(): Promise<LogisticsTrip[]> {
    return api.get('/logistics-trips');
  }

  async getConsignment(consignmentId: string): Promise<Consignment> {
    return api.get(`/logistics-consignments/${consignmentId}`);
  }

  async listConsignments(): Promise<Consignment[]> {
    return api.get('/logistics-consignments');
  }

  async getOrderRoute(orderId: string): Promise<RouteSegment[]> {
    return api.get(`/orders/${orderId}/route`);
  }

  async checkVehicleCapacity(vehicleId: string, packageId: string): Promise<void> {
    return api.post('/rider-vehicles/capacity-check', { vehicleId, packageId });
  }
}
