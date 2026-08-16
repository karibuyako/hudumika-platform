import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  adminListAuditLogs,
  adminListConversations,
  adminListDataExports,
  adminListMerchants,
  adminListRiskCases,
  adminListStaffRoles,
  adminIntegrationHealth,
  type AdminIntegrationHealth200Item,
  type AdminRoleDefinition,
  type AuditLog,
  type ConversationDetail,
  type DataExportJob,
  type MerchantAdmin,
  type RiskCase,
} from '@hudumika/contract'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { StatCard } from '../../components/StatCard'
import { StatusPill } from '../../components/StatusPill'
import { parseApiError } from '../../lib/api-error'
import { toLocal } from '../../lib/time'
import { useSession } from '../../lib/session'
import { can } from '../../lib/permissions'

const QUEUE_LIMIT = 5

const EXPORT_APPROVAL_SCOPES: DataExportJob['scope'][] = ['all', 'orders', 'customers', 'financial']
const PENDING_VERIFICATION: MerchantAdmin['verification'][] = ['pending', 'documents_review', 'changes_requested']
const OPEN_RISK_STATUSES: RiskCase['status'][] = ['open', 'investigating']

type SectionResult<T> = { data: T | null; error: string | null }

type Sections = {
  audit: SectionResult<AuditLog[]>
  exports: SectionResult<DataExportJob[]>
  conversations: SectionResult<ConversationDetail[]>
  risk: SectionResult<RiskCase[]>
  integrations: SectionResult<AdminIntegrationHealth200Item[]>
  merchants: SectionResult<MerchantAdmin[]>
  roles: SectionResult<AdminRoleDefinition[]>
}

type SectionKey = keyof Sections

const LOADERS: Record<SectionKey, { load: () => Promise<{ status: number; data: unknown }>; fallback: string }> = {
  audit: { load: () => adminListAuditLogs(), fallback: 'Audit entries unavailable' },
  exports: { load: () => adminListDataExports(), fallback: 'Export jobs unavailable' },
  conversations: { load: () => adminListConversations(), fallback: 'Conversations unavailable' },
  risk: { load: () => adminListRiskCases(), fallback: 'Risk cases unavailable' },
  integrations: { load: () => adminIntegrationHealth(), fallback: 'Integration health unavailable' },
  merchants: { load: () => adminListMerchants(), fallback: 'Merchants unavailable' },
  roles: { load: () => adminListStaffRoles(), fallback: 'Staff roles unavailable' },
}

function resolveSection<T>(res: { status: number; data: unknown }, fallback: string): SectionResult<T> {
  if (res.status === 200) return { data: res.data as T, error: null }
  return { data: null, error: parseApiError(res, fallback).message }
}

function riskSeverityTone(severity: RiskCase['severity']): 'bad' | 'warn' | 'info' | 'muted' {
  if (severity === 'critical') return 'bad'
  if (severity === 'high') return 'warn'
  if (severity === 'medium') return 'info'
  return 'muted'
}

function riskStatusTone(status: RiskCase['status']): 'warn' | 'info' | 'ok' | 'bad' {
  if (status === 'open') return 'warn'
  if (status === 'investigating') return 'info'
  if (status === 'resolved') return 'ok'
  return 'bad'
}

