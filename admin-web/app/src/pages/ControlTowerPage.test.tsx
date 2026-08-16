import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { ControlTowerPage } from './ControlTowerPage'
import { server } from '../test/setup'

describe('ControlTowerPage', () => {
  it('renders totals, network health and critical actions on success', async () => {
    server.use(
      http.get('/admin/control-tower', () =>
        HttpResponse.json({
          generatedAt: '2026-08-13T10:00:00.000Z',
          totals: {
            ordersToday: 42,
            activeDeliveries: 7,
            activeServiceJobs: 3,
            providersOnline: 11,
            ridersOnline: 5,
            openIncidents: 1,
            delayedShipments: 2,
            pendingDisputes: 0,
          },
          networkHealth: {
            deliveryNetwork: { normalPct: 0.9, delayedPct: 0.08, criticalPct: 0.02 },
            serviceNetwork: { normalPct: 0.95, capacityIssuePct: 0.04, criticalPct: 0.01 },
          },
          criticalActions: {
            shipmentExceptions: 3,
            providerIncidents: 1,
            paymentFailures: 2,
            fraudCases: 0,
            slaBreaches: 4,
            hubCapacityWarnings: 1,
          },
        }),
      ),
    )
    render(
      <MemoryRouter>
        <ControlTowerPage />
      </MemoryRouter>,
    )

    expect(await screen.findByText('Operations Control Tower')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
    expect(screen.getByText('Orders today')).toBeInTheDocument()
    expect(screen.getByText('Shipment exceptions')).toBeInTheDocument()
    expect(screen.getByText('Snapshot', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('Delivery network')).toBeInTheDocument()
  })

  it('deep-links critical actions into their module queues', async () => {
    server.use(
      http.get('/admin/control-tower', () =>
        HttpResponse.json({
          generatedAt: '2026-08-13T10:00:00.000Z',
          totals: {},
          networkHealth: {},
          criticalActions: {
            shipmentExceptions: 3,
            providerIncidents: 1,
            paymentFailures: 2,
            fraudCases: 0,
            slaBreaches: 4,
            hubCapacityWarnings: 1,
          },
        }),
      ),
    )
    render(
      <MemoryRouter>
        <ControlTowerPage />
      </MemoryRouter>,
    )

    expect(await screen.findByText('Operations Control Tower')).toBeInTheDocument()

    const links: Array<[RegExp, string]> = [
      [/Shipment exceptions/, '/operations/exceptions'],
      [/Provider incidents/, '/services/providers'],
      [/Payment failures/, '/finance/payments'],
      [/Fraud cases/, '/trust/risk-cases'],
      [/SLA breaches/, '/configuration/sla'],
      [/Hub capacity warnings/, '/operations/hubs'],
    ]
    for (const [name, href] of links) {
      expect(screen.getByRole('link', { name })).toHaveAttribute('href', href)
    }
    expect(screen.getByRole('link', { name: /Fraud cases/ })).toHaveTextContent('0')
  })

  it('shows a live alert banner with deep links when critical actions are non-zero', async () => {
    server.use(
      http.get('/admin/control-tower', () =>
        HttpResponse.json({
          generatedAt: '2026-08-13T10:00:00.000Z',
          totals: { delayedShipments: 2 },
          networkHealth: {},
          criticalActions: {
            shipmentExceptions: 3,
            providerIncidents: 0,
            paymentFailures: 0,
            fraudCases: 0,
            slaBreaches: 0,
            hubCapacityWarnings: 1,
          },
        }),
      ),
    )
    render(
      <MemoryRouter>
        <ControlTowerPage />
      </MemoryRouter>,
    )

    expect(await screen.findByText('Operations Control Tower')).toBeInTheDocument()
    const banner = screen.getByRole('alert')
    expect(banner).toHaveTextContent('3 shipment exceptions open')
    expect(banner).toHaveTextContent('1 hub capacity warnings open')
    expect(banner).toHaveTextContent('2 orders delayed')
    expect(banner).toHaveTextContent('·')
    const opens = screen.getAllByRole('link', { name: 'Open' })
    expect(opens).toHaveLength(3)
    expect(opens[0]).toHaveAttribute('href', '/operations/exceptions')
    expect(opens[1]).toHaveAttribute('href', '/operations/hubs')
    expect(opens[2]).toHaveAttribute('href', '/operations/exceptions')
  })

  it('renders no alert banner when every critical action is zero', async () => {
    server.use(
      http.get('/admin/control-tower', () =>
        HttpResponse.json({
          generatedAt: '2026-08-13T10:00:00.000Z',
          totals: { delayedShipments: 0 },
          networkHealth: {},
          criticalActions: {
            shipmentExceptions: 0,
            providerIncidents: 0,
            paymentFailures: 0,
            fraudCases: 0,
            slaBreaches: 0,
            hubCapacityWarnings: 0,
          },
        }),
      ),
    )
    render(
      <MemoryRouter>
        <ControlTowerPage />
      </MemoryRouter>,
    )

    expect(await screen.findByText('Operations Control Tower')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows retry on failure and recovers', async () => {
    server.use(
      http.get('/admin/control-tower', () => HttpResponse.json({ code: 'CONTROL_TOWER_UNAVAILABLE', message: 'down' }, { status: 503 })),
    )
    render(
      <MemoryRouter>
        <ControlTowerPage />
      </MemoryRouter>,
    )

    expect(await screen.findByText('Control tower unavailable')).toBeInTheDocument()
    expect(screen.getByText('Retry')).toBeInTheDocument()

    server.use(
      http.get('/admin/control-tower', () =>
        HttpResponse.json({
          generatedAt: '2026-08-13T10:00:00.000Z',
          totals: { ordersToday: 1 },
          networkHealth: {},
          criticalActions: {},
        }),
      ),
    )
    screen.getByText('Retry').click()
    expect(await screen.findByText('Operations Control Tower')).toBeInTheDocument()
  })
})
