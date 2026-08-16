import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  adminCreateTwoPersonApproval,
  adminDecideTwoPersonApproval,
  adminListTwoPersonApprovals,
  AdminTwoPersonApprovalActionType,
  AdminTwoPersonApprovalStatus,
  type AdminCreateTwoPersonApprovalBody,
  type AdminTwoPersonApproval,
} from '@hudumika/contract'
import { parseApiError } from '../../lib/api-error'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'
import { toLocal } from '../../lib/time'
import { DetailDrawer } from '../../components/DetailDrawer'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { FilterChips } from '../../components/FilterChips'
import { Field, Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { StatusPill } from '../../components/StatusPill'

type StatusFilter = 'all' | (typeof AdminTwoPersonApprovalStatus)[keyof typeof AdminTwoPersonApprovalStatus]
type Decision = 'approve' | 'reject'

const STATUSES = Object.values(AdminTwoPersonApprovalStatus)
const ACTION_TYPES = Object.values(AdminTwoPersonApprovalActionType)

const FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  ...STATUSES.map((s) => ({ key: s as StatusFilter, label: s.replace(/_/g, ' ') })),
]

function approvalTone(status: string): 'ok' | 'bad' | 'warn' {
  if (status === 'approved') return 'ok'
  if (status === 'rejected') return 'bad'
  return 'warn'
}

function actionLabel(actionType: string): string {
  return actionType.replace(/_/g, ' ')
}

