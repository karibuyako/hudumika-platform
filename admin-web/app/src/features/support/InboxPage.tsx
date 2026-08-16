import { useEffect, useMemo, useState } from 'react'
import {
  adminAssignTicket,
  adminListTickets,
  type Ticket,
  type TicketPriority,
  type TicketStatus,
} from '@hudumika/contract'
import { DetailDrawer } from '../../components/DetailDrawer'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { FilterChips } from '../../components/FilterChips'
import { InlineError, Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { StatusPill } from '../../components/StatusPill'
import { parseApiError } from '../../lib/api-error'
import { toLocal } from '../../lib/time'

type Bucket = 'all' | 'open' | 'assigned' | 'resolved' | 'closed'
type PriorityFilter = 'all' | TicketPriority

const BUCKETS: Array<{ key: Bucket; label: string; match: (t: Ticket) => boolean }> = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'open', label: 'Open', match: (t) => t.status === 'open' },
  {
    key: 'assigned',
    label: 'Assigned',
    match: (t) => t.status === 'assigned' || t.status === 'in_progress',
  },
  { key: 'resolved', label: 'Resolved', match: (t) => t.status === 'resolved' },
  { key: 'closed', label: 'Closed', match: (t) => t.status === 'closed' },
]

const PRIORITIES: Array<{ key: PriorityFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'low', label: 'low' },
  { key: 'normal', label: 'normal' },
  { key: 'high', label: 'high' },
  { key: 'critical', label: 'critical' },
]