export function CompliancePage() {
  const [sections, setSections] = useState<Sections | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const session = useSession()

  useEffect(() => {
    let alive = true
    setFatal(null)
    Promise.all([
      LOADERS.audit.load(),
      LOADERS.exports.load(),
      LOADERS.conversations.load(),
      LOADERS.risk.load(),
      LOADERS.integrations.load(),
      LOADERS.merchants.load(),
      LOADERS.roles.load(),
    ])
      .then(([audit, exportsRes, conversations, risk, integrations, merchants, roles]) => {
        if (!alive) return
        setSections({
          audit: resolveSection<AuditLog[]>(audit, LOADERS.audit.fallback),
          exports: resolveSection<DataExportJob[]>(exportsRes, LOADERS.exports.fallback),
          conversations: resolveSection<ConversationDetail[]>(conversations, LOADERS.conversations.fallback),
          risk: resolveSection<RiskCase[]>(risk, LOADERS.risk.fallback),
          integrations: resolveSection<AdminIntegrationHealth200Item[]>(integrations, LOADERS.integrations.fallback),
          merchants: resolveSection<MerchantAdmin[]>(merchants, LOADERS.merchants.fallback),
          roles: resolveSection<AdminRoleDefinition[]>(roles, LOADERS.roles.fallback),
        })
      })
      .catch((err: unknown) => {
        if (!alive) return
        setFatal(err instanceof Error ? err.message : 'Failed to load compliance data')
      })
    return () => {
      alive = false
    }
  }, [retryKey])

  function refetch(key: SectionKey) {
    const { load, fallback } = LOADERS[key]
    load().then((res) => {
      setSections((prev) => (prev ? { ...prev, [key]: resolveSection(res, fallback) } : prev))
    })
  }

  if (fatal) {
    return (
      <ErrorState title="Compliance console unavailable" message={fatal} onRetry={() => setRetryKey((k) => k + 1)} />
    )
  }
  if (!sections) return <LoadingSkeleton kind="stats" />

  const auditCount = sections.audit.data?.length
  const exportCount = sections.exports.data?.length
  const blockedCount = sections.conversations.data?.filter((c) => c.status === 'blocked').length
  const openRiskCount = sections.risk.data?.filter((c) => OPEN_RISK_STATUSES.includes(c.status)).length
  const pendingMerchantsCount = sections.merchants.data?.filter((m) => PENDING_VERIFICATION.includes(m.verification)).length
  const paymentIssues = sections.integrations.data?.filter(
    (i) => i.category === 'payment' && (i.health === 'down' || i.health === 'degraded'),
  ).length

  const exportApprovals = (sections.exports.data ?? []).filter(
    (j) => EXPORT_APPROVAL_SCOPES.includes(j.scope) && (j.status === 'queued' || j.status === 'processing'),
  )
  const blockedConversations = (sections.conversations.data ?? []).filter((c) => c.status === 'blocked')
  const pendingMerchants = (sections.merchants.data ?? []).filter((m) => PENDING_VERIFICATION.includes(m.verification))
  const openRiskCases = (sections.risk.data ?? []).filter((c) => OPEN_RISK_STATUSES.includes(c.status))

  const allQueuesEmpty =
    sections.exports.data !== null &&
    sections.conversations.data !== null &&
    sections.merchants.data !== null &&
    sections.risk.data !== null &&
    exportApprovals.length === 0 &&
    blockedConversations.length === 0 &&
    pendingMerchants.length === 0 &&
    openRiskCases.length === 0

  const grantingRoles = (sections.roles.data ?? []).filter(
    (r) => r.permissions.includes('audit.unmask') || r.permissions.includes('export.approve') || r.permissions.includes('*'),
  )

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Compliance console</h1>
      </div>
      <p className="muted small">
        Read-only oversight: audit queries, export approvals, verification and blocked-conversation history are all
        gated and audited.
      </p>

      <div className="kpi">
        <StatCard label="Audit entries" value={auditCount ?? '—'} />
        <StatCard label="Export jobs" value={exportCount ?? '—'} />
        <StatCard label="Blocked conversations" value={blockedCount ?? '—'} tone={blockedCount ? 'warn' : 'default'} />
        <StatCard label="Open risk cases" value={openRiskCount ?? '—'} tone={openRiskCount ? 'warn' : 'default'} />
        <StatCard
          label="Merchants pending verification"
          value={pendingMerchantsCount ?? '—'}
          tone={pendingMerchantsCount ? 'warn' : 'default'}
        />
        <StatCard label="Payment integrations" value={paymentIssues ?? '—'} tone={paymentIssues ? 'danger' : 'default'} />
      </div>

      <h2>Oversight queues</h2>
      {allQueuesEmpty ? (
        <EmptyState
          title="No oversight queues"
          hint="Export approvals, blocked conversations, merchant verifications, and open risk cases are all clear."
        />
      ) : (
        <>
          <QueueBlock
            title="Export approvals"
            sectionError={sections.exports.error}
            rows={exportApprovals.map((job) => ({
              key: job.id,
              title: (
                <>
                  <span className="mono">{job.id}</span> <span className="tag">{job.scope}</span>{' '}
                  <span className="tag muted">{job.format}</span>{' '}
                  <StatusPill status={job.status} tone={job.status === 'processing' ? 'info' : 'muted'} />
                </>
              ),
              detail: <>Requested {toLocal(job.createdAt)}</>,
            }))}
            emptyLabel="No exports awaiting approval"
            linkLabel="Open exports"
            to="/exports"
            onRetry={() => refetch('exports')}
          />
          <QueueBlock
            title="Blocked conversations"
            sectionError={sections.conversations.error}
            rows={blockedConversations.map((c) => ({
              key: c.id,
              title: (
                <>
                  <span className="mono">{c.id}</span> <StatusPill status="blocked" tone="bad" />
                </>
              ),
              detail: (
                <>
                  {c.subject ? `${c.subject} · ` : ''}
                  Updated {toLocal(c.updatedAt)}
                </>
              ),
            }))}
            emptyLabel="No blocked conversations"
            linkLabel="Open conversations"
            to="/conversations"
            onRetry={() => refetch('conversations')}
          />
          <QueueBlock
            title="Merchant verifications pending"
            sectionError={sections.merchants.error}
            rows={pendingMerchants.map((m) => ({
              key: m.id,
              title: (
                <>
                  {m.businessName} <StatusPill status={m.verification} tone="warn" />
                </>
              ),
              detail: (
                <>
                  {m.city} · <span className="mono">{m.id}</span>
                </>
              ),
            }))}
            emptyLabel="No merchant verifications pending"
            linkLabel="Open merchants"
            to="/commerce/merchants"
            onRetry={() => refetch('merchants')}
          />
          <QueueBlock
            title="Open risk cases"
            sectionError={sections.risk.error}
            rows={openRiskCases.map((c) => ({
              key: c.id,
              title: (
                <>
                  <span className="mono">{c.id}</span>{' '}
                  <StatusPill status={c.severity} tone={riskSeverityTone(c.severity)} />
                </>
              ),
              detail: (
                <>
                  <StatusPill status={c.status} tone={riskStatusTone(c.status)} /> · {c.signals.length} signals ·
                  Created {toLocal(c.createdAt)}
                </>
              ),
            }))}
            emptyLabel="No open risk cases"
            linkLabel="Open risk"
            to="/trust/risk-cases"
            onRetry={() => refetch('risk')}
          />
        </>
      )}

      <h2>Read-only audit access</h2>
      <div className="state-card">
        <div className="state-title">Read-only audit access</div>
        <div className="state-message">
          Compliance holds permissioned unmask (audit.unmask) and export approval (export.approve); every view here is
          itself audited (audit.*).
        </div>
        {sections.roles.error ? (
          <p className="muted small">Role registry unavailable — {sections.roles.error}</p>
        ) : (
          <p className="muted small">
            Roles granting unmask or export approval:{' '}
            {grantingRoles.length > 0 ? grantingRoles.map((r) => r.name).join(', ') : 'none'}
          </p>
        )}
        <p className="muted small">
          Your session: {can(session, 'audit.unmask') ? 'audit.unmask granted' : 'audit.unmask not granted'} ·{' '}
          {can(session, 'export.approve') ? 'export.approve granted' : 'export.approve not granted'}
        </p>
        <Link className="btn" to="/audit/logs">
          Open audit logs
        </Link>
      </div>
    </div>
  )
}

