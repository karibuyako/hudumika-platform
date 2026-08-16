import { Link } from 'react-router-dom'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { StatusPill } from '../../components/StatusPill'
import { pendingEndpointNotice } from '../../lib/pending-endpoints'

interface ConfigDomain {
  id: string
  name: string
  description: string
  status: 'live' | 'pending'
  route?: string
  auditPrefix: string
}

const PENDING_NOTE = pendingEndpointNotice('__missing__')

const CONFIG_DOMAINS: ConfigDomain[] = [
  {
    id: 'regions',
    name: 'Regions',
    description: 'Country regions and their delivery areas',
    status: 'live',
    route: '/configuration/regions',
    auditPrefix: 'configuration.*',
  },
  {
    id: 'cities',
    name: 'Cities',
    description: 'Cities and their service areas',
    status: 'live',
    route: '/configuration/regions',
    auditPrefix: 'configuration.*',
  },
  {
    id: 'service-zones',
    name: 'Service/delivery zones',
    description: 'Zone boundaries and delivery pricing',
    status: 'pending',
    auditPrefix: 'zones.*',
  },
  {
    id: 'fees',
    name: 'Fees',
    description: 'Platform and service fee schedules',
    status: 'pending',
    auditPrefix: 'fees.*',
  },
  {
    id: 'commissions',
    name: 'Commissions',
    description: 'Commission rates by scope',
    status: 'live',
    route: '/configuration/commissions',
    auditPrefix: 'configuration.*',
  },
  {
    id: 'tax-rules',
    name: 'Tax rules',
    description: 'Tax rates by jurisdiction and category',
    status: 'pending',
    auditPrefix: 'tax.*',
  },
  {
    id: 'cancellation-rules',
    name: 'Cancellation rules',
    description: 'Cancellation windows, charges and refunds',
    status: 'pending',
    auditPrefix: 'cancellation.*',
  },
  {
    id: 'sla',
    name: 'SLA rules',
    description: 'Response and resolution targets by scope',
    status: 'live',
    route: '/configuration/sla',
    auditPrefix: 'configuration.*',
  },
  {
    id: 'matching-rules',
    name: 'Matching rules',
    description: 'Dispatch matching and assignment logic',
    status: 'pending',
    auditPrefix: 'matching.*',
  },
  {
    id: 'risk-rules',
    name: 'Risk rules',
    description: 'Fraud, rating and risk thresholds',
    status: 'pending',
    auditPrefix: 'risk_rules.*',
  },
  {
    id: 'feature-flags',
    name: 'Feature flags',
    description: 'Feature rollout, beta and targeting',
    status: 'live',
    route: '/configuration/feature-flags',
    auditPrefix: 'configuration.*',
  },
  {
    id: 'notification-rules',
    name: 'Notification rules',
    description: 'Notification channels and event routing',
    status: 'pending',
    auditPrefix: 'notification_rules.*',
  },
  {
    id: 'staff-roles',
    name: 'Staff roles',
    description: 'Role definitions and permissions (IAM, configured here)',
    status: 'live',
    route: '/iam/users',
    auditPrefix: 'iam.*',
  },
]

const COLUMNS: DataTableColumn<ConfigDomain>[] = [
  {
    key: 'domain',
    header: 'Domain',
    sortValue: (d) => d.name,
    render: (d) => (
      <>
        <strong>{d.name}</strong>
        <div className="muted small">{d.description}</div>
        {d.status === 'pending' && <div className="muted small">{PENDING_NOTE}</div>}
      </>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    render: (d) => (
      <StatusPill
        status={d.status}
        tone={d.status === 'live' ? 'ok' : 'warn'}
        label={d.status === 'live' ? 'Live' : 'Pending'}
      />
    ),
  },
  {
    key: 'audit',
    header: 'Audit prefix',
    render: (d) => <span className="mono">{d.auditPrefix}</span>,
  },
  {
    key: 'route',
    header: 'Route',
    render: (d) =>
      d.route ? (
        <Link className="btn" to={d.route}>
          Open
        </Link>
      ) : (
        <span className="muted">—</span>
      ),
  },
]

export function ConfigurationCenterPage() {
  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Configuration center</h1>
      </div>
      <DataTable rows={CONFIG_DOMAINS} columns={COLUMNS} rowKey={(d) => d.id} ariaLabel="Configuration domains" />
      <p className="muted small">
        Every change is audited (configuration.*); sensitive changes require a reason and two-person approval where
        flagged.
      </p>
    </div>
  )
}
