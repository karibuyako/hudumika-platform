import { useEffect, useState } from 'react'
import {
  VerificationState,
  adminListRiders,
  adminRiderCodReconciliation,
  type AdminRiderCodReconciliationParams,
  type RiderAdmin,
  type RiderCodReconciliation,
  type RiderCodReconciliationShiftsItem,
  type RiderCodReconciliationShiftsItemStatus,
} from '@hudumika/contract'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { ReasonPrompt } from '../../components/ReasonPrompt'
import { StatusPill } from '../../components/StatusPill'
import { parseApiError, type ApiErrorInfo } from '../../lib/api-error'
import { formatTZS } from '../../lib/money'
import { PENDING_ENDPOINT_CODE, pendingEndpointNotice } from '../../lib/pending-endpoints'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'
import { toLocal } from '../../lib/time'

type DateRange = { from: string; to: string }

const EMPTY_RANGE: DateRange = { from: '', to: '' }

const UNDECIDED: RiderCodReconciliationShiftsItemStatus[] = ['pending', 'mismatch']

type ShiftDecision = { shift: RiderCodReconciliationShiftsItem; decision: 'reconciled' | 'mismatch' }

function toParams(range: DateRange): AdminRiderCodReconciliationParams {
  const params: AdminRiderCodReconciliationParams = {}
  if (range.from) params.from = new Date(`${range.from}T00:00:00`).toISOString()
  if (range.to) params.to = new Date(`${range.to}T23:59:59`).toISOString()
  return params
}

