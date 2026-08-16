import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import type {
  AdminIntegrationHealth200Item,
  AdminRoleDefinition,
  AuditLog,
  ConversationDetail,
  DataExportJob,
  MerchantAdmin,
  RiskCase,
} from '@hudumika/contract'
import { CompliancePage } from './CompliancePage'
import { server } from '../../test/setup'

function auditLog(over: Partial<AuditLog> = {}): AuditLog {
  return {
    id: 'aud_1',
    actorUserId: 'admin_1',
    actorRole: 'compliance',
    action: 'export.approve',
    entityType: 'data_export',
    entityId: 'exp_1',
    at: '2026-08-15T10:00:00.000Z',
    requestId: 'req_1',
    ...over,
  }
}

function exportJob(over: Partial<DataExportJob> = {}): DataExportJob {
  return {
    id: 'exp_1',
    scope: 'orders',
    format: 'csv',
    status: 'queued',
    createdAt: '2026-08-15T10:00:00.000Z',
    ...over,
  }
}

function conversation(over: Partial<ConversationDetail> = {}): ConversationDetail {
  return {
    id: 'conv_1',
    merchantId: 'mrc_1',
    customerUserId: 'cus_1',
    subject: 'Blocked link shared',
    status: 'blocked',
    lastMessagePreview: 'Suspicious link shared',
    unreadCount: 0,
    createdAt: '2026-08-14T10:00:00.000Z',
    updatedAt: '2026-08-15T10:00:00.000Z',
    participants: [{ role: 'customer', displayName: 'Juma', maskedPhone: '+255 7xx xxx 012' }],
    ...over,
  }
}

function riskCase(over: Partial<RiskCase> = {}): RiskCase {
  return {
    id: 'case_1',
    severity: 'high',
    signals: ['multiple_accounts', 'unusual_refunds'],
    status: 'open',
    createdAt: '2026-08-15T10:00:00.000Z',
    ...over,
  }
}

function integration(over: Partial<AdminIntegrationHealth200Item> = {}): AdminIntegrationHealth200Item {
  return {
    provider: 'vodacom_mpesa',
    category: 'payment',
    health: 'degraded',
    lastCheckedAt: '2026-08-15T10:00:00.000Z',
    ...over,
  }
}