type QueueRow = { key: string; title: ReactNode; detail: ReactNode }

function UnavailableNote({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <p className="muted small">
      Unavailable — {message}{' '}
      <button type="button" className="btn btn-ghost" onClick={onRetry}>
        Retry
      </button>
    </p>
  )
}

function QueueBlock({
  title,
  sectionError,
  rows,
  emptyLabel,
  linkLabel,
  to,
  onRetry,
}: {
  title: string
  sectionError: string | null
  rows: QueueRow[]
  emptyLabel: string
  linkLabel: string
  to: string
  onRetry: () => void
}) {
  return (
    <>
      <h3>{title}</h3>
      {sectionError ? (
        <UnavailableNote message={sectionError} onRetry={onRetry} />
      ) : rows.length === 0 ? (
        <p className="muted small">{emptyLabel}</p>
      ) : (
        <>
          <div className="queue-list">
            {rows.slice(0, QUEUE_LIMIT).map((row) => (
              <div className="queue-item" key={row.key}>
                <div className="queue-main">
                  <div>{row.title}</div>
                  <div className="muted small">{row.detail}</div>
                </div>
                <div className="queue-actions">
                  <Link className="btn" to={to}>
                    {linkLabel}
                  </Link>
                </div>
              </div>
            ))}
          </div>
          {rows.length > QUEUE_LIMIT && <p className="muted small">+{rows.length - QUEUE_LIMIT} more</p>}
        </>
      )}
    </>
  )
}
