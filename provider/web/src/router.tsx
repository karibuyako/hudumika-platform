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
      { index: true, element: lazyPage(() => import('./pages/DashboardPage').then((m) => ({ default: m.DashboardPage }))) },
      { path: 'availability', element: lazyPage(() => import('./pages/AvailabilityPage').then((m) => ({ default: m.AvailabilityPage }))) },
      { path: 'catalogue', element: lazyPage(() => import('./pages/CataloguePage').then((m) => ({ default: m.CataloguePage }))) },
      { path: 'bookings', element: lazyPage(() => import('./pages/BookingsPage').then((m) => ({ default: m.BookingsPage }))) },
      { path: 'earnings', element: lazyPage(() => import('./pages/EarningsPage').then((m) => ({ default: m.EarningsPage }))) },
      { path: 'notifications', element: lazyPage(() => import('./pages/NotificationsPage').then((m) => ({ default: m.NotificationsPage }))) },
      { path: 'reviews', element: lazyPage(() => import('./pages/ReviewsPage').then((m) => ({ default: m.ReviewsPage }))) },
      { path: 'support', element: lazyPage(() => import('./pages/SupportPage').then((m) => ({ default: m.SupportPage }))) },
    ],
  },
])
