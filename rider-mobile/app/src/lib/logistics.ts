import { ApiError } from '@/api/client';
import type { Package, RouteSegment, Vehicle } from '@hudumika/contract';

export type FacilityPolicy = 'whitelist_only' | 'whitelist_or_otp' | 'open';

export interface FacilityWhitelistEntry {
  facilityId: string;
  facilityName: string;
  policy: FacilityPolicy;
  grantedAt: string | null;
  revokedAt: string | null;
  status: 'granted' | 'revoked';
  lastScanOutcome?: { at: string; scanType: string; result: 'granted' | 'blocked'; requestId?: string; code?: string } | null;
}

export interface FacilityScan {
  facilityId: string;
  facilityName: string;
  at: string;
  result: 'granted' | 'blocked';
  requestId?: string;
  code?: string;
}

export const DELIVERY_EXCEPTION_KINDS = [
  'missing_package',
  'wrong_package',
  'wrong_hub',
  'wrong_vehicle',
  'scan_failure',
  'damaged_package',
  'late_vehicle',
  'vehicle_breakdown',
  'rider_unavailable',
  'bus_cancellation',
  'hub_congestion',
  'weather_disruption',
  'road_closure',
  'customer_unavailable',
  'package_refused',
  'route_deviation',
  'security_incident',
  'reconciliation_failure',
] as const;

export type DeliveryExceptionKind = (typeof DELIVERY_EXCEPTION_KINDS)[number];

export const SERVICE_MODELS = ['specialized', 'crowdsourced', 'errand', 'fleet'] as const;
export type ServiceModel = (typeof SERVICE_MODELS)[number];

export function capacityPercent(used: number | null | undefined, max: number | null | undefined): number {
  if (used == null || max == null || max <= 0) return 0;
  const pct = (used / max) * 100;
  if (pct <= 0) return 0;
  if (pct >= 100) return 100;
  return Math.round(pct);
}

export function capacityBarTone(percent: number): 'success' | 'warning' | 'danger' {
  if (percent >= 90) return 'danger';
  if (percent >= 70) return 'warning';
  return 'success';
}

function totalUsedWeight(vehicle: Vehicle): number {
  const comps = vehicle.capacity?.compartments ?? [];
  return comps.reduce((s, c) => s + (c.usedWeightKg ?? 0), 0);
}

function totalUsedVolume(vehicle: Vehicle): number {
  const comps = vehicle.capacity?.compartments ?? [];
  return comps.reduce((s, c) => s + (c.usedVolumeL ?? 0), 0);
}

export function isWeightExceeded(vehicle: Vehicle, pkg: Package): boolean {
  const w = pkg.attributes?.weightKg;
  const max = vehicle.capacity?.maxWeightKg;
  if (w == null || max == null) return false;
  const used = totalUsedWeight(vehicle);
  return used + w > max;
}

export function isVolumeExceeded(vehicle: Vehicle, pkg: Package): boolean {
  const v = pkg.attributes?.volumeL;
  const max = vehicle.capacity?.maxVolumeL;
  if (v == null || max == null) return false;
  const used = totalUsedVolume(vehicle);
  return used + v > max;
}

export function checkCapacityOrThrow(vehicle: Vehicle, pkg: Package): void {
  if (isWeightExceeded(vehicle, pkg)) {
    throw new ApiError(409, 'CAPACITY_WEIGHT_EXCEEDED', 'Capacity weight exceeded for this vehicle', false, undefined, `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  }
  if (isVolumeExceeded(vehicle, pkg)) {
    throw new ApiError(409, 'CAPACITY_VOLUME_EXCEEDED', 'Capacity volume exceeded for this vehicle', false, undefined, `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  }
}

export function isWarehouseFulfillment(order: { fulfillmentSource?: string | null }): boolean {
  return order.fulfillmentSource === 'warehouse';
}

export function hasCarrierLeg(routeSegments?: RouteSegment[] | null): boolean {
  if (!routeSegments || routeSegments.length === 0) return false;
  return routeSegments.some((s) => typeof s.handledBy === 'string' && s.handledBy.startsWith('carrier_'));
}

export function serviceModelLabel(model: string): string {
  switch (model) {
    case 'specialized':
      return 'Specialized';
    case 'crowdsourced':
      return 'Crowdsourced';
    case 'errand':
      return 'Errand';
    case 'fleet':
      return 'Fleet';
    default:
      return model;
  }
}

export function serviceModelTone(model: string): 'info' | 'success' | 'warning' | 'neutral' {
  switch (model) {
    case 'specialized':
      return 'info';
    case 'crowdsourced':
      return 'success';
    case 'errand':
      return 'warning';
    case 'fleet':
      return 'neutral';
    default:
      return 'neutral';
  }
}

export function dispatchStrategyLabel(strategy?: string | null): string {
  if (!strategy) return '—';
  const map: Record<string, string> = {
    nearest: 'Nearest',
    zone: 'Zone',
    multi_leg: 'Multi-leg',
    relay: 'Relay',
    warehouse: 'Warehouse',
  };
  return map[strategy] ?? strategy;
}

export function exceptionKindLabel(kind: string): string {
  return kind.replace(/_/g, ' ');
}

export function exceptionStatusTone(status: string): 'warning' | 'info' | 'success' | 'danger' | 'neutral' {
  switch (status) {
    case 'open':
      return 'warning';
    case 'resolving':
      return 'info';
    case 'resolved':
      return 'success';
    case 'escalated':
      return 'danger';
    default:
      return 'neutral';
  }
}
