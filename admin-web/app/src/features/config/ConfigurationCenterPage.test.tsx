import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ConfigurationCenterPage } from './ConfigurationCenterPage'

const LIVE_DOMAINS: Array<[string, string]> = [
  ['Regions', '/configuration/regions'],
  ['Cities', '/configuration/regions'],
  ['Commissions', '/configuration/commissions'],
  ['SLA rules', '/configuration/sla'],
  ['Feature flags', '/configuration/feature-flags'],
  ['Staff roles', '/iam/users'],
]

const PENDING_DOMAINS = [
  'Service/delivery zones',
  'Fees',
  'Tax rules',
  'Cancellation rules',
  'Matching rules',
  'Risk rules',
  'Notification rules',
]

function renderPage() {
  return render(
    <MemoryRouter>
      <ConfigurationCenterPage />
    </MemoryRouter>,
  )
}

describe('ConfigurationCenterPage', () => {
  it('renders all 13 domain rows in the DataTable', () => {
    renderPage()

    expect(screen.getByRole('heading', { name: 'Configuration center' })).toBeInTheDocument()
    expect(screen.getAllByRole('row')).toHaveLength(14)
    for (const [name] of LIVE_DOMAINS) {
      expect(screen.getByText(name)).toBeInTheDocument()
    }
    for (const name of PENDING_DOMAINS) {
      expect(screen.getByText(name)).toBeInTheDocument()
    }
  })

  it('deep-links live domains to their pages with Open buttons', () => {
    renderPage()

    for (const [name, href] of LIVE_DOMAINS) {
      const row = screen.getByRole('row', { name: new RegExp(name) })
      expect(within(row).getByRole('link', { name: 'Open' })).toHaveAttribute('href', href)
    }
    expect(screen.getAllByRole('link', { name: 'Open' })).toHaveLength(6)
  })

  it('renders pending domains with the pending note and no link', () => {
    renderPage()

    const note = 'This action is pending backend implementation.'
    expect(screen.getAllByText(note)).toHaveLength(7)
    for (const name of PENDING_DOMAINS) {
      const row = screen.getByRole('row', { name: new RegExp(name) })
      expect(within(row).queryByRole('link')).not.toBeInTheDocument()
      expect(within(row).getByText(note)).toBeInTheDocument()
    }
  })

  it('shows status pills and audit prefixes for every row', () => {
    renderPage()

    expect(screen.getAllByText('Live')).toHaveLength(6)
    expect(screen.getAllByText('Pending')).toHaveLength(7)
    expect(screen.getAllByText('configuration.*')).toHaveLength(5)
    for (const prefix of ['zones.*', 'fees.*', 'tax.*', 'cancellation.*', 'matching.*', 'risk_rules.*', 'notification_rules.*', 'iam.*']) {
      expect(screen.getByText(prefix)).toBeInTheDocument()
    }
  })

  it('renders the audit note below the table', () => {
    renderPage()

    expect(
      screen.getByText(/Every change is audited \(configuration\.\*\); sensitive changes require a reason and two-person approval where flagged\./),
    ).toBeInTheDocument()
  })
})
