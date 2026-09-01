import { createBrowserRouter } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import { Shell } from './Shell'
import { ErrorBoundary } from './components/ErrorBoundary'
import { LoadingSkeleton } from './components/LoadingSkeleton'
import { NotFoundPage } from './components/NotFoundPage'

function lazyPage(load: () => Promise<{ default: React.ComponentType }>) {
  const Component = lazy(load)
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSkeleton />}>
        <Component />
      </Suspense>
    </ErrorBoundary>
  )
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Shell />,
    children: [
      { index: true, element: lazyPage(() => import('./pages/ControlTowerPage').then((m) => ({ default: m.ControlTowerPage }))) },
      { path: 'commerce/orders', element: lazyPage(() => import('./pages/OrdersPage').then((m) => ({ default: m.OrdersPage }))) },
      { path: 'commerce/merchants', element: lazyPage(() => import('./features/merchants/MerchantsPage').then((m) => ({ default: m.MerchantsPage }))) },
      { path: 'bookings', element: lazyPage(() => import('./features/bookings/BookingsPage').then((m) => ({ default: m.BookingsPage }))) },
      { path: 'search', element: lazyPage(() => import('./features/search/SearchPage').then((m) => ({ default: m.SearchPage }))) },
      { path: 'admin/map', element: lazyPage(() => import('./features/map/MapPage').then((m) => ({ default: m.MapPage }))) },
      { path: 'operations/overview', element: lazyPage(() => import('./features/overview/OperationsOverviewPage').then((m) => ({ default: m.OperationsOverviewPage }))) },
      { path: 'operations/dispatch', element: lazyPage(() => import('./pages/DispatchConsolePage').then((m) => ({ default: m.DispatchConsolePage }))) },
      { path: 'operations/hubs/dashboard', element: lazyPage(() => import('./features/hubs/HubDashboardPage').then((m) => ({ default: m.HubDashboardPage }))) },
      { path: 'operations/hubs', element: lazyPage(() => import('./features/hubs/HubsPage').then((m) => ({ default: m.HubsPage }))) },
      { path: 'operations/fleet', element: lazyPage(() => import('./features/fleet/VehiclesPage').then((m) => ({ default: m.VehiclesPage }))) },
      { path: 'operations/fleet-tower', element: lazyPage(() => import('./features/fleet/FleetControlTowerPage').then((m) => ({ default: m.FleetControlTowerPage }))) },
      { path: 'operations/dispatch-monitor', element: lazyPage(() => import('./features/dispatch/DispatchMonitorPage').then((m) => ({ default: m.DispatchMonitorPage }))) },
      { path: 'operations/consignments', element: lazyPage(() => import('./features/hubs/ConsignmentsPage').then((m) => ({ default: m.ConsignmentsPage }))) },
      { path: 'services/providers', element: lazyPage(() => import('./features/providers/ProvidersPage').then((m) => ({ default: m.ProvidersPage }))) },
      { path: 'operations/exceptions', element: lazyPage(() => import('./features/exceptions/DeliveryExceptionsPage').then((m) => ({ default: m.DeliveryExceptionsPage }))) },
      { path: 'logistics/waybills', element: lazyPage(() => import('./features/logistics/WaybillPage').then((m) => ({ default: m.WaybillPage }))) },
      { path: 'logistics/warehouses', element: lazyPage(() => import('./features/warehouses/WarehousesPage').then((m) => ({ default: m.WarehousesPage }))) },
      { path: 'logistics/control-tower', element: lazyPage(() => import('./features/logistics/LogisticsTowerPage').then((m) => ({ default: m.LogisticsTowerPage }))) },
      { path: 'logistics/shipments', element: lazyPage(() => import('./features/shipments/ShipmentsPage').then((m) => ({ default: m.ShipmentsPage }))) },
      { path: 'logistics/reconciliation', element: lazyPage(() => import('./features/reconciliation/ReconciliationPage').then((m) => ({ default: m.ReconciliationPage }))) },
      { path: 'logistics/riders/cod', element: lazyPage(() => import('./features/riders/CodReconciliationPage').then((m) => ({ default: m.CodReconciliationPage }))) },
      { path: 'logistics/riders', element: lazyPage(() => import('./features/riders/RidersPage').then((m) => ({ default: m.RidersPage }))) },
      { path: 'fleet-accounts', element: lazyPage(() => import('./features/fleetaccounts/FleetAccountsPage').then((m) => ({ default: m.FleetAccountsPage }))) },
      { path: 'customers', element: lazyPage(() => import('./features/customers/CustomersPage').then((m) => ({ default: m.CustomersPage }))) },
      { path: 'carriers', element: lazyPage(() => import('./features/carriers/CarriersPage').then((m) => ({ default: m.CarriersPage }))) },
      { path: 'growth/loyalty', element: lazyPage(() => import('./features/loyalty/LoyaltyPage').then((m) => ({ default: m.LoyaltyPage }))) },
      { path: 'group-buys', element: lazyPage(() => import('./features/groupbuys/GroupBuysPage').then((m) => ({ default: m.GroupBuysPage }))) },
      { path: 'facilities', element: lazyPage(() => import('./features/facilities/FacilitiesPage').then((m) => ({ default: m.FacilitiesPage }))) },
      { path: 'finance/payments', element: lazyPage(() => import('./features/finance/PaymentsPage').then((m) => ({ default: m.PaymentsPage }))) },
      { path: 'vouchers', element: lazyPage(() => import('./features/vouchers/VouchersPage').then((m) => ({ default: m.VouchersPage }))) },
      { path: 'finance/refunds', element: lazyPage(() => import('./features/finance/RefundsPage').then((m) => ({ default: m.RefundsPage }))) },
      { path: 'finance/ledger', element: lazyPage(() => import('./features/finance/LedgerPage').then((m) => ({ default: m.LedgerPage }))) },
      { path: 'growth/promotions', element: lazyPage(() => import('./features/promotions/PromotionsPage').then((m) => ({ default: m.PromotionsPage }))) },
      { path: 'support/inbox', element: lazyPage(() => import('./features/support/InboxPage').then((m) => ({ default: m.InboxPage }))) },
      { path: 'chains', element: lazyPage(() => import('./features/chains/ChainsPage').then((m) => ({ default: m.ChainsPage }))) },
      { path: 'reviews', element: lazyPage(() => import('./features/reviews/ReviewsPage').then((m) => ({ default: m.ReviewsPage }))) },
      { path: 'trust/risk-cases', element: lazyPage(() => import('./features/risk/RiskCasesPage').then((m) => ({ default: m.RiskCasesPage }))) },
      { path: 'webhooks', element: lazyPage(() => import('./features/webhooks/WebhooksPage').then((m) => ({ default: m.WebhooksPage }))) },
      { path: 'content', element: lazyPage(() => import('./features/content/ContentPage').then((m) => ({ default: m.ContentPage }))) },
      { path: 'conversations', element: lazyPage(() => import('./features/conversations/ConversationsPage').then((m) => ({ default: m.ConversationsPage }))) },
      { path: 'content/help', element: lazyPage(() => import('./features/help/HelpPage').then((m) => ({ default: m.HelpPage }))) },
      { path: 'analytics', element: lazyPage(() => import('./features/analytics/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage }))) },
      { path: 'configuration/regions', element: lazyPage(() => import('./features/cities/CitiesPage').then((m) => ({ default: m.CitiesPage }))) },
      { path: 'catalogue', element: lazyPage(() => import('./features/catalogue/CataloguePage').then((m) => ({ default: m.CataloguePage }))) },
      { path: 'configuration/feature-flags', element: lazyPage(() => import('./features/config/FeatureFlagsPage').then((m) => ({ default: m.FeatureFlagsPage }))) },
      { path: 'configuration/sla', element: lazyPage(() => import('./features/config/SlaRulesPage').then((m) => ({ default: m.SlaRulesPage }))) },
      { path: 'configuration/commissions', element: lazyPage(() => import('./features/config/CommissionRulesPage').then((m) => ({ default: m.CommissionRulesPage }))) },
      { path: 'configuration/integrations', element: lazyPage(() => import('./features/integrations/IntegrationHealthPage').then((m) => ({ default: m.IntegrationHealthPage }))) },
      { path: 'iam/sessions', element: lazyPage(() => import('./features/iam/SessionsPage').then((m) => ({ default: m.SessionsPage }))) },
      { path: 'iam/users', element: lazyPage(() => import('./features/config/StaffRolesPage').then((m) => ({ default: m.StaffRolesPage }))) },
      { path: 'exports', element: lazyPage(() => import('./features/exports/DataExportsPage').then((m) => ({ default: m.DataExportsPage }))) },
      { path: 'audit/approvals', element: lazyPage(() => import('./features/approvals/TwoPersonApprovalsPage').then((m) => ({ default: m.TwoPersonApprovalsPage }))) },
      { path: 'audit/logs', element: lazyPage(() => import('./features/audit/AuditLogsPage').then((m) => ({ default: m.AuditLogsPage }))) },
      { path: 'compliance', element: lazyPage(() => import('./features/compliance/CompliancePage').then((m) => ({ default: m.CompliancePage }))) },
      { path: 'configuration/general-settings', element: lazyPage(() => import('./features/config/GeneralSettingsPage').then((m) => ({ default: m.GeneralSettingsPage }))) },
      { path: 'configuration/quality-scores', element: lazyPage(() => import('./features/config/QualityScorePage').then((m) => ({ default: m.QualityScorePage }))) },
      { path: 'configuration/gateways', element: lazyPage(() => import('./features/config/GatewaysPage').then((m) => ({ default: m.GatewaysPage }))) },
      { path: 'configuration/center', element: lazyPage(() => import('./features/config/ConfigCenterPage').then((m) => ({ default: m.ConfigCenterPage }))) },
      { path: 'exports/scheduled', element: lazyPage(() => import('./features/exports/ScheduledReportsPage').then((m) => ({ default: m.ScheduledReportsPage }))) },
      { path: 'exports/payroll', element: lazyPage(() => import('./features/finance/PayrollPage').then((m) => ({ default: m.PayrollPage }))) },
      { path: 'content/editorial', element: lazyPage(() => import('./features/content/ContentEditorialPage').then((m) => ({ default: m.ContentEditorialPage }))) },
      { path: 'auth/password-reset', element: lazyPage(() => import('./features/auth/PasswordResetPage').then((m) => ({ default: m.PasswordResetPage }))) },
      { path: 'iam/teams', element: lazyPage(() => import('./features/iam/TeamsPage').then((m) => ({ default: m.TeamsPage }))) },
      { path: 'iam/policies', element: lazyPage(() => import('./features/config/PoliciesPage').then((m) => ({ default: m.PoliciesPage }))) },
      { path: 'iam/admin-users', element: lazyPage(() => import('./features/config/AdminUsersPage').then((m) => ({ default: m.AdminUsersPage }))) },
      { path: 'configuration/geofences', element: lazyPage(() => import('./features/geofences/GeofencesPage').then((m) => ({ default: m.GeofencesPage }))) },
      { path: 'admin/map/traffic', element: lazyPage(() => import('./features/map/MapTrafficPage').then((m) => ({ default: m.MapTrafficPage }))) },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
])