export function TwoPersonApprovalsPage() {
  const [all, setAll] = useState<AdminTwoPersonApproval[] | null>(null)
  const [rows, setRows] = useState<AdminTwoPersonApproval[]>([])
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [selected, setSelected] = useState<AdminTwoPersonApproval | null>(null)
  const [prompt, setPrompt] = useState<{ approval: AdminTwoPersonApproval; decision: Decision } | null>(null)
  const [promptError, setPromptError] = useState<string | null>(null)
  const [decisionError, setDecisionError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const session = useSession()
  const canDecide = can(session, 'approval.decide')

  useEffect(() => {
    setError(null)
    const params = filter === 'all' ? undefined : { status: filter }
    adminListTwoPersonApprovals(params).then((res) => {
      if (res.status === 200) {
        setRows(res.data)
        if (params === undefined) setAll(res.data)
        setSelected((prev) => {
          if (!prev) return prev
          const next = res.data.find((r) => r.id === prev.id)
          return next ?? prev
        })
      } else {
        setError(`Failed to load approvals (${res.status})`)
      }
    })
  }, [retryKey, filter])

  const counts = useMemo(() => {
    const map: Partial<Record<StatusFilter, number>> = { all: all?.length ?? 0 }
    for (const s of STATUSES) map[s] = (all ?? []).filter((a) => a.status === s).length
    return map
  }, [all])

  async function decide(comment: string) {
    const target = prompt
    if (!target) return
    setBusy(true)
    setPromptError(null)
    const res = await adminDecideTwoPersonApproval(target.approval.id, {
      decision: target.decision,
      comment,
    })
    if (res.status === 200) {
      setSelected(null)
      setPrompt(null)
      setDecisionError(null)
      setToast(target.decision === 'approve' ? 'Request approved' : 'Request rejected')
      setRetryKey((k) => k + 1)
    } else {
      const info = parseApiError(res)
      if (res.status === 409 && info.code === 'APPROVAL_SAME_ACTOR') {
        setPromptError('You cannot decide on your own request (APPROVAL_SAME_ACTOR)')
      } else if (res.status === 409 && info.code === 'APPROVAL_ALREADY_DECIDED') {
        setPrompt(null)
        setDecisionError('This request has already been decided (APPROVAL_ALREADY_DECIDED)')
        setRetryKey((k) => k + 1)
      } else {
        setPromptError(info.message)
      }
    }
    setBusy(false)
  }

  async function createApproval(body: AdminCreateTwoPersonApprovalBody) {
    setBusy(true)
    setFormError(null)
    const res = await adminCreateTwoPersonApproval(body)
    if (res.status === 201) {
      setShowCreate(false)
      setToast('Approval request created')
      setRetryKey((k) => k + 1)
    } else {
      setFormError(parseApiError(res).message)
    }
    setBusy(false)
  }

  if (error) {
    return <ErrorState title="Failed to load approvals" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
  }
  if (!all) return <LoadingSkeleton kind="table" rows={6} />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Two-Person Approvals</h1>
        <div className="page-actions">
          {toast && <Toast message={toast} />}
          {canDecide && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setFormError(null)
                setShowCreate(true)
              }}
            >
              New request
            </button>
          )}
        </div>
      </div>
      <p className="muted small">
        Dangerous actions require a second admin's approval; both actors are audited (two_person_approval.*).
      </p>
      {!canDecide && <p className="muted small">Two-person decisions require approval.decide</p>}

      <FilterChips options={FILTERS} value={filter} onChange={setFilter} counts={counts} ariaLabel="Approval status filters" />

      {rows.length === 0 ? (
        <EmptyState title="No approval requests" hint="Requests appear here when an admin initiates a two-person approval." />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Action</th>
                <th>Target</th>
                <th>Status</th>
                <th>Requested by</th>
                <th>Created</th>
                <th>Decided by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((approval) => (
                <tr
                  key={approval.id}
                  className="row-click"
                  onClick={() => {
                    setDecisionError(null)
                    setPrompt(null)
                    setSelected(approval)
                  }}
                >
                  <td className="mono">{approval.id}</td>
                  <td>
                    <span className="tag">{actionLabel(approval.actionType)}</span>
                  </td>
                  <td>
                    {approval.targetType} <span className="mono">{approval.targetId}</span>
                  </td>
                  <td>
                    <StatusPill status={approval.status} tone={approvalTone(approval.status)} />
                  </td>
                  <td className="mono">{approval.requestedBy}</td>
                  <td className="muted">{toLocal(approval.createdAt)}</td>
                  <td>{approval.decidedBy ? <span className="mono">{approval.decidedBy}</span> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <ApprovalDrawer
          approval={selected}
          decisionError={decisionError}
          canDecide={canDecide}
          onDecide={(decision) => {
            setToast(null)
            setPromptError(null)
            setPrompt({ approval: selected, decision })
          }}
          onClose={() => {
            setSelected(null)
            setDecisionError(null)
          }}
        />
      )}

      {prompt && (
        <DecisionPrompt
          title={prompt.decision === 'approve' ? 'Approve request' : 'Reject request'}
          description={
            prompt.decision === 'approve'
              ? 'Approving executes the requested action.'
              : 'Rejecting blocks the requested action and closes the request.'
          }
          tone={prompt.decision === 'reject' ? 'danger' : 'default'}
          busy={busy}
          error={promptError}
          onSubmit={decide}
          onClose={() => setPrompt(null)}
        />
      )}

      {showCreate && (
        <CreateApprovalModal
          busy={busy}
          error={formError}
          onSubmit={createApproval}
          onClose={() => setShowCreate(false)}
        />
      )}
    </div>
  )
}

function ApprovalDrawer({
  approval,
  decisionError,
  canDecide,
  onDecide,
  onClose,
}: {
  approval: AdminTwoPersonApproval
  decisionError: string | null
  canDecide: boolean
  onDecide: (decision: Decision) => void
  onClose: () => void
}) {
  return (
    <DetailDrawer title={actionLabel(approval.actionType)} onClose={onClose}>
      <div className="detail-section">
        <h3>Request</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">ID</span>
            <span className="mono">{approval.id}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Action type</span>
            <span className="meta-value">
              <span className="tag">{actionLabel(approval.actionType)}</span>
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Target type</span>
            <span className="meta-value">{approval.targetType}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Target ID</span>
            <span className="mono">{approval.targetId}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Reason</span>
            <span className="meta-value">{approval.reason}</span>
          </div>
        </div>
        {approval.payload && (
          <div>
            <span className="meta-label">Payload</span>
            <pre className="mono small" style={{ whiteSpace: 'pre-wrap' }}>
              {JSON.stringify(approval.payload, null, 2)}
            </pre>
          </div>
        )}
      </div>

      <div className="detail-section">
        <h3>Status</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">Status</span>
            <span className="meta-value">
              <StatusPill status={approval.status} tone={approvalTone(approval.status)} />
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Requested by</span>
            <span className="mono">{approval.requestedBy}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Created</span>
            <span className="meta-value">{toLocal(approval.createdAt)}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Decided by</span>
            <span className="meta-value">
              {approval.decidedBy ? <span className="mono">{approval.decidedBy}</span> : '—'}
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Decision comment</span>
            <span className="meta-value">{approval.decisionComment ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Decided at</span>
            <span className="meta-value">{toLocal(approval.decidedAt)}</span>
          </div>
        </div>
      </div>

      {canDecide && approval.status === 'pending' && !decisionError && (
        <div className="form-actions">
          <button type="button" className="btn" onClick={() => onDecide('approve')}>
            Approve
          </button>
          <button type="button" className="btn btn-danger" onClick={() => onDecide('reject')}>
            Reject
          </button>
        </div>
      )}
      {decisionError && (
        <div className="inline-error" role="alert">
          {decisionError}
        </div>
      )}
    </DetailDrawer>
  )
}

/** Decision prompt — mirrors ReasonPrompt markup; collects a required comment. */
function DecisionPrompt({
  title,
  description,
  tone,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  title: string
  description?: string
  tone?: 'default' | 'danger'
  busy?: boolean
  error?: string | null
  onSubmit: (comment: string) => void
  onClose: () => void
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const comment = inputRef.current?.value.trim() ?? ''
    if (!comment) return
    onSubmit(comment)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="modal-title">{title}</h3>
        {description && <p className="muted small">{description}</p>}
        <label className="field-label" htmlFor="decision-comment">
          Comment
        </label>
        <textarea
          ref={inputRef}
          id="decision-comment"
          className="field"
          rows={3}
          maxLength={1000}
          required
          aria-required="true"
          placeholder="Explain why this decision is made (audited)"
        />
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={`btn${tone === 'danger' ? ' btn-danger' : ''}`} disabled={busy}>
            {busy ? 'Working…' : 'Confirm'}
          </button>
        </div>
      </form>
    </div>
  )
}

function CreateApprovalModal({
  busy,
  error,
  onSubmit,
  onClose,
}: {
  busy: boolean
  error: string | null
  onSubmit: (body: AdminCreateTwoPersonApprovalBody) => void
  onClose: () => void
}) {
  const actionRef = useRef<HTMLSelectElement>(null)
  const targetTypeRef = useRef<HTMLInputElement>(null)
  const targetIdRef = useRef<HTMLInputElement>(null)
  const reasonRef = useRef<HTMLTextAreaElement>(null)
  const payloadRef = useRef<HTMLTextAreaElement>(null)
  const [payloadError, setPayloadError] = useState<string | null>(null)

  useEffect(() => {
    actionRef.current?.focus()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setPayloadError(null)
    const actionType = actionRef.current?.value as AdminCreateTwoPersonApprovalBody['actionType']
    const targetType = targetTypeRef.current?.value.trim() ?? ''
    const targetId = targetIdRef.current?.value.trim() ?? ''
    const reason = reasonRef.current?.value.trim() ?? ''
    if (!actionType || !targetType || !targetId || !reason) return
    const rawPayload = payloadRef.current?.value.trim() ?? ''
    let payload: Record<string, unknown> | undefined
    if (rawPayload) {
      try {
        payload = JSON.parse(rawPayload) as Record<string, unknown>
      } catch {
        setPayloadError('Payload must be valid JSON')
        return
      }
    }
    const body: AdminCreateTwoPersonApprovalBody =
      payload === undefined ? { actionType, targetType, targetId, reason } : { actionType, targetType, targetId, reason, payload }
    onSubmit(body)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="New approval request"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="modal-title">New approval request</h3>
        <p className="muted small">Initiate a two-person approval for a dangerous action.</p>
        <div className="form-grid">
          <Field label="Action type">
            <select ref={actionRef} className="field" required aria-required="true" defaultValue="">
              <option value="" disabled>
                Select…
              </option>
              {ACTION_TYPES.map((actionType) => (
                <option key={actionType} value={actionType}>
                  {actionLabel(actionType)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Target type">
            <input
              ref={targetTypeRef}
              className="field"
              type="text"
              required
              aria-required="true"
              placeholder="e.g. order, merchant"
            />
          </Field>
          <Field label="Target ID">
            <input
              ref={targetIdRef}
              className="field"
              type="text"
              required
              aria-required="true"
              placeholder="ID of the affected record"
            />
          </Field>
          <Field label="Reason">
            <textarea
              ref={reasonRef}
              className="field"
              rows={3}
              maxLength={1000}
              required
              aria-required="true"
              placeholder="Explain why this action is needed (audited)"
            />
          </Field>
          <Field label="Payload (JSON)">
            <textarea ref={payloadRef} className="field" rows={5} placeholder='{"amountTZS": 500000}' />
          </Field>
        </div>
        {(error || payloadError) && (
          <div className="inline-error" role="alert">
            {payloadError ?? error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Working…' : 'Create request'}
          </button>
        </div>
      </form>
    </div>
  )
}