export function InboxPage() {
  const [tickets, setTickets] = useState<Ticket[] | null>(null)
  const [bucket, setBucket] = useState<Bucket>('all')
  const [priority, setPriority] = useState<PriorityFilter>('all')
  const [selected, setSelected] = useState<Ticket | null>(null)
  const [assigning, setAssigning] = useState<Ticket | null>(null)
  const [busy, setBusy] = useState(false)
  const [assignError, setAssignError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    setError(null)
    adminListTickets().then((res) => {
      if (res.status === 200) setTickets(res.data)
      else setError(`Failed to load tickets (${res.status})`)
    })
  }, [retryKey])

  const counts = useMemo(() => {
    const map = new Map<Bucket, number>()
    for (const b of BUCKETS) map.set(b.key, (tickets ?? []).filter(b.match).length)
    return map
  }, [tickets])

  const visible = useMemo(() => {
    const match = BUCKETS.find((b) => b.key === bucket)!.match
    return (tickets ?? [])
      .filter(match)
      .filter((t) => priority === 'all' || t.priority === priority)
  }, [tickets, bucket, priority])

  async function confirmAssign(agentUserId: string) {
    if (!assigning) return
    setBusy(true)
    setAssignError(null)
    const res = await adminAssignTicket(assigning.id, { agentUserId })
    if (res.status === 200) {
      const updated = res.data
      setTickets((prev) => (prev ?? []).map((t) => (t.id === updated.id ? { ...t, ...updated } : t)))
      setSelected(null)
      setAssigning(null)
      setToast(`Ticket assigned to ${agentUserId}`)
      setRetryKey((k) => k + 1)
    } else {
      setAssignError(parseApiError(res, 'Failed to assign ticket').message)
    }
    setBusy(false)
  }

  if (error) {
    return (
      <ErrorState
        title="Failed to load support tickets"
        message={error}
        onRetry={() => setRetryKey((k) => k + 1)}
      />
    )
  }
  if (!tickets) return <LoadingSkeleton kind="table" rows={6} />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Support Inbox</h1>
      </div>

      {toast && <Toast message={toast} />}

      <FilterChips
        options={BUCKETS.map(({ key, label }) => ({ key, label }))}
        value={bucket}
        onChange={setBucket}
        counts={Object.fromEntries(counts)}
        ariaLabel="Status buckets"
      />
      <FilterChips options={PRIORITIES} value={priority} onChange={setPriority} ariaLabel="Priority" />

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Subject</th>
              <th>Status</th>
              <th>Priority</th>
              <th>Agent</th>
              <th>Created</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  <EmptyState title="No tickets in this bucket" />
                </td>
              </tr>
            )}
            {visible.map((ticket) => (
              <tr key={ticket.id} className="row-click" onClick={() => setSelected(ticket)}>
                <td>
                  <span className="mono">{short(ticket.id)}</span>
                </td>
                <td>{ticket.subject}</td>
                <td>
                  <StatusPill status={ticket.status} tone={statusTone(ticket.status)} />
                </td>
                <td>
                  <PriorityBadge priority={ticket.priority} />
                </td>
                <td>{ticket.assignedAgentId ? <span className="mono">{ticket.assignedAgentId}</span> : '—'}</td>
                <td className="muted">{toLocal(ticket.createdAt)}</td>
                <td className="muted">{toLocal(ticket.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <DetailDrawer title={selected.subject} onClose={() => setSelected(null)}>
          <TicketDetails
            ticket={selected}
            onAssign={() => {
              setAssignError(null)
              setAssigning(selected)
            }}
          />
        </DetailDrawer>
      )}

      {assigning && (
        <AssignModal
          ticket={assigning}
          busy={busy}
          error={assignError}
          onClose={() => setAssigning(null)}
          onConfirm={confirmAssign}
        />
      )}
    </div>
  )
}

function TicketDetails({ ticket, onAssign }: { ticket: Ticket; onAssign: () => void }) {
  return (
    <div>
      <div className="meta-grid">
        <div className="meta-item">
          <span className="meta-label">Ticket</span>
          <span className="meta-value mono">{ticket.id}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Subject</span>
          <span className="meta-value">{ticket.subject}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Status</span>
          <span className="meta-value">
            <StatusPill status={ticket.status} tone={statusTone(ticket.status)} />
          </span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Priority</span>
          <span className="meta-value">
            <PriorityBadge priority={ticket.priority} />
          </span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Assigned agent</span>
          <span className="meta-value">{ticket.assignedAgentId ? <span className="mono">{ticket.assignedAgentId}</span> : '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Created</span>
          <span className="meta-value muted">{toLocal(ticket.createdAt)}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Updated</span>
          <span className="meta-value muted">{toLocal(ticket.updatedAt)}</span>
        </div>
      </div>

      <h3>Assignment</h3>
      {ticket.assignedAgentId ? (
        <p className="small">
          Agent: <span className="mono">{ticket.assignedAgentId}</span>
          <br />
          <span className="muted">Reassign to a different agent if needed.</span>
        </p>
      ) : (
        <p className="muted small">Not assigned to any agent yet.</p>
      )}
      <button className="btn" onClick={onAssign} type="button">
        {ticket.assignedAgentId ? 'Reassign' : 'Assign to agent'}
      </button>
    </div>
  )
}

function AssignModal({
  ticket,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  ticket: Ticket
  busy: boolean
  error: string | null
  onClose: () => void
  onConfirm: (agentUserId: string) => void
}) {
  const [agentUserId, setAgentUserId] = useState('')

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Assign ticket"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          if (agentUserId.trim()) onConfirm(agentUserId.trim())
        }}
      >
        <h3 className="modal-title">Assign to agent</h3>
        <p className="muted small">{ticket.subject}</p>
        <div className="form-grid">
          <label className="field-label" htmlFor="agent-user-id">
            Agent user ID
          </label>
          <input
            id="agent-user-id"
            className="field"
            value={agentUserId}
            onChange={(e) => setAgentUserId(e.target.value)}
            placeholder="user_…"
            autoFocus
          />
        </div>
        {error && <InlineError message={error} />}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy || !agentUserId.trim()}>
            {busy ? 'Working…' : 'Assign'}
          </button>
        </div>
      </form>
    </div>
  )
}

export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  const cls = priority === 'critical' ? 'bad' : priority === 'high' ? 'warn' : 'muted'
  return <span className={`badge ${cls}`}>{priority}</span>
}

function statusTone(status: TicketStatus): 'warn' | 'info' | 'ok' | 'muted' {
  if (status === 'open') return 'warn'
  if (status === 'assigned' || status === 'in_progress') return 'info'
  if (status === 'resolved') return 'ok'
  return 'muted'
}

function short(id: string) {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}