export function CodReconciliationPage() {
  const session = useSession()
  const canDecide = can(session, 'cod.reconcile')
  const [riders, setRiders] = useState<RiderAdmin[] | null>(null)
  const [pickerError, setPickerError] = useState<ApiErrorInfo | null>(null)
  const [pickerRetryKey, setPickerRetryKey] = useState(0)

  const [riderId, setRiderId] = useState('')
  const [filters, setFilters] = useState<DateRange>(EMPTY_RANGE)
  const [applied, setApplied] = useState<DateRange>(EMPTY_RANGE)

  const [cod, setCod] = useState<RiderCodReconciliation | null>(null)
  const [codError, setCodError] = useState<ApiErrorInfo | null>(null)
  const [codRetryKey, setCodRetryKey] = useState(0)

  const [shiftDecision, setShiftDecision] = useState<ShiftDecision | null>(null)
  const [pendingDecision, setPendingDecision] = useState<ShiftDecision | null>(null)

  useEffect(() => {
    setPickerError(null)
    adminListRiders().then((res) => {
      if (res.status === 200) setRiders(res.data)
      else setPickerError(parseApiError(res, 'Failed to load riders'))
    })
  }, [pickerRetryKey])

  useEffect(() => {
    if (!riderId) return
    setCodError(null)
    setCod(null)
    adminRiderCodReconciliation(riderId, toParams(applied)).then((res) => {
      if (res.status === 200) setCod(res.data)
      else {
        const err = parseApiError(res, 'Failed to load reconciliation')
        if (err.code === 'COD_RECONCILIATION_UNAVAILABLE') {
          setCod({ riderId, shifts: [], from: null, to: null })
        } else {
          setCodError(err)
        }
      }
    })
  }, [riderId, applied, codRetryKey])

  const approved = (riders ?? []).filter((r) => r.verification === 'approved')
  const selectedRider = riders?.find((r) => r.id === riderId) ?? null

  if (pickerError) {
    return (
      <ErrorState
        title="Failed to load riders"
        message={pickerError.message}
        requestId={pickerError.requestId}
        onRetry={() => setPickerRetryKey((k) => k + 1)}
      />
    )
  }
  if (!riders) return <LoadingSkeleton kind="table" />
  if (approved.length === 0) {
    return (
      <div className="page">
        <div className="page-title-row">
          <h1>COD Reconciliation</h1>
        </div>
        <EmptyState title="No riders available" hint="Approved riders appear here once they complete onboarding." />
      </div>
    )
  }

  const mismatchCount = (cod?.shifts ?? []).filter((s) => s.status === 'mismatch').length
  const totals = cod?.totals
  const totalVariance =
    totals?.varianceTZS ??
    (totals?.expectedTZS != null && totals?.collectedTZS != null ? totals.expectedTZS - totals.collectedTZS : undefined)

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>COD Reconciliation</h1>
      </div>
      <p className="muted small">Compare expected vs collected cash on delivery per rider shift.</p>

      <div className="toolbar">
        <label className="field-label">
          Rider
          <select
            className="field"
            aria-label="Rider"
            value={riderId}
            onChange={(e) => setRiderId(e.target.value)}
          >
            <option value="">Select a rider</option>
            {approved.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {r.city} · {r.id}
              </option>
            ))}
          </select>
        </label>
        {selectedRider && (
          <span className="muted small">
            <StatusPill status={selectedRider.verification} tone={verificationTone(selectedRider.verification)} />{' '}
            Reliability {selectedRider.reliabilityScore ?? '—'}
          </span>
        )}
        <label className="field-label">
          From
          <input
            type="date"
            className="field"
            aria-label="From date"
            value={filters.from}
            onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
          />
        </label>
        <label className="field-label">
          To
          <input
            type="date"
            className="field"
            aria-label="To date"
            value={filters.to}
            onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
          />
        </label>
        <button className="btn" type="button" onClick={() => setApplied({ ...filters })}>
          Apply range
        </button>
      </div>

      {codError && (
        <ErrorState
          title="Failed to load reconciliation"
          message={codError.message}
          requestId={codError.requestId}
          onRetry={() => setCodRetryKey((k) => k + 1)}
        />
      )}

      {riderId && !cod && !codError && <LoadingSkeleton kind="table" />}

      {cod && cod.shifts.length === 0 && (
        <EmptyState
          title="No shifts in this range"
          hint="COD reconciliation data is unavailable for the selected rider and range"
        />
      )}

      {cod && cod.shifts.length > 0 && (
        <>
          {cod.from && cod.to && (
            <p className="muted small">
              Showing {toLocal(cod.from)} → {toLocal(cod.to)}
            </p>
          )}
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Shift</th>
                  <th>Date</th>
                  <th>Expected</th>
                  <th>Collected</th>
                  <th>Variance</th>
                  <th>Status</th>
                  <th>Note</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {cod.shifts.map((s) => (
                  <tr key={s.shiftId}>
                    <td className="mono">{s.shiftId}</td>
                    <td>{toLocal(s.date)}</td>
                    <td>{formatTZS(s.expectedTZS)}</td>
                    <td>{formatTZS(s.collectedTZS)}</td>
                    <td>{formatTZS(s.expectedTZS - s.collectedTZS)}</td>
                    <td>
                      <StatusPill status={s.status} tone={shiftTone(s.status)} />
                    </td>
                    <td className="muted">{s.note ?? '—'}</td>
                    <td>
                      {UNDECIDED.includes(s.status) && canDecide && (
                        <div className="queue-actions">
                          <button
                            type="button"
                            className="btn"
                            onClick={() => {
                              setPendingDecision(null)
                              setShiftDecision({ shift: s, decision: 'reconciled' })
                            }}
                          >
                            Mark reconciled
                          </button>
                          <button
                            type="button"
                            className="btn btn-danger"
                            onClick={() => {
                              setPendingDecision(null)
                              setShiftDecision({ shift: s, decision: 'mismatch' })
                            }}
                          >
                            Flag mismatch
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {totals && (
                  <tr className="row-total">
                    <td colSpan={2}>Totals</td>
                    <td>{formatTZS(totals.expectedTZS)}</td>
                    <td>{formatTZS(totals.collectedTZS)}</td>
                    <td>{formatTZS(totalVariance)}</td>
                    <td colSpan={2} className="muted small">
                      variance = expected − collected
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {mismatchCount > 0 && (
            <p className="muted">
              {mismatchCount} mismatched shift(s) flagged for finance follow-up
            </p>
          )}

          {pendingDecision && (
            <div className="state-card">
              <div className="state-title">
                <span className="mono">{PENDING_ENDPOINT_CODE}</span>
              </div>
              <div className="state-message">{pendingEndpointNotice('cod_decision')}</div>
              <p className="muted small">This action is documented for backend implementation — nothing was sent.</p>
            </div>
          )}

          <p className="muted small">
            Reconciliation decisions are finance actions (cod.* audit); decision endpoints ship with the backend
            milestone — this view is read-only. Decision endpoints are documented for backend implementation.
          </p>
        </>
      )}

      {shiftDecision && (
        <ReasonPrompt
          title={shiftDecision.decision === 'reconciled' ? 'Mark shift reconciled' : 'Flag shift mismatch'}
          description={`Shift ${shiftDecision.shift.shiftId} — expected ${formatTZS(shiftDecision.shift.expectedTZS)}, collected ${formatTZS(shiftDecision.shift.collectedTZS)}.`}
          confirmLabel="Confirm"
          onSubmit={() => {
            setPendingDecision(shiftDecision)
            setShiftDecision(null)
          }}
          onClose={() => setShiftDecision(null)}
        />
      )}
    </div>
  )
}

function shiftTone(status: RiderCodReconciliationShiftsItemStatus): 'ok' | 'warn' | 'bad' {
  if (status === 'reconciled') return 'ok'
  if (status === 'pending') return 'warn'
  return 'bad'
}

function verificationTone(verification: VerificationState): 'ok' | 'bad' | 'warn' {
  if (verification === 'approved') return 'ok'
  if (verification === 'rejected' || verification === 'suspended') return 'bad'
  return 'warn'
}
