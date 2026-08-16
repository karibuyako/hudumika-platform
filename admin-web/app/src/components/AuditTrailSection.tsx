import { useEffect, useState } from 'react'
import { adminListAuditLogs, type AuditLog } from '@hudumika/contract'
import { LoadingSkeleton } from './LoadingSkeleton'
import { parseApiError } from '../lib/api-error'
import { toLocal } from '../lib/time'

export function AuditTrailSection({
  entityType,
  entityId,
  label,
}: {
  entityType: string
  entityId: string
  label: string
}) {
  const [entries, setEntries] = useState<AuditLog[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    setError(null)
    setEntries(null)
    adminListAuditLogs({ entityType, entityId, limit: 20 }).then((res) => {
      if (res.status === 200) setEntries(res.data)
      else setError(parseApiError(res, 'Failed to load audit trail').message)
    })
  }, [entityType, entityId, retryKey])

  const sorted = entries ? [...entries].sort((a, b) => b.at.localeCompare(a.at)) : []

  return (
    <div className="detail-section">
      <h3>{label}</h3>
      {error ? (
        <>
          <p className="muted small">Audit trail unavailable</p>
          <button type="button" className="btn" onClick={() => setRetryKey((k) => k + 1)}>
            Retry
          </button>
        </>
      ) : entries === null ? (
        <LoadingSkeleton kind="table" rows={3} />
      ) : sorted.length === 0 ? (
        <p className="muted small">No audit entries for this entity</p>
      ) : (
        <div className="timeline">
          {sorted.map((e) => (
            <div key={e.id} className="timeline-item">
              <div className="timeline-dot" />
              <div>
                <div className="strong">{e.action.replace(/_/g, ' ')}</div>
                <div className="muted small">
                  <span className="mono">{e.actorUserId}</span>
                  {e.actorRole ? <span> · {e.actorRole}</span> : null}
                </div>
                {e.details != null && <div className="muted small">{JSON.stringify(e.details).slice(0, 80)}</div>}
                <div className="muted small">
                  {e.ipAddress ? <span className="mono">{e.ipAddress}</span> : null}
                  {e.ipAddress && e.requestId ? ' · ' : null}
                  {e.requestId ? <span className="mono">{e.requestId}</span> : null}
                </div>
                <div className="muted small">{toLocal(e.at)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="muted small">Audit trail is immutable (audit.*).</p>
    </div>
  )
}
