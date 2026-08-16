import { describe, it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from './setup'
import { parseApiError } from '../lib/api-error'
import {
  adminOverview,
  adminOperationsControlTower,
  adminListCustomers,
  adminSearchUsers,
  adminListMerchants,
  adminListProviders,
  adminListRiders,
  adminListOrders,
  adminListBookings,
  adminListPayouts,
  adminListTickets,
  adminListAuditLogs,
  adminGlobalSearch,
  adminListTwoPersonApprovals,
  adminListRiskCases,
  adminIntegrationHealth,
  adminFleetControlTower,
  logisticsControlTower,
  adminListPromotions,
  adminListGroupBuys,
  adminListConversations,
  adminListChains,
  adminListWebhookHealth,
  adminListDataExports,
  adminListBanners,
  adminListTemplates,
  adminListFeatures,
  adminListStaffRoles,
  adminListSlaRules,
  adminListCommissionRules,
  adminHubDashboard,
  adminRiderCodReconciliation,
  listRefundRequests,
  listHubs,
  listWarehouses,
  listCarriers,
  listFacilities,
  listFleetAccounts,
  listVehicles,
  listShipments,
  listConsignments,
  listDeliveryExceptions,
  getOrderWaybill,
  getShipmentCustody,
  listCities,
  listCategories,
  listServiceCategories,
  adminMerchantDecision,
  adminRefundDecision,
  adminAssignOrderToRider,
  adminDecideTwoPersonApproval,
  adminReviewRiskCase,
  adminFreezeShipment,
  getWarehouse,
  adminAssignTicket,
  adminSetUserStatus,
  adminModerateReview,
  adminPromotionDecision,
  adminGroupBuyDecision,
  adminCreateTwoPersonApproval,
  adminVerifyVoucher,
  adminCreateReport,
  adminAdjustWallet,
  adminUpdateFeature,
  adminUpsertCity,
  adminEscalateShipment,
  adminReassignShipment,
  blockConversation,
  reconcileConsignment,
  replanConsignment,
  exportAnalyticsReport,
  adminCreateBanner,
  adminCreateHelpArticle,
  adminBroadcastNotification,
  adminDeleteBanner,
  adminUpsertTemplate,
  adminPutSlaRules,
  adminPutCommissionRules,
  listRoutes,
  getConsignment,
  listVehicleMaintenance,
  getDispatchHeatmap,
  createWarehouse,
  createCarrier,
  createFacility,
  createFleetAccount,
  createHub,
  createRoute,
  adjustWarehouseStock,
  putFacilityWhitelist,
  updateDeliveryException,
  updateWarehouse,
  updateCarrier,
  updateFleetAccount,
  updateVehicle,
  adminCreateStaffRole,
} from '@hudumika/contract'

interface ParityCase {
  name: string
  call: () => Promise<{ status: number }>
}

interface ErrorPathCase {
  name: string
  handler: Parameters<typeof server.use>[0]
  call: () => Promise<{ status: number; data?: unknown }>
  status: number
  code: string
}

interface MutationCase {
  name: string
  status: number
  call: () => Promise<{ status: number }>
}

/**
 * Error-path parity matrix: each contract client function must propagate a
 * non-2xx status and the stable contract `code` from the generated MSW server
 * when a handler is overridden per case. The shared server is reset after
 * every test by the setup (server.resetHandlers), so per-case overrides are
 * scoped to their own test.
 */
const ERROR_PARITY_MATRIX: ErrorPathCase[] = [
  {
    name: 'adminListOrders → 403 FORBIDDEN',
    handler: http.get('*/admin/orders', () =>
      HttpResponse.json({ code: 'FORBIDDEN', message: 'no permission', requestId: 'req_1' }, { status: 403 }),
    ),
    call: () => adminListOrders(),
    status: 403,
    code: 'FORBIDDEN',
  },
  {
    name: 'adminMerchantDecision → 409 MERCHANT_ALREADY_DECIDED',
    handler: http.post('*/admin/merchants/mrc_1/approval', () =>
      HttpResponse.json(
        { code: 'MERCHANT_ALREADY_DECIDED', message: 'Merchant already decided', requestId: 'req_2' },
        { status: 409 },
      ),
    ),
    call: () => adminMerchantDecision('mrc_1', { decision: 'approved', reason: 'x' }),
    status: 409,
    code: 'MERCHANT_ALREADY_DECIDED',
  },
  {
    name: 'adminRefundDecision → 400 ADMIN_REASON_REQUIRED',
    handler: http.post('*/admin/refunds/ref_1/decision', () =>
      HttpResponse.json(
        { code: 'ADMIN_REASON_REQUIRED', message: 'A reason is required', requestId: 'req_3' },
        { status: 400 },
      ),
    ),
    call: () => adminRefundDecision('ref_1', { decision: 'approve', reason: 'x' }),
    status: 400,
    code: 'ADMIN_REASON_REQUIRED',
  },
  {
    name: 'adminAssignOrderToRider → 409 ORDER_NOT_ASSIGNABLE',
    handler: http.post('*/admin/orders/ord_1/assign-rider', () =>
      HttpResponse.json(
        { code: 'ORDER_NOT_ASSIGNABLE', message: 'Order cannot be assigned', requestId: 'req_4' },
        { status: 409 },
      ),
    ),
    call: () => adminAssignOrderToRider('ord_1', { riderId: 'rdr_1', reason: 'x' }),
    status: 409,
    code: 'ORDER_NOT_ASSIGNABLE',
  },
  {
    name: 'adminDecideTwoPersonApproval → 409 APPROVAL_SAME_ACTOR',
    handler: http.post('*/admin/two-person-approvals/appr_1/decision', () =>
      HttpResponse.json(
        { code: 'APPROVAL_SAME_ACTOR', message: 'Cannot decide on own request', requestId: 'req_5' },
        { status: 409 },
      ),
    ),
    call: () => adminDecideTwoPersonApproval('appr_1', { decision: 'approve', comment: 'ok' }),
    status: 409,
    code: 'APPROVAL_SAME_ACTOR',
  },
  {
    name: 'adminReviewRiskCase → 409 RISK_CASE_ALREADY_DECIDED',
    handler: http.post('*/admin/risk/cases/rc_1/review', () =>
      HttpResponse.json(
        { code: 'RISK_CASE_ALREADY_DECIDED', message: 'Case already decided', requestId: 'req_6' },
        { status: 409 },
      ),
    ),
    call: () => adminReviewRiskCase('rc_1', { action: 'dismiss', reason: 'x' }),
    status: 409,
    code: 'RISK_CASE_ALREADY_DECIDED',
  },
  {
    name: 'adminHubDashboard → 404 HUB_NOT_FOUND',
    handler: http.get('*/admin/hubs/hub_x/dashboard', () =>
      HttpResponse.json({ code: 'HUB_NOT_FOUND', message: 'Hub not found', requestId: 'req_7' }, { status: 404 }),
    ),
    call: () => adminHubDashboard('hub_x'),
    status: 404,
    code: 'HUB_NOT_FOUND',
  },
  {
    name: 'getWarehouse → 404 WAREHOUSE_NOT_FOUND',
    handler: http.get('*/warehouses/wh_x', () =>
      HttpResponse.json({ code: 'WAREHOUSE_NOT_FOUND', message: 'Warehouse not found', requestId: 'req_8' }, { status: 404 }),
    ),
    call: () => getWarehouse('wh_x'),
    status: 404,
    code: 'WAREHOUSE_NOT_FOUND',
  },
  {
    name: 'adminGlobalSearch → 422 ADMIN_SEARCH_INVALID',
    handler: http.get('*/admin/search', () =>
      HttpResponse.json({ code: 'ADMIN_SEARCH_INVALID', message: 'Query too short', requestId: 'req_9' }, { status: 422 }),
    ),
    call: () => adminGlobalSearch({ q: 'x' }),
    status: 422,
    code: 'ADMIN_SEARCH_INVALID',
  },
  {
    name: 'adminFreezeShipment → 409 SHIPMENT_NOT_FREEZABLE',
    handler: http.post('*/admin/shipments/shp_1/freeze', () =>
      HttpResponse.json(
        { code: 'SHIPMENT_NOT_FREEZABLE', message: 'Shipment cannot be frozen', requestId: 'req_10' },
        { status: 409 },
      ),
    ),
    call: () => adminFreezeShipment('shp_1', { reason: 'x' }),
    status: 409,
    code: 'SHIPMENT_NOT_FREEZABLE',
  },
  {
    name: 'adminEscalateShipment → 409 SHIPMENT_NOT_ESCALATABLE',
    handler: http.post('*/admin/shipments/shp_1/escalate', () =>
      HttpResponse.json(
        { code: 'SHIPMENT_NOT_ESCALATABLE', message: 'Shipment cannot be escalated', requestId: 'req_11' },
        { status: 409 },
      ),
    ),
    call: () => adminEscalateShipment('shp_1', { reason: 'x' }),
    status: 409,
    code: 'SHIPMENT_NOT_ESCALATABLE',
  },
  {
    name: 'adminReassignShipment → 409 SHIPMENT_NOT_REASSIGNABLE',
    handler: http.post('*/admin/shipments/shp_1/reassign', () =>
      HttpResponse.json(
        { code: 'SHIPMENT_NOT_REASSIGNABLE', message: 'Shipment cannot be reassigned', requestId: 'req_12' },
        { status: 409 },
      ),
    ),
    call: () => adminReassignShipment('shp_1', { reason: 'x' }),
    status: 409,
    code: 'SHIPMENT_NOT_REASSIGNABLE',
  },
  {
    name: 'adminDecideTwoPersonApproval → 404 APPROVAL_NOT_FOUND',
    handler: http.post('*/admin/two-person-approvals/appr_1/decision', () =>
      HttpResponse.json(
        { code: 'APPROVAL_NOT_FOUND', message: 'Approval not found', requestId: 'req_13' },
        { status: 404 },
      ),
    ),
    call: () => adminDecideTwoPersonApproval('appr_1', { decision: 'approve', comment: 'ok' }),
    status: 404,
    code: 'APPROVAL_NOT_FOUND',
  },
  {
    name: 'adminReviewRiskCase → 404 RISK_CASE_NOT_FOUND',
    handler: http.post('*/admin/risk/cases/rc_1/review', () =>
      HttpResponse.json(
        { code: 'RISK_CASE_NOT_FOUND', message: 'Risk case not found', requestId: 'req_14' },
        { status: 404 },
      ),
    ),
    call: () => adminReviewRiskCase('rc_1', { action: 'dismiss', reason: 'x' }),
    status: 404,
    code: 'RISK_CASE_NOT_FOUND',
  },
  {
    name: 'adminRiderCodReconciliation → 503 COD_RECONCILIATION_UNAVAILABLE',
    handler: http.get('*/admin/riders/rdr_x/cod', () =>
      HttpResponse.json(
        { code: 'COD_RECONCILIATION_UNAVAILABLE', message: 'COD reconciliation is unavailable', requestId: 'req_15' },
        { status: 503 },
      ),
    ),
    call: () => adminRiderCodReconciliation('rdr_x'),
    status: 503,
    code: 'COD_RECONCILIATION_UNAVAILABLE',
  },
  {
    name: 'adminHubDashboard → 403 FORBIDDEN',
    handler: http.get('*/admin/hubs/hub_x/dashboard', () =>
      HttpResponse.json({ code: 'FORBIDDEN', message: 'no permission', requestId: 'req_16' }, { status: 403 }),
    ),
    call: () => adminHubDashboard('hub_x'),
    status: 403,
    code: 'FORBIDDEN',
  },
]

/**
 * Parity matrix: every contract client function the admin console consumes
 * must resolve to 200 against the MSW server generated from the same
 * API-CONTRACT.yaml. Runs in CI as the MSW-parity gate before staging E2E.
 */
const PARITY_MATRIX: ParityCase[] = [
  { name: 'adminOverview', call: () => adminOverview() },
  { name: 'adminOperationsControlTower', call: () => adminOperationsControlTower() },
  { name: 'adminListCustomers', call: () => adminListCustomers() },
  { name: 'adminSearchUsers', call: () => adminSearchUsers({ q: 'a' }) },
  { name: 'adminListMerchants', call: () => adminListMerchants() },
  { name: 'adminListProviders', call: () => adminListProviders() },
  { name: 'adminListRiders', call: () => adminListRiders() },
  { name: 'adminListOrders', call: () => adminListOrders() },
  { name: 'adminListBookings', call: () => adminListBookings() },
  { name: 'adminListPayouts', call: () => adminListPayouts() },
  { name: 'adminListTickets', call: () => adminListTickets() },
  { name: 'adminListAuditLogs', call: () => adminListAuditLogs() },
  { name: 'adminGlobalSearch', call: () => adminGlobalSearch({ q: 'ORD-' }) },
  { name: 'adminListTwoPersonApprovals', call: () => adminListTwoPersonApprovals() },
  { name: 'adminListRiskCases', call: () => adminListRiskCases() },
  { name: 'adminIntegrationHealth', call: () => adminIntegrationHealth() },
  { name: 'adminFleetControlTower', call: () => adminFleetControlTower() },
  { name: 'logisticsControlTower', call: () => logisticsControlTower() },
  { name: 'adminListPromotions', call: () => adminListPromotions() },
  { name: 'adminListGroupBuys', call: () => adminListGroupBuys() },
  { name: 'adminListConversations', call: () => adminListConversations() },
  { name: 'adminListChains', call: () => adminListChains() },
  { name: 'adminListWebhookHealth', call: () => adminListWebhookHealth() },
  { name: 'adminListDataExports', call: () => adminListDataExports() },
  { name: 'adminListBanners', call: () => adminListBanners() },
  { name: 'adminListTemplates', call: () => adminListTemplates() },
  { name: 'adminListFeatures', call: () => adminListFeatures() },
  { name: 'adminListStaffRoles', call: () => adminListStaffRoles() },
  { name: 'adminListSlaRules', call: () => adminListSlaRules() },
  { name: 'adminListCommissionRules', call: () => adminListCommissionRules() },
  { name: 'adminHubDashboard', call: () => adminHubDashboard('hub_1') },
  { name: 'adminRiderCodReconciliation', call: () => adminRiderCodReconciliation('rdr_1') },
  { name: 'listRefundRequests', call: () => listRefundRequests() },
  { name: 'listHubs', call: () => listHubs() },
  { name: 'listWarehouses', call: () => listWarehouses() },
  { name: 'listCarriers', call: () => listCarriers() },
  { name: 'listFacilities', call: () => listFacilities() },
  { name: 'listFleetAccounts', call: () => listFleetAccounts() },
  { name: 'listVehicles', call: () => listVehicles() },
  { name: 'listShipments', call: () => listShipments() },
  { name: 'listConsignments', call: () => listConsignments() },
  { name: 'listDeliveryExceptions', call: () => listDeliveryExceptions() },
  { name: 'getOrderWaybill', call: () => getOrderWaybill('ord_1') },
  { name: 'getShipmentCustody', call: () => getShipmentCustody('shp_1') },
  { name: 'listCities', call: () => listCities() },
  { name: 'listCategories', call: () => listCategories() },
  { name: 'listServiceCategories', call: () => listServiceCategories() },
]

/**
 * Mutation parity matrix: every contract mutation client function the admin
 * console consumes must resolve to its documented success status (200/201/202/204)
 * against the MSW server generated from the same API-CONTRACT.yaml.
 */
const MUTATION_PARITY_MATRIX: MutationCase[] = [
  { name: 'adminMerchantDecision', status: 200, call: () => adminMerchantDecision('mrc_1', { decision: 'approved', reason: 'ok' }) },
  { name: 'adminRefundDecision', status: 200, call: () => adminRefundDecision('ref_1', { decision: 'approve', reason: 'ok' }) },
  { name: 'adminAssignOrderToRider', status: 200, call: () => adminAssignOrderToRider('ord_1', { riderId: 'rdr_1', reason: 'ok' }) },
  { name: 'adminAssignTicket', status: 200, call: () => adminAssignTicket('tkt_1', { agentUserId: 'usr_1' }) },
  { name: 'adminSetUserStatus', status: 200, call: () => adminSetUserStatus('usr_1', { status: 'active', reason: 'ok' }) },
  { name: 'adminModerateReview', status: 200, call: () => adminModerateReview({ reviewId: 'rev_1', action: 'publish', reason: 'ok' }) },
  { name: 'adminPromotionDecision', status: 200, call: () => adminPromotionDecision('prm_1', { decision: 'approved', reason: 'ok' }) },
  { name: 'adminGroupBuyDecision', status: 200, call: () => adminGroupBuyDecision('gb_1', { decision: 'approved', reason: 'ok' }) },
  { name: 'adminReviewRiskCase', status: 200, call: () => adminReviewRiskCase('rc_1', { action: 'dismiss', reason: 'ok' }) },
  {
    name: 'adminCreateTwoPersonApproval',
    status: 201,
    call: () => adminCreateTwoPersonApproval({ actionType: 'large_refund', targetType: 'refund', targetId: 'ref_1', reason: 'ok' }),
  },
  { name: 'adminDecideTwoPersonApproval', status: 200, call: () => adminDecideTwoPersonApproval('appr_1', { decision: 'approve', comment: 'ok' }) },
  { name: 'adminVerifyVoucher', status: 200, call: () => adminVerifyVoucher({ voucherCode: 'VCH-1' }) },
  { name: 'adminCreateReport', status: 202, call: () => adminCreateReport({ name: 'r', metrics: ['orders'], format: 'csv' }) },
  { name: 'adminAdjustWallet', status: 200, call: () => adminAdjustWallet('usr_1', { deltaTZS: 100, reason: 'ok' }) },
  { name: 'adminUpdateFeature', status: 200, call: () => adminUpdateFeature({ key: 'x', enabled: true }) },
  { name: 'adminUpsertCity', status: 200, call: () => adminUpsertCity({ id: 'c_1', name: 'Dar es Salaam', country: 'TZ' }) },
  { name: 'adminFreezeShipment', status: 200, call: () => adminFreezeShipment('shp_1', { reason: 'ok' }) },
  { name: 'adminEscalateShipment', status: 200, call: () => adminEscalateShipment('shp_1', { reason: 'ok' }) },
  { name: 'blockConversation', status: 200, call: () => blockConversation('conv_1', { reason: 'ok' }) },
  { name: 'reconcileConsignment', status: 200, call: () => reconcileConsignment('cn_1', { scannedOrderIds: ['ord_1'] }) },
  { name: 'replanConsignment', status: 200, call: () => replanConsignment('cn_1', { reason: 'ok' }) },
  {
    name: 'exportAnalyticsReport',
    status: 200,
    call: () => exportAnalyticsReport({ reportType: 'orders', from: '2026-08-01', to: '2026-08-16' }),
  },
  { name: 'adminCreateBanner', status: 201, call: () => adminCreateBanner({ id: '', title: 't', placement: 'home_top' }) },
  { name: 'adminCreateHelpArticle', status: 201, call: () => adminCreateHelpArticle({ title: 't', category: 'c', body: 'b' }) },
  { name: 'adminBroadcastNotification', status: 202, call: () => adminBroadcastNotification({ title: 't', body: 'b' }) },
  { name: 'adminDeleteBanner', status: 204, call: () => adminDeleteBanner('bnr_1') },
  { name: 'adminUpsertTemplate', status: 200, call: () => adminUpsertTemplate({ key: 'k', channel: 'sms', body: 'b' }) },
  { name: 'adminPutSlaRules', status: 200, call: () => adminPutSlaRules({ rules: [] }) },
  { name: 'adminPutCommissionRules', status: 200, call: () => adminPutCommissionRules({ rules: [] }) },
  { name: 'listRoutes', status: 200, call: () => listRoutes() },
  { name: 'getConsignment', status: 200, call: () => getConsignment('cn_1') },
  { name: 'listVehicleMaintenance', status: 200, call: () => listVehicleMaintenance() },
  { name: 'getDispatchHeatmap', status: 200, call: () => getDispatchHeatmap({}) },
  { name: 'createWarehouse', status: 201, call: () => createWarehouse({ id: '', name: 'w', cityId: 'c_1' }) },
  { name: 'createCarrier', status: 201, call: () => createCarrier({ id: '', name: 'c', modes: ['van'] }) },
  { name: 'createFacility', status: 201, call: () => createFacility({ id: '', name: 'f', address: 'a' }) },
  { name: 'createFleetAccount', status: 201, call: () => createFleetAccount({ id: '', name: 'fa', status: 'active' }) },
  { name: 'createHub', status: 201, call: () => createHub({ id: 'hub_x', name: 'h', cityId: 'c_1' }) },
  { name: 'createRoute', status: 201, call: () => createRoute({ id: '', name: 'r', fromHubId: 'a', toHubId: 'b' }) },
  { name: 'adjustWarehouseStock', status: 200, call: () => adjustWarehouseStock('wh_1', { items: [{ catalogueItemId: 'ci_1', delta: 5 }] }) },
  { name: 'putFacilityWhitelist', status: 200, call: () => putFacilityWhitelist('fac_1', { riderIds: ['rdr_1'] }) },
  {
    name: 'updateDeliveryException',
    status: 200,
    call: () => updateDeliveryException('exc_1', { status: 'resolved', outcome: 'recovered' }),
  },
  { name: 'updateWarehouse', status: 200, call: () => updateWarehouse('wh_1', { id: 'wh_1', name: 'w', cityId: 'c_1' }) },
  { name: 'updateCarrier', status: 200, call: () => updateCarrier('car_1', { id: 'car_1', name: 'c', modes: ['van'] }) },
  { name: 'updateFleetAccount', status: 200, call: () => updateFleetAccount('fa_1', { id: 'fa_1', name: 'fa', status: 'active' }) },
  {
    name: 'updateVehicle',
    status: 200,
    call: () => updateVehicle('veh_1', { id: 'veh_1', vehicleType: 'motorcycle', registration: 'T 1' }),
  },
  {
    name: 'adminCreateStaffRole',
    status: 201,
    call: () => adminCreateStaffRole({ name: 'role', description: 'd', permissions: ['audit.read'] }),
  },
]

describe('MSW parity matrix', () => {
  it.each(PARITY_MATRIX)('$name resolves 200', async ({ call }) => {
    const res = await call()
    expect(res.status).toBe(200)
  })
})

describe('mutation happy paths', () => {
  it.each(MUTATION_PARITY_MATRIX)('$name resolves $status', async ({ call, status }) => {
    const res = await call()
    expect(res.status).toBe(status)
  })
})

describe('error paths', () => {
  it.each(ERROR_PARITY_MATRIX)(
    '$name',
    async ({ handler, call, status, code }) => {
      server.use(handler)
      const res = await call()
      expect(res.status).toBe(status)
      expect(parseApiError(res).code).toBe(code)
    },
  )
})
