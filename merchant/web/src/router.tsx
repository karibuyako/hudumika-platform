import { createBrowserRouter } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import { Shell } from './Shell'
import { ErrorBoundary } from './components/ErrorBoundary'
import { LoadingSkeleton } from './components/LoadingSkeleton'

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
      { index: true, element: lazyPage(() => import('./pages/OverviewPage').then((m) => ({ default: m.OverviewPage }))) },
      { path: 'orders', element: lazyPage(() => import('./pages/OrdersPage').then((m) => ({ default: m.OrdersPage }))) },
      { path: 'catalogue', element: lazyPage(() => import('./pages/CataloguePage').then((m) => ({ default: m.CataloguePage }))) },
      { path: 'availability', element: lazyPage(() => import('./pages/AvailabilityPage').then((m) => ({ default: m.AvailabilityPage }))) },
      { path: 'customers', element: lazyPage(() => import('./pages/CustomersPage').then((m) => ({ default: m.CustomersPage }))) },
      { path: 'promotions', element: lazyPage(() => import('./pages/PromotionsPage').then((m) => ({ default: m.PromotionsPage }))) },
      { path: 'earnings', element: lazyPage(() => import('./pages/EarningsPage').then((m) => ({ default: m.EarningsPage }))) },
      { path: 'support', element: lazyPage(() => import('./pages/SupportPage').then((m) => ({ default: m.SupportPage }))) },
    ],
  },
])