function merchant(over: Partial<MerchantAdmin> = {}): MerchantAdmin {
  return {
    id: 'mrc_1',
    businessName: 'Karibu Groceries',
    city: 'Dar es Salaam',
    rating: 4.2,
    reviewCount: 120,
    isOpen: true,
    verification: 'documents_review',
    commercial: { commissionRateBps: 250 },
    documents: [],
    openedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function role(over: Partial<AdminRoleDefinition> = {}): AdminRoleDefinition {
  return {
    id: 'compliance',
    name: 'Compliance',
    permissions: ['audit.read', 'audit.unmask', 'export.approve'],
    system: true,
    ...over,
  }
}

type Seed = {
  audit?: AuditLog[]
  exports?: DataExportJob[]
  conversations?: ConversationDetail[]
  risk?: RiskCase[]
  integrations?: AdminIntegrationHealth200Item[]
  merchants?: MerchantAdmin[]
  roles?: AdminRoleDefinition[]
}

function seedAll(overrides: Seed = {}) {
  server.use(
    http.get('/admin/audit-logs', () => HttpResponse.json(overrides.audit ?? [])),
    http.get('/admin/data-exports', () => HttpResponse.json(overrides.exports ?? [])),
    http.get('/admin/conversations', () => HttpResponse.json(overrides.conversations ?? [])),
    http.get('/admin/risk/cases', () => HttpResponse.json(overrides.risk ?? [])),
    http.get('/admin/integrations', () => HttpResponse.json(overrides.integrations ?? [])),
    http.get('/admin/merchants', () => HttpResponse.json(overrides.merchants ?? [])),
    http.get('/admin/staff-roles', () => HttpResponse.json(overrides.roles ?? [])),
  )
}

function seedAllDown() {
  server.use(
    http.get('/admin/audit-logs', () => HttpResponse.error()),
    http.get('/admin/data-exports', () => HttpResponse.error()),
    http.get('/admin/conversations', () => HttpResponse.error()),
    http.get('/admin/risk/cases', () => HttpResponse.error()),
    http.get('/admin/integrations', () => HttpResponse.error()),
    http.get('/admin/merchants', () => HttpResponse.error()),
    http.get('/admin/staff-roles', () => HttpResponse.error()),
  )
}

function renderPage() {
  return render(
    <MemoryRouter>
      <CompliancePage />
    </MemoryRouter>,
  )
}

function statCard(label: string): HTMLElement {
  const card = screen
    .getAllByText(label)
    .map((el) => el.closest('.stat-card'))
    .find(Boolean) as HTMLElement
  expect(card).toBeTruthy()
  return card
}

describe('CompliancePage', () => {
  it('renders KPIs from seeded data', async () => {
    seedAll({
      audit: [auditLog(), auditLog({ id: 'aud_2', action: 'audit.query' })],
      exports: [exportJob(), exportJob({ id: 'exp_2' }), exportJob({ id: 'exp_3' })],
      conversations: [conversation(), conversation({ id: 'conv_2', status: 'open' })],
      risk: [riskCase(), riskCase({ id: 'case_2', status: 'investigating' })],
      integrations: [integration(), integration({ provider: 'tigo_pesa', health: 'healthy' })],
      merchants: [merchant(), merchant({ id: 'mrc_2', verification: 'approved' })],
      roles: [role()],
    })
    renderPage()

    expect(await screen.findByRole('heading', { name: 'Compliance console' })).toBeInTheDocument()
    expect(within(statCard('Audit entries')).getByText('2')).toBeInTheDocument()
    expect(within(statCard('Export jobs')).getByText('3')).toBeInTheDocument()
    expect(within(statCard('Blocked conversations')).getByText('1')).toBeInTheDocument()
    expect(within(statCard('Open risk cases')).getByText('2')).toBeInTheDocument()
    expect(within(statCard('Merchants pending verification')).getByText('1')).toBeInTheDocument()
    expect(within(statCard('Payment integrations')).getByText('1')).toBeInTheDocument()
  })

  it('renders a blocked conversation queue row with a deep link to conversations', async () => {
    seedAll({
      conversations: [conversation(), conversation({ id: 'conv_open', status: 'open' })],
    })
    renderPage()

    const row = (await screen.findByText('conv_1')).closest('.queue-item') as HTMLElement
    expect(within(row).getByText('blocked')).toBeInTheDocument()
    expect(within(row).getByText(/Blocked link shared/)).toBeInTheDocument()
    expect(within(row).getByRole('link', { name: 'Open conversations' })).toHaveAttribute('href', '/conversations')
    expect(screen.queryByText('conv_open')).not.toBeInTheDocument()
  })

  it('renders export approval jobs with scope and format tags and a deep link to exports', async () => {
    seedAll({
      exports: [
        exportJob(),
        exportJob({ id: 'exp_ready', scope: 'catalogue', status: 'ready' }),
        exportJob({ id: 'exp_fin', scope: 'financial', format: 'xlsx', status: 'processing' }),
      ],
    })
    renderPage()

    const row = (await screen.findByText('exp_1')).closest('.queue-item') as HTMLElement
    expect(within(row).getByText('orders')).toBeInTheDocument()
    expect(within(row).getByText('csv')).toBeInTheDocument()
    expect(within(row).getByText('queued')).toBeInTheDocument()
    expect(within(row).getByRole('link', { name: 'Open exports' })).toHaveAttribute('href', '/exports')

    const fin = screen.getByText('exp_fin').closest('.queue-item') as HTMLElement
    expect(within(fin).getByText('financial')).toBeInTheDocument()
    expect(within(fin).getByText('xlsx')).toBeInTheDocument()
    expect(within(fin).getByText('processing')).toBeInTheDocument()
    expect(screen.queryByText('exp_ready')).not.toBeInTheDocument()
  })

  it('shows an unavailable note for a failing section while the rest of the page renders, and recovers on retry', async () => {
    seedAll({
      exports: [exportJob()],
      conversations: [conversation()],
      risk: [riskCase()],
    })
    server.use(
      http.get('/admin/risk/cases', () =>
        HttpResponse.json(
          { code: 'FORBIDDEN', message: 'risk endpoint forbidden', requestId: 'req_risk' },
          { status: 403 },
        ),
      ),
    )
    renderPage()

    expect(await screen.findByText(/risk endpoint forbidden/)).toBeInTheDocument()
    expect(screen.getByText('Unavailable — risk endpoint forbidden')).toBeInTheDocument()
    expect(within(statCard('Open risk cases')).getByText('—')).toBeInTheDocument()
    expect(screen.getByText('exp_1')).toBeInTheDocument()
    expect(screen.getByText('conv_1')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Compliance console' })).toBeInTheDocument()

    server.use(http.get('/admin/risk/cases', () => HttpResponse.json([riskCase({ id: 'case_recovered' })])))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('case_recovered')).toBeInTheDocument()
    expect(screen.queryByText(/risk endpoint forbidden/)).not.toBeInTheDocument()
  })

  it('shows an empty state when every oversight queue is empty', async () => {
    seedAll({
      audit: [auditLog()],
      exports: [exportJob({ status: 'ready' })],
      conversations: [conversation({ status: 'archived' })],
      risk: [riskCase({ status: 'resolved' })],
      integrations: [integration({ health: 'healthy' })],
      merchants: [merchant({ verification: 'approved' })],
    })
    renderPage()

    expect(await screen.findByText('No oversight queues')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Export approvals' })).not.toBeInTheDocument()
  })

  it('shows a page-level error for total failure and recovers on retry', async () => {
    seedAllDown()
    renderPage()

    expect(await screen.findByText('Compliance console unavailable')).toBeInTheDocument()

    seedAll({
      audit: [auditLog()],
      exports: [exportJob()],
      conversations: [conversation()],
      risk: [riskCase()],
      integrations: [integration()],
      merchants: [merchant()],
      roles: [role()],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByRole('heading', { name: 'Compliance console' })).toBeInTheDocument()
    expect(screen.queryByText('Compliance console unavailable')).not.toBeInTheDocument()
    expect(within(statCard('Audit entries')).getByText('1')).toBeInTheDocument()
    expect(screen.getByText('exp_1')).toBeInTheDocument()
  })
})
