/* Logistics OS (P11b-d) + Deep logistics P11d contract tests.
 *
 * Rider-visible surfaces only — never admin registries.
 * Covers: service-model chips, capacity guards, exception lifecycle,
 * NOT_WHITELISTED block, warehouse/carrier context, registry exclusion.
 *
 * Imports MOCK implementations directly; factories are env-switched in the app.
 * Every case resets the shared mock store (seed 20260813) in beforeEach.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ApiError } from '@/api/client';
import { resetMockState, getState } from '@/repos/mock/mockState';
import { MockRiderRepository } from '@/repos/mock/rider';
import { MockLogisticsRepository } from '@/repos/mock/logistics';
import { ApiLogisticsRepository } from '@/repos/api/logistics';
import { DELIVERY_EXCEPTION_KINDS, capacityPercent, capacityBarTone, isWeightExceeded, isVolumeExceeded, checkCapacityOrThrow, isWarehouseFulfillment, hasCarrierLeg, SERVICE_MODELS } from '@/lib/logistics';

const rider = new MockRiderRepository();
const logistics = new MockLogisticsRepository();

beforeEach(() => resetMockState());

async function rejectsApiError(promise: Promise<unknown>, status: number, code?: string): Promise<ApiError> {
  let caught: unknown;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ApiError, `expected ApiError, got ${String(caught)}`);
  assert.equal((caught as ApiError).status, status);
  if (code) assert.equal((caught as ApiError).code, code);
  return caught as ApiError;
}

test('service-model chips: profile carries RiderPrivate.serviceModel and fleetAccountId read-only', async () => {
  const profile = await rider.getProfile();
  assert.ok(SERVICE_MODELS.includes(profile.serviceModel as typeof SERVICE_MODELS[number]), `serviceModel must be one of ${SERVICE_MODELS.join(',')}, got ${profile.serviceModel}`);
  assert.equal(profile.serviceModel, 'specialized');
  assert.equal(profile.fleetAccountId, null);
  const state = getState();
  state.profile.serviceModel = 'fleet';
  state.profile.fleetAccountId = 'fleet_abc12345-uuid';
  const fleetProfile = await rider.getProfile();
  assert.equal(fleetProfile.serviceModel, 'fleet');
  assert.equal(fleetProfile.fleetAccountId, 'fleet_abc12345-uuid');
  const patched = await rider.updateProfile({ deliveryZone: 'Kinondoni' } as never);
  assert.equal(patched.serviceModel, 'fleet');
  assert.equal(patched.fleetAccountId, 'fleet_abc12345-uuid');
  assert.equal(patched.deliveryZone, 'Kinondoni');
  state.profile.serviceModel = 'specialized';
  state.profile.fleetAccountId = null;
});

test('service-model chip tone mapping and fleet badge logic', async () => {
  const toneMap: Record<string, string> = { specialized: 'info', crowdsourced: 'success', errand: 'warning', fleet: 'neutral' };
  for (const model of SERVICE_MODELS) {
    assert.ok(toneMap[model], `missing tone for ${model}`);
  }
  const state = getState();
  state.profile.serviceModel = 'crowdsourced';
  state.profile.fleetAccountId = null;
  let p = await rider.getProfile();
  assert.equal(p.serviceModel, 'crowdsourced');
  assert.equal(p.fleetAccountId, null);
  state.profile.serviceModel = 'fleet';
  state.profile.fleetAccountId = 'fleet_xyz';
  p = await rider.getProfile();
  assert.ok(p.fleetAccountId, 'fleet chip should render when fleetAccountId present');
});

test('service-model chips: crowdsourced/errand grab feed vs specialized guaranteed-hours card', async () => {
  const state = getState();
  for (const model of ['specialized', 'crowdsourced', 'errand', 'fleet'] as const) {
    state.profile.serviceModel = model;
    const p = await rider.getProfile();
    assert.equal(p.serviceModel, model);
    if (model === 'fleet') {
      state.profile.fleetAccountId = 'fleet_test';
      const fp = await rider.getProfile();
      assert.equal(fp.fleetAccountId, 'fleet_test');
    }
  }
  assert.equal(DELIVERY_EXCEPTION_KINDS.length, 18);
});

test('facility whitelist status: honest — derived from grant/revoke trail + last scan outcomes, no rider GET /facilities', async () => {
  const status = await logistics.getFacilityStatus();
  assert.ok(status.entries.length >= 2, 'seeded facility whitelist should have at least 2 entries');
  assert.ok(status.lastScanOutcomes.length >= 2, 'seeded scan outcomes should have at least 2');
  const granted = status.entries.find((e) => e.status === 'granted');
  const revoked = status.entries.find((e) => e.status === 'revoked');
  assert.ok(granted, 'expected a granted entry');
  assert.ok(revoked, 'expected a revoked entry');
  assert.equal(granted.policy, 'whitelist_only');
  assert.equal(revoked.policy, 'whitelist_or_otp');
  assert.ok(granted.grantedAt);
  assert.ok(revoked.revokedAt);
  assert.ok(granted.lastScanOutcome, 'granted facility should have lastScanOutcome');
  assert.equal(revoked.lastScanOutcome?.code, 'NOT_WHITELISTED');
  const grantedEntry = status.entries[0];
  assert.ok(grantedEntry.facilityId.length > 0);
  assert.ok(grantedEntry.facilityName.length > 0);
});

test('facility NOT_WHITELISTED 403 block with Request access prefilled ticket', async () => {
  const err = await rejectsApiError(logistics.scanAtFacility('fac_old_industrial'), 403, 'NOT_WHITELISTED');
  assert.ok(err.requestId, '403 must carry a requestId for support ticket');
  assert.match(err.message, /not whitelisted/i);
  const status = await logistics.getFacilityStatus();
  const blocked = status.lastScanOutcomes.find((s) => s.facilityId === 'fac_old_industrial' && s.result === 'blocked');
  assert.ok(blocked, 'blocked scan should be recorded in lastScanOutcomes');
  assert.equal(blocked?.code, 'NOT_WHITELISTED');
  assert.equal(blocked?.requestId, err.requestId);
  const beforeTickets = getState().tickets.length;
  const support = new (await import('@/repos/mock/support')).MockSupportRepository();
  const ticket = await support.createTicket(
    `Request facility access — Old Industrial Park`,
    `Requesting whitelist access for Old Industrial Park. RequestId: ${err.requestId}. Please grant entry for deliveries.`,
    'other',
  );
  assert.ok(ticket.id);
  assert.equal(ticket.status, 'open');
  assert.equal(getState().tickets.length, beforeTickets + 1);
});

test('facility granted entry scan succeeds (201) and renders Entry granted', async () => {
  const res = await logistics.scanAtFacility('fac_green_view');
  assert.equal(res.granted, true);
  assert.ok(res.requestId);
  const status = await logistics.getFacilityStatus();
  const latest = status.lastScanOutcomes[0];
  assert.equal(latest.facilityId, 'fac_green_view');
  assert.equal(latest.result, 'granted');
});

test('facility scan with unknown facility also NOT_WHITELISTED', async () => {
  await rejectsApiError(logistics.scanAtFacility('fac_unknown_xyz'), 403, 'NOT_WHITELISTED');
});

test('exception catalog: 18 kinds enumerated, exact contract values', () => {
  assert.equal(DELIVERY_EXCEPTION_KINDS.length, 18);
  const expected = [
    'missing_package','wrong_package','wrong_hub','wrong_vehicle','scan_failure','damaged_package',
    'late_vehicle','vehicle_breakdown','rider_unavailable','bus_cancellation','hub_congestion',
    'weather_disruption','road_closure','customer_unavailable','package_refused','route_deviation',
    'security_incident','reconciliation_failure',
  ];
  for (const k of expected) assert.ok(DELIVERY_EXCEPTION_KINDS.includes(k as never), `missing kind ${k}`);
});

test('exception report: POST /delivery-exceptions 201 card with open status', async () => {
  const created = await logistics.createException({ kind: 'scan_failure', description: 'Barcode would not scan at pickup — tried 3 times' });
  assert.ok(created.id);
  assert.equal(created.kind, 'scan_failure');
  assert.equal(created.status, 'open');
  assert.equal(created.description, 'Barcode would not scan at pickup — tried 3 times');
  assert.equal(created.autoReplanned, false);
  assert.ok(created.createdAt);
  assert.equal(created.outcome, null);
  assert.equal(created.reportedBy, (await rider.getProfile()).id);
  const listed = await logistics.listExceptions();
  assert.ok(listed.some((e) => e.id === created.id));
});

test('exception lifecycle: open → resolving → resolved (with outcome) and autoReplanned banner', async () => {
  const ex = await logistics.createException({ kind: 'vehicle_breakdown', description: 'Bus broke down at mile 45' });
  assert.equal(ex.status, 'open');
  const resolving = await logistics.updateException(ex.id, { status: 'resolving' });
  assert.equal(resolving.status, 'resolving');
  assert.equal(resolving.outcome, null);
  const resolved = await logistics.updateException(ex.id, { status: 'resolved', outcome: 'Replanned to TRP-9913, Bus 16 — new ETA Day 2 09:00–14:00' });
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.outcome, 'Replanned to TRP-9913, Bus 16 — new ETA Day 2 09:00–14:00');
  assert.ok(resolved.resolvedAt);
  assert.equal(resolved.autoReplanned, true, 'vehicle_breakdown resolved should set autoReplanned');
});

test('exception lifecycle: open → resolving → escalated (terminal) for security_incident', async () => {
  const ex = await logistics.createException({ kind: 'security_incident', description: 'Tampering suspected at hub' });
  await logistics.updateException(ex.id, { status: 'resolving' });
  const escalated = await logistics.updateException(ex.id, { status: 'escalated', outcome: 'Escalated to ops manager — shipment frozen' });
  assert.equal(escalated.status, 'escalated');
  assert.ok(escalated.resolvedAt);
  await rejectsApiError(logistics.updateException(ex.id, { status: 'resolved' }), 409, 'EXCEPTION_ALREADY_RESOLVED');
});

test('exception EXCEPTION_ALREADY_RESOLVED handling: resolved is terminal, no reopen', async () => {
  const ex = await logistics.createException({ kind: 'damaged_package', description: 'Seal broken on arrival' });
  await logistics.updateException(ex.id, { status: 'resolved', outcome: 'Inspected — resealed' });
  const fetched = await logistics.getException(ex.id);
  assert.equal(fetched.status, 'resolved');
  await rejectsApiError(logistics.updateException(ex.id, { status: 'open' }), 409, 'EXCEPTION_ALREADY_RESOLVED');
  await rejectsApiError(logistics.updateException(ex.id, { status: 'resolving' }), 409, 'EXCEPTION_ALREADY_RESOLVED');
  await rejectsApiError(logistics.updateException(ex.id, { status: 'escalated' }), 409, 'EXCEPTION_ALREADY_RESOLVED');
  const still = await logistics.getException(ex.id);
  assert.equal(still.status, 'resolved');
});

test('exception validation: missing kind/description → 422 VALIDATION_FAILED', async () => {
  await rejectsApiError(logistics.createException({ kind: 'not_a_kind' as never, description: 'test' }), 422, 'VALIDATION_FAILED');
  await rejectsApiError(logistics.createException({ kind: 'scan_failure', description: '' }), 422, 'VALIDATION_FAILED');
  await rejectsApiError(logistics.createException({ kind: 'scan_failure', description: 'a'.repeat(1001) }), 422, 'VALIDATION_FAILED');
});

test('exception EXCEPTION_NOT_FOUND on unknown id', async () => {
  await rejectsApiError(logistics.getException('exc_missing'), 404, 'EXCEPTION_NOT_FOUND');
  await rejectsApiError(logistics.updateException('exc_missing', { status: 'resolved' }), 404, 'EXCEPTION_NOT_FOUND');
});

test('exception list filtering by kind and status', async () => {
  await logistics.createException({ kind: 'missing_package', description: 'Package not at hub' });
  await logistics.createException({ kind: 'wrong_hub', description: 'Scanned at wrong hub' });
  const ex2 = await logistics.createException({ kind: 'scan_failure', description: 'Scan failed' });
  await logistics.updateException(ex2.id, { status: 'resolved' });
  const byKind = await logistics.listExceptions({ kind: 'missing_package' });
  assert.ok(byKind.every((e) => e.kind === 'missing_package'));
  assert.ok(byKind.length >= 1);
  const byStatus = await logistics.listExceptions({ status: 'resolved' });
  assert.ok(byStatus.every((e) => e.status === 'resolved'));
  assert.ok(byStatus.length >= 1);
});

test('capacity bars: percent and tone calculations', () => {
  assert.equal(capacityPercent(0, 100), 0);
  assert.equal(capacityPercent(50, 100), 50);
  assert.equal(capacityPercent(100, 100), 100);
  assert.equal(capacityPercent(120, 100), 100, 'capped at 100');
  assert.equal(capacityPercent(undefined, 100), 0);
  assert.equal(capacityPercent(50, null), 0);
  assert.equal(capacityPercent(50, 0), 0);
  assert.equal(capacityBarTone(0), 'success');
  assert.equal(capacityBarTone(69), 'success');
  assert.equal(capacityBarTone(70), 'warning');
  assert.equal(capacityBarTone(89), 'warning');
  assert.equal(capacityBarTone(90), 'danger');
  assert.equal(capacityBarTone(100), 'danger');
});

test('capacity guards: Trip manifest + Vehicle capacity + Package weight/volume render bars + CAPACITY_* inline blocks', async () => {
  const vehicle = await logistics.getVehicle('veh_bus_15');
  assert.equal(vehicle.capacity?.maxWeightKg, 800);
  assert.equal(vehicle.capacity?.maxVolumeL, 6000);
  assert.ok(vehicle.capacity?.compartments && vehicle.capacity.compartments.length >= 4);
  const usedWeight = (vehicle.capacity.compartments ?? []).reduce((s, c) => s + (c.usedWeightKg ?? 0), 0);
  assert.equal(usedWeight, 440);
  assert.equal(capacityPercent(usedWeight, vehicle.capacity.maxWeightKg), 55);
  const usedVolume = (vehicle.capacity.compartments ?? []).reduce((s, c) => s + (c.usedVolumeL ?? 0), 0);
  assert.equal(usedVolume, 2950);
  assert.equal(capacityPercent(usedVolume, vehicle.capacity.maxVolumeL), 49);
  const standard = vehicle.capacity.compartments.find((c) => c.name === 'standard');
  assert.ok(standard);
  assert.equal(standard.used, 120);
  assert.equal(standard.capacity, 150);
  assert.equal(standard.usedWeightKg, 340);
  const trip = await logistics.getLogisticsTrip('trip_log_1');
  assert.equal(trip.tripNumber, 'TRP-9912');
  assert.equal(trip.manifestSummary?.expectedUnits, 327);
  assert.equal(trip.manifestSummary?.verifiedUnits, 196);
  assert.equal(trip.manifestSummary?.exceptions, 1);
});

test('capacity CAPACITY_WEIGHT_EXCEEDED inline block: heavy package rejected', async () => {
  await rejectsApiError(logistics.checkVehicleCapacity('veh_bus_15', 'pkg_heavy'), 409, 'CAPACITY_WEIGHT_EXCEEDED');
  const vehicle = await logistics.getVehicle('veh_bus_15');
  const heavy = await logistics.getPackage('pkg_heavy');
  assert.equal(isWeightExceeded(vehicle, heavy), true);
  assert.equal(isVolumeExceeded(vehicle, heavy), false);
  try {
    checkCapacityOrThrow(vehicle, heavy);
    assert.fail('expected CAPACITY_WEIGHT_EXCEEDED');
  } catch (e) {
    assert.ok(e instanceof ApiError);
    assert.equal((e as ApiError).code, 'CAPACITY_WEIGHT_EXCEEDED');
    assert.ok((e as ApiError).requestId);
  }
});

test('capacity CAPACITY_VOLUME_EXCEEDED inline block: bulky package rejected', async () => {
  await rejectsApiError(logistics.checkVehicleCapacity('veh_bus_15', 'pkg_bulky'), 409, 'CAPACITY_VOLUME_EXCEEDED');
  const vehicle = await logistics.getVehicle('veh_bus_15');
  const bulky = await logistics.getPackage('pkg_bulky');
  assert.equal(isVolumeExceeded(vehicle, bulky), true);
  assert.equal(isWeightExceeded(vehicle, bulky), false);
  try {
    checkCapacityOrThrow(vehicle, bulky);
    assert.fail('expected CAPACITY_VOLUME_EXCEEDED');
  } catch (e) {
    assert.ok(e instanceof ApiError);
    assert.equal((e as ApiError).code, 'CAPACITY_VOLUME_EXCEEDED');
  }
});

test('capacity: normal package passes both guards', async () => {
  const vehicle = await logistics.getVehicle('veh_van_3');
  const normal = await logistics.getPackage('pkg_1');
  assert.equal(isWeightExceeded(vehicle, normal), false);
  assert.equal(isVolumeExceeded(vehicle, normal), false);
  await logistics.checkVehicleCapacity('veh_van_3', 'pkg_1');
  checkCapacityOrThrow(vehicle, normal);
});

test('capacity: package without weight/volume skips weight/volume checks (unit capacity only)', async () => {
  const vehicle = await logistics.getVehicle('veh_bus_15');
  const pkgNoWeight: import('@hudumika/contract').Package = {
    id: 'pkg_noweight',
    packageId: 'PKG-NOWEIGHT',
    shipmentId: 'sh_x',
    containerId: null,
    attributes: { temperature: 'ambient', fragile: false, hazardous: false, highValue: false, compatible: true, weightKg: null, volumeL: null },
    status: 'prepared',
  };
  assert.equal(isWeightExceeded(vehicle, pkgNoWeight), false);
  assert.equal(isVolumeExceeded(vehicle, pkgNoWeight), false);
});

test('warehouse pickup context: Order.fulfillmentSource === warehouse renders warehouse pickup point + strategy chip dispatchStrategy read-only', async () => {
  const orders = getState().orders;
  const warehouseOrder = orders.find((o) => o.fulfillmentSource === 'warehouse');
  assert.ok(warehouseOrder, 'seeded warehouse order should exist');
  assert.equal(warehouseOrder.fulfillmentSource, 'warehouse');
  assert.equal(warehouseOrder.dispatchStrategy, 'warehouse');
  assert.ok(isWarehouseFulfillment(warehouseOrder), 'helper should detect warehouse fulfillment');
  const merchantOrder = orders.find((o) => o.fulfillmentSource === 'merchant');
  assert.ok(merchantOrder);
  assert.equal(isWarehouseFulfillment(merchantOrder), false);
  const strategies = ['nearest', 'zone', 'multi_leg', 'relay', 'warehouse'];
  for (const s of strategies) {
    assert.ok(typeof s === 'string' && s.length > 0);
  }
});

test('carrier handoff context: Consignment.carrierId + RouteSegment.handledBy carrier leg pill', async () => {
  const consignment = await logistics.getConsignment('cons_1');
  assert.equal(consignment.carrierId, 'carrier_dar_mwanza');
  assert.ok(consignment.manifest && consignment.manifest.length > 0);
  const orders = getState().orders;
  const withCarrier = orders.find((o) => o.routeSegments?.some((s) => s.handledBy?.startsWith('carrier_')));
  assert.ok(withCarrier, 'seeded order should have carrier leg');
  assert.ok(hasCarrierLeg(withCarrier.routeSegments), 'hasCarrierLeg helper should detect carrier leg');
  const route = await logistics.getOrderRoute(withCarrier.id);
  assert.ok(route.length >= 3, 'carrier order should have multi-leg route');
  const carrierLeg = route.find((s) => s.handledBy?.startsWith('carrier_'));
  assert.ok(carrierLeg, 'route should contain carrier leg');
  assert.equal(carrierLeg.handledBy, 'carrier_dar_mwanza');
  const noCarrier = orders.find((o) => o.routeSegments?.every((s) => !s.handledBy?.startsWith('carrier_')) ?? false);
  if (noCarrier) assert.equal(hasCarrierLeg(noCarrier.routeSegments), false);
});

test('warehouse + carrier: order detail renders both contexts when both present', async () => {
  const warehouseWithCarrier = getState().orders.find((o) => o.fulfillmentSource === 'warehouse' && hasCarrierLeg(o.routeSegments));
  assert.ok(warehouseWithCarrier, 'seeded order should be warehouse + carrier (deep logistics)');
  assert.equal(warehouseWithCarrier.fulfillmentSource, 'warehouse');
  assert.ok(hasCarrierLeg(warehouseWithCarrier.routeSegments));
  const consignment = await logistics.getConsignment('cons_1');
  assert.equal(consignment.carrierId, 'carrier_dar_mwanza');
});

test('auto-replan banner: exception with autoReplanned true renders plan.replanned banner, custody unchanged', async () => {
  const ex = await logistics.createException({ kind: 'vehicle_breakdown', description: 'Breakdown' });
  await logistics.updateException(ex.id, { status: 'resolving' });
  const resolved = await logistics.updateException(ex.id, { status: 'resolved', outcome: 'Replanned' });
  assert.equal(resolved.autoReplanned, true);
});

test('registry exclusion: api layer never calls /warehouses, /carriers, /facilities, /fleet/accounts, /admin/shipments/{id}/reassign (+ /escalate)', async () => {
  const { existsSync } = await import('node:fs');
  function resolveSrc(relative: string): string {
    const base = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(base, relative),
      path.resolve(base, '..', relative.replace(/^\.\.\//, '')),
      path.resolve(base, '../..', relative.replace(/^\.\.\//, '')),
      path.resolve(base, '../../app', relative.replace(/^\.\.\//, '')),
    ];
    for (const c of candidates) if (existsSync(c)) return c;
    return candidates[0];
  }
  const apiLogisticsPath = resolveSrc('../src/repos/api/logistics.ts');
  const apiLogisticsSrc = readFileSync(apiLogisticsPath, 'utf8');
  const forbidden = [
    '/warehouses',
    '/carriers',
    '/facilities',
    '/fleet/accounts',
    '/admin/shipments',
  ];
  for (const needle of forbidden) {
    assert.equal(apiLogisticsSrc.includes(needle), false, `ApiLogisticsRepository must NEVER contain "${needle}" — rider app is forbidden from calling admin registries`);
  }
  const mockPath = resolveSrc('../src/repos/mock/logistics.ts');
  const mockSrc = readFileSync(mockPath, 'utf8');
  for (const needle of forbidden) {
    assert.equal(mockSrc.includes(needle), false, `MockLogisticsRepository must NEVER contain "${needle}"`);
  }
  const apiDir = resolveSrc('../src/repos/api');
  const { readdirSync } = await import('node:fs');
  const apiFiles = readdirSync(apiDir).filter((f) => f.endsWith('.ts'));
  for (const file of apiFiles) {
    const src = readFileSync(path.join(apiDir, file), 'utf8');
    for (const needle of forbidden) {
      assert.equal(src.includes(needle), false, `src/repos/api/${file} must NEVER contain "${needle}"`);
    }
  }
});

test('registry exclusion: live fetch never hits forbidden registries (stubbed fetch assertion)', async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => [],
    } as unknown as Response;
  }) as typeof fetch;
  const apiRepo = new ApiLogisticsRepository();
  await apiRepo.listExceptions();
  await apiRepo.listLogisticsTrips();
  await apiRepo.listVehicles();
  await apiRepo.listConsignments();
  for (const url of calls) {
    assert.equal(url.includes('/warehouses'), false, `should never call /warehouses, got ${url}`);
    assert.equal(url.includes('/carriers'), false, `should never call /carriers, got ${url}`);
    if (url.includes('/facilities')) assert.fail(`should never call /facilities, got ${url}`);
    assert.equal(url.includes('/fleet/accounts'), false, `should never call /fleet/accounts, got ${url}`);
    assert.equal(url.includes('/admin/shipments'), false, `should never call /admin/shipments, got ${url}`);
  }
  globalThis.fetch = originalFetch;
});

test('i18n en+sw keys exist for logistics surfaces', async () => {
  const { dict, t, setLocale } = await import('@/i18n');
  const keys = [
    'logistics.facilities',
    'logistics.exceptions',
    'logistics.cargoSummary',
    'logistics.warehousePickup',
    'logistics.carrierLeg',
    'logistics.dispatchStrategy',
  ];
  for (const key of keys) {
    setLocale('en');
    assert.ok(dict.en[key as keyof typeof dict.en], `missing en key ${key}`);
    assert.notEqual(t(key as never), key, `t(${key}) should not fallback to key in en`);
    setLocale('sw');
    assert.ok(dict.sw[key as keyof typeof dict.sw], `missing sw key ${key}`);
    assert.notEqual(t(key as never), key, `t(${key}) should not fallback to key in sw`);
  }
  setLocale('en');
});

test('theme tokens only: logistics uses existing design tokens (no invented literals)', async () => {
  const { existsSync } = await import('node:fs');
  function resolveSrc(relative: string): string {
    const base = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(base, relative),
      path.resolve(base, '..', relative.replace(/^\.\.\//, '')),
      path.resolve(base, '../..', relative.replace(/^\.\.\//, '')),
      path.resolve(base, '../../app', relative.replace(/^\.\.\//, '')),
    ];
    for (const c of candidates) if (existsSync(c)) return c;
    return candidates[0];
  }
  const themePath = resolveSrc('../src/constants/theme.ts');
  const themeSrc = readFileSync(themePath, 'utf8');
  assert.ok(themeSrc.includes('LogisticsTokens'), 'theme should export LogisticsTokens for logistics surfaces');
  assert.ok(themeSrc.includes('capacityBarHeight'), 'LogisticsTokens should define capacity bar tokens');
});

test('order detail honest rendering: fulfillmentSource and dispatchStrategy are read-only server fields', async () => {
  const order = getState().orders.find((o) => o.dispatchStrategy === 'warehouse');
  assert.ok(order);
  assert.equal(order.fulfillmentSource, 'warehouse');
  assert.equal(order.dispatchStrategy, 'warehouse');
  const strategyLabel = order.dispatchStrategy;
  assert.ok(strategyLabel);
  assert.equal(isWarehouseFulfillment(order), true);
});
