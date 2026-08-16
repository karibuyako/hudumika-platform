import { describe, expect, test } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import type { CustodyEntry, Shipment } from '@hudumika/contract'
import { server } from '../../test/setup'
import { seedStaffSession } from '../../lib/session'
import { ShipmentsPage } from './ShipmentsPage'

const shipment = (over: Partial<Shipment> = {}): Shipment => ({
  id: 'shp_1',
  shipmentNumber: 'SHP-1001',
  orderId: 'ord_1',
  packages: [{ id: 'pkg_1', packageId: 'PKG-1', shipmentId: 'shp_1', attributes: { compatible: true } }],
  containerId: 'cnt_1',
  status: 'in_transit',
  frozenReason: null,
  frozenAt: null,
  currentLegId: 'leg_1',
  declaredValueTZS: 250000,
  createdAt: '2026-08-10T08:00:00.000Z',
  ...over,
})

function listHandler(...shipments: Shipment[]) {
  return http.get('*/shipments', () => HttpResponse.json(shipments))
}

describe('ShipmentsPage', () => {
  test('renders rows after loading', async () => {
    server.use(listHandler(shipment(), shipment({ id: 'shp_2', shipmentNumber: 'SHP-1002', orderId: 'ord_2', status: 'delivered', containerId: null, declaredValueTZS: null })))
    render(<ShipmentsPage />)
    expect(screen.getByLabelText('Loading')).toBeInTheDocument()
    expect(await screen.findByText('SHP-1001')).toBeInTheDocument()
    expect(screen.getByText('SHP-1002')).toBeInTheDocument()
    expect(screen.getAllByText('TZS 250,000')).toHaveLength(1)
    expect(screen.getAllByText('—')).toHaveLength(3)
    expect(
      screen.getAllByText((_, el) => el?.classList.contains('pill') === true && el?.textContent === 'in transit'),
    ).toHaveLength(1)
    expect(
      screen.getAllByText((_, el) => el?.classList.contains('pill') === true && el?.textContent === 'delivered'),
    ).toHaveLength(1)
  })

  test('status chips filter client-side and show counts', async () => {
    const user = userEvent.setup()
    const inTransit = shipment({ id: 'shp_1', shipmentNumber: 'SHP-1001', status: 'in_transit' })
    const frozen = shipment({ id: 'shp_2', shipmentNumber: 'SHP-1002', status: 'frozen' })
    server.use(listHandler(inTransit, frozen))
    render(<ShipmentsPage />)
    expect(await screen.findByText('SHP-1001')).toBeInTheDocument()
    expect(screen.getByText('SHP-1002')).toBeInTheDocument()

    const allChip = screen.getByRole('button', { name: /^All/ })
    expect(allChip.querySelector('.chip-count')).toHaveTextContent('2')
    expect(screen.getByRole('button', { name: /^in transit/ }).querySelector('.chip-count')).toHaveTextContent('1')
    expect(screen.getByRole('button', { name: /^frozen/ }).querySelector('.chip-count')).toHaveTextContent('1')

    await user.click(screen.getByRole('button', { name: /^frozen/ }))
    await waitFor(() => expect(screen.queryByText('SHP-1001')).not.toBeInTheDocument())
    expect(screen.getByText('SHP-1002')).toBeInTheDocument()
  })

  test('shows empty state when there are no shipments', async () => {
    server.use(listHandler())
    render(<ShipmentsPage />)
    expect(await screen.findByText('No shipments')).toBeInTheDocument()
  })

  test('shows error state and recovers via retry', async () => {
    const user = userEvent.setup()
    server.use(http.get('*/shipments', () => new HttpResponse(null, { status: 500 })))
    render(<ShipmentsPage />)
    expect(await screen.findByText('Failed to load shipments')).toBeInTheDocument()

    server.resetHandlers()
    server.use(listHandler(shipment()))
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('SHP-1001')).toBeInTheDocument()
  })

  test('freeze mutation succeeds with toast, refetch and reason body', async () => {
    const user = userEvent.setup()
    const initial = shipment({ status: 'in_transit' })
    let rows: Shipment[] = [initial]
    const freezeCalls: Array<{ reason: string }> = []
    server.use(
      http.get('*/shipments', () => HttpResponse.json(rows)),
      http.post('*/admin/shipments/shp_1/freeze', async ({ request }) => {
        const body = (await request.json()) as { reason: string }
        freezeCalls.push(body)
        const updated = { ...initial, status: 'frozen' as const, frozenReason: body.reason, frozenAt: '2026-08-15T09:00:00.000Z' }
        rows = [updated]
        return HttpResponse.json(updated)
      }),
    )
    render(<ShipmentsPage />)
    await user.click(await screen.findByText('SHP-1001'))
    await user.click(screen.getByRole('button', { name: 'Freeze' }))

    const dialog = screen.getByRole('dialog', { name: 'Freeze shipment' })
    await user.type(dialog.querySelector('textarea')!, 'Holding for missing package investigation')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('SHP-1001 frozen')).toBeInTheDocument()
    expect(freezeCalls).toEqual([{ reason: 'Holding for missing package investigation' }])
    await waitFor(() => {
      expect(
        screen.getByText((content, el) => el?.classList.contains('pill') === true && content === 'frozen'),
      ).toBeInTheDocument()
    })
  })

  test('unfreeze routes through two-person approval with release_hold', async () => {
    const user = userEvent.setup()
    const frozen = shipment({
      status: 'frozen',
      frozenReason: 'Held for investigation',
      frozenAt: '2026-08-14T08:00:00.000Z',
    })
    let approvalBody: Record<string, unknown> | null = null
    server.use(
      listHandler(frozen),
      http.post('*/admin/two-person-approvals', async ({ request }) => {
        approvalBody = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ id: 'apr_3' }, { status: 201 })
      }),
    )
    render(<ShipmentsPage />)
    await user.click(await screen.findByText('SHP-1001'))
    await user.click(screen.getByRole('button', { name: 'Initiate unfreeze approval' }))

    const dialog = screen.getByRole('dialog', { name: 'Unfreeze shipment' })
    const textareas = dialog.querySelectorAll('textarea')
    await user.type(textareas[0], 'Investigation complete, safe to resume')
    await user.type(textareas[1], 'Resume at the hub then continue to destination')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('Unfreeze approval requested — pending a second admin')).toBeInTheDocument()
    expect(approvalBody).toMatchObject({
      actionType: 'release_hold',
      targetType: 'shipment',
      targetId: 'shp_1',
      reason: 'Investigation complete, safe to resume',
      payload: { resumePlan: 'Resume at the hub then continue to destination' },
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  test('custody tab lazy-loads the custody timeline', async () => {
    const user = userEvent.setup()
    const custody: CustodyEntry[] = [
      {
        id: 'cust_1',
        shipmentId: 'shp_1',
        packageId: 'pkg_1',
        eventType: 'handoff',
        actorId: 'usr_1',
        actorType: 'hub_worker',
        deviceId: 'dev_7',
        previousState: 'picked_up',
        newState: 'at_hub',
        evidence: 'seal intact',
        at: '2026-08-10T12:00:00.000Z',
        lat: null,
        lon: null,
        locationId: null,
        vehicleId: null,
        hubId: null,
      },
    ]
    server.use(
      listHandler(shipment()),
      http.get('*/shipments/shp_1/custody', () => HttpResponse.json(custody)),
    )
    render(<ShipmentsPage />)
    await user.click(await screen.findByText('SHP-1001'))
    await user.click(screen.getByRole('button', { name: 'Custody' }))

    expect(await screen.findByText('handoff')).toBeInTheDocument()
    expect(screen.getByText(/hub_worker · usr_1 · device dev_7/)).toBeInTheDocument()
    expect(screen.getByText('picked_up → at_hub')).toBeInTheDocument()
    expect(screen.getByText('seal intact')).toBeInTheDocument()
  })

  test('403 denial on freeze surfaces parseApiError inline in the prompt', async () => {
    const user = userEvent.setup()
    server.use(
      listHandler(shipment()),
      http.post('*/admin/shipments/shp_1/freeze', () =>
        HttpResponse.json({ code: 'FORBIDDEN', message: 'Not allowed', requestId: 'req-1' }, { status: 403 }),
      ),
    )
    render(<ShipmentsPage />)
    await user.click(await screen.findByText('SHP-1001'))
    await user.click(screen.getByRole('button', { name: 'Freeze' }))

    const dialog = screen.getByRole('dialog', { name: 'Freeze shipment' })
    await user.type(dialog.querySelector('textarea')!, 'Holding for investigation')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('Not allowed')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Freeze shipment' })).toBeInTheDocument()
  })

  test('reassign 409 SHIPMENT_NOT_REASSIGNABLE surfaces the status-gate message inline', async () => {
    const user = userEvent.setup()
    server.use(
      listHandler(shipment({ status: 'delivered' })),
      http.post('*/admin/shipments/shp_1/reassign', () =>
        HttpResponse.json(
          { code: 'SHIPMENT_NOT_REASSIGNABLE', message: 'Shipment already delivered', requestId: 'req-3' },
          { status: 409 },
        ),
      ),
    )
    render(<ShipmentsPage />)
    await user.click(await screen.findByText('SHP-1001'))
    await user.click(screen.getByRole('button', { name: 'Reassign' }))

    const dialog = screen.getByRole('dialog', { name: 'Reassign shipment' })
    await user.type(dialog.querySelector('textarea')!, 'Attempting to reassign a delivered shipment')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(
      await screen.findByText('Shipment cannot be reassigned in its current state (SHIPMENT_NOT_REASSIGNABLE)'),
    ).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Reassign shipment' })).toBeInTheDocument()
  })

  test('escalate 409 SHIPMENT_NOT_ESCALATABLE surfaces the status-gate message inline', async () => {
    const user = userEvent.setup()
    server.use(
      listHandler(shipment({ status: 'delivered' })),
      http.post('*/admin/shipments/shp_1/escalate', () =>
        HttpResponse.json(
          { code: 'SHIPMENT_NOT_ESCALATABLE', message: 'Shipment already delivered', requestId: 'req-4' },
          { status: 409 },
        ),
      ),
    )
    render(<ShipmentsPage />)
    await user.click(await screen.findByText('SHP-1001'))
    await user.click(screen.getByRole('button', { name: 'Escalate' }))

    const dialog = screen.getByRole('dialog', { name: 'Escalate shipment' })
    await user.type(dialog.querySelector('textarea')!, 'Attempting to escalate a delivered shipment')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(
      await screen.findByText('Shipment cannot be escalated in its current state (SHIPMENT_NOT_ESCALATABLE)'),
    ).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Escalate shipment' })).toBeInTheDocument()
  })

  test('hides all drawer actions when only audit.read is granted', async () => {
    seedStaffSession({ permissions: ['audit.read'] })
    const user = userEvent.setup()
    server.use(listHandler(shipment()))
    render(<ShipmentsPage />)
    await user.click(await screen.findByText('SHP-1001'))

    expect(screen.queryByRole('button', { name: 'Freeze' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reassign' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Escalate' })).not.toBeInTheDocument()
  })

  test('shows the per-entity audit trail in the drawer', async () => {
    const user = userEvent.setup()
    const AUDIT_ENTRIES = [
      {
        id: 'aud_1',
        actorUserId: 'usr_51',
        actorRole: 'admin',
        action: 'shipment.frozen',
        entityType: 'shipment',
        entityId: 'shp_1',
        details: { reason: 'Missing package' },
        ipAddress: '10.0.0.11',
        at: '2026-08-11T08:00:00.000Z',
        requestId: 'req_s1',
      },
      {
        id: 'aud_2',
        actorUserId: 'usr_52',
        action: 'shipment.status_changed',
        entityType: 'shipment',
        entityId: 'shp_1',
        at: '2026-08-12T08:00:00.000Z',
        requestId: 'req_s2',
      },
    ]
    server.use(
      listHandler(shipment()),
      http.get('*/admin/audit-logs', () => HttpResponse.json(AUDIT_ENTRIES)),
    )
    render(<ShipmentsPage />)
    await user.click(await screen.findByText('SHP-1001'))

    expect(await screen.findByText('shipment.status changed')).toBeInTheDocument()
    expect(screen.getByText('shipment.frozen')).toBeInTheDocument()
    expect(screen.getByText('usr_51')).toBeInTheDocument()
  })

  test('shows no audit entries when the trail is empty', async () => {
    const user = userEvent.setup()
    server.use(
      listHandler(shipment()),
      http.get('*/admin/audit-logs', () => HttpResponse.json([])),
    )
    render(<ShipmentsPage />)
    await user.click(await screen.findByText('SHP-1001'))

    expect(await screen.findByText('No audit entries for this entity')).toBeInTheDocument()
  })

  test('hides freeze but keeps reassign when only shipment.reassign is granted', async () => {
    seedStaffSession({ permissions: ['shipment.reassign'] })
    const user = userEvent.setup()
    server.use(listHandler(shipment()))
    render(<ShipmentsPage />)
    await user.click(await screen.findByText('SHP-1001'))

    expect(screen.queryByRole('button', { name: 'Freeze' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reassign' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Escalate' })).toBeInTheDocument()
  })

  test('shows the anomaly decision section for exception shipments', async () => {
    const user = userEvent.setup()
    server.use(listHandler(shipment({ status: 'exception' })))
    render(<ShipmentsPage />)
    await user.click(await screen.findByText('SHP-1001'))

    expect(await screen.findByText('Anomaly decision')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Freeze with evidence' })).toBeInTheDocument()
    expect(screen.getByText(/decisions are audited \(anomaly\.\*\)/)).toBeInTheDocument()
  })

  test('hides the anomaly decision section without anomaly.resolve permission', async () => {
    seedStaffSession({ permissions: ['shipment.read', 'shipment.hold'] })
    const user = userEvent.setup()
    server.use(listHandler(shipment({ status: 'exception' })))
    render(<ShipmentsPage />)
    await user.click(await screen.findByText('SHP-1001'))

    await screen.findByRole('dialog')
    expect(screen.queryByText('Anomaly decision')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
  })

  test('hides the anomaly decision section for non-exception shipments', async () => {
    const user = userEvent.setup()
    server.use(listHandler(shipment()))
    render(<ShipmentsPage />)
    await user.click(await screen.findByText('SHP-1001'))

    await screen.findByRole('dialog')
    expect(screen.queryByText('Anomaly decision')).not.toBeInTheDocument()
  })

  test('dismissing an anomaly shows the anomaly_resolve pending notice', async () => {
    const user = userEvent.setup()
    server.use(listHandler(shipment({ status: 'exception' })))
    render(<ShipmentsPage />)
    await user.click(await screen.findByText('SHP-1001'))
    await user.click(await screen.findByRole('button', { name: 'Dismiss' }))

    const prompt = screen.getByRole('dialog', { name: 'Dismiss anomaly' })
    await user.type(prompt.querySelector('textarea')!, 'Reviewed — no risk')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByText('PENDING_ENDPOINT')).toBeInTheDocument()
    expect(
      screen.getByText(/POST \/admin\/logistics-anomalies\/\{anomalyId\}\/decision/),
    ).toBeInTheDocument()
    expect(
      screen.getByText('This action is documented for backend implementation — nothing was sent.'),
    ).toBeInTheDocument()
  })
})
