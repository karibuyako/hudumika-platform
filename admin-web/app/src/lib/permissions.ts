import { rolePermissions } from './roles'
import type { StaffSession } from './session'

export function can(session: StaffSession | null | undefined, permission: string): boolean {
  if (!session) return false
  if (session.permissions.includes('*')) return true
  return session.permissions.includes(permission)
}

export function roleHasPermission(roleId: string, permission: string): boolean {
  const permissions = rolePermissions(roleId)
  if (permissions.includes('*')) return true
  return permissions.includes(permission)
}

export const permissionCatalog: Record<string, string> = {
  'order.read': 'View orders',
  'order.cancel': 'Cancel orders',
  'order.refund': 'Decide refunds on orders',
  'order.override': 'Override order assignments',
  'shipment.read': 'View shipments',
  'shipment.reassign': 'Reassign shipments',
  'shipment.hold': 'Freeze shipments',
  'shipment.release': 'Release shipments',
  'dispatch.read': 'View dispatch',
  'dispatch.assign': 'Assign orders',
  'dispatch.reassign': 'Reassign orders',
  'provider.read': 'View providers',
  'provider.verify': 'Verify providers',
  'provider.suspend': 'Suspend providers',
  'merchant.read': 'View merchants',
  'merchant.approve': 'Approve merchants',
  'merchant.suspend': 'Suspend merchants',
  'finance.read': 'View finance',
  'finance.refund': 'Issue refunds',
  'finance.payout_adjust': 'Adjust wallets',
  'risk.investigate': 'Investigate risk cases',
  'risk.block': 'Block users and providers from risk cases',
  'configuration.edit': 'Edit configuration',
  'iam.manage': 'Manage IAM',
  'audit.read': 'Read audit logs',
  'audit.unmask': 'Unmask sensitive fields',
  'refund.approve': 'Approve refunds',
  'review.moderate': 'Moderate reviews',
  'group_buy.moderate': 'Moderate group buys',
  'promotion.moderate': 'Moderate promotions',
  'voucher.verify': 'Verify vouchers',
  'conversation.read': 'View conversations',
  'conversation.block': 'Block conversations',
  'chain.read': 'View enterprise chains',
  'chain.suspend': 'Suspend chains',
  'webhook.read': 'View webhook health',
  'webhook.retry': 'Retry webhook deliveries',
  'export.request': 'Request data exports',
  'export.approve': 'Approve data exports',
  'cod.read': 'View rider COD reconciliation',
  'cod.reconcile': 'Reconcile rider COD',
  'safety.read': 'View safety surfaces',
  'safety.respond': 'Respond to safety incidents',
  'fleet.read': 'View fleet control tower',
  'fleet.admin': 'Manage fleet accounts',
  'hub.read': 'View hubs',
  'hub.manage': 'Manage hubs',
  'consignment.read': 'View consignments',
  'consignment.resolve': 'Resolve consignment exceptions',
  'handoff.read': 'View handoff trails',
  'handoff.resolve': 'Resolve handoff issues',
  'waybill.read': 'View waybill audit trails',
  'trip.read': 'View trips',
  'reconciliation.read': 'View reconciliation',
  'reconciliation.resolve': 'Resolve reconciliation failures',
  'anomaly.read': 'Inspect logistics anomalies',
  'anomaly.resolve': 'Respond to logistics anomalies',
  'warehouse.read': 'View warehouse registry',
  'warehouse.manage': 'Manage warehouses',
  'carrier.read': 'View carriers',
  'carrier.manage': 'Manage carriers',
  'facility.read': 'View facilities',
  'facility.manage': 'Manage facilities',
  'exception.read': 'View delivery exceptions',
  'exception.resolve': 'Resolve delivery exceptions',
  'customer.suspend': 'Suspend customers',
  'user.suspend': 'Suspend users',
  'feature.edit': 'Edit feature flags',
  'analytics.read': 'View analytics exports',
  'approval.decide': 'Decide two-person approvals',
}
