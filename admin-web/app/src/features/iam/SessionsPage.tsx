import { useEffect, useState } from 'react'
import { listMySessions, revokeSession, type SessionInfo } from '@hudumika/contract'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { InlineError, Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { MaskedField } from '../../components/MaskedField'
import { StatusPill } from '../../components/StatusPill'
import { parseApiError } from '../../lib/api-error'
import { toLocal } from '../../lib/time'

type SessionRow = SessionInfo & { ip?: string | null; createdAt?: string | null }

const ID_MAX = 12

function truncate(text: string, max = ID_MAX): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function SessionsPage() {
  const [rows, setRows] = useState<SessionRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [requestId, setRequestId] = useState<string | undefined>(undefined)
  const [retryKey, setRetryKey] = useState(0)
  const [pending, setPending] = useState<SessionRow | null>(null)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
    setRequestId(undefined)
    listMySessions().then((res) => {
      if (res.status === 200) setRows(res.data)
      else {
        const err = parseApiError(res, 'Failed to load sessions')
        setError(err.message)
        setRequestId(err.requestId)
      }
    })
  }, [retryKey])

  function confirmRevoke() {
    if (!pending) return
    setBusy(true)
    revokeSession(pending.id).then((res) => {
      if (res.status === 204) {
        setPending(null)
        setToast('Session revoked')
        setRetryKey((k) => k + 1)
      } else {
        setPending(null)
        setRevokeError(parseApiError(res, 'Could not revoke session').message)
      }
      setBusy(false)
    })
  }

  if (error) {
    return (
      <ErrorState
        title="Failed to load sessions"
        message={error}
        requestId={requestId}
        onRetry={() => setRetryKey((k) => k + 1)}
      />
    )
  }
  if (!rows) return <LoadingSkeleton kind="table" />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>My sessions</h1>
      </div>

      {toast && <Toast message={toast} />}
      {revokeError && <InlineError message={revokeError} />}

      {rows.length === 0 ? (
        <EmptyState title="No active sessions" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Session ID</th>
                <th>Device</th>
                <th>IP</th>
                <th>Created</th>
                <th>Last active</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <span className="mono" title={row.id}>
                      {truncate(row.id)}
                    </span>
                  </td>
                  <td>{row.deviceInfo.trim() ? row.deviceInfo : '—'}</td>
                  <td>
                    <MaskedField value={row.ip} permission="audit.unmask" label="IP address" />
                  </td>
                  <td className="muted">{toLocal(row.createdAt)}</td>
                  <td className="muted">{toLocal(row.lastActiveAt)}</td>
                  <td>
                    {row.current ? <StatusPill status="Current" tone="ok" /> : <span className="muted">—</span>}
                  </td>
                  <td>
                    {row.current ? (
                      <span className="muted">—</span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-danger"
                        onClick={() => {
                          setPending(row)
                          setRevokeError(null)
                          setToast(null)
                        }}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="state-card">
        <p className="muted small">
          MFA is enforced at sign-in (OTP). Session policy: 20-minute idle timeout; re-auth required on new devices or
          IPs (server-enforced when the backend ships staff session policy).
        </p>
        <p className="muted small">Suspicious devices should be revoked immediately — revocation is audited.</p>
      </div>

      {pending && (
        <ConfirmDialog
          title="Revoke session"
          description="The device will be signed out immediately."
          confirmLabel="Revoke"
          tone="danger"
          busy={busy}
          onConfirm={confirmRevoke}
          onClose={() => {
            if (!busy) setPending(null)
          }}
        />
      )}
    </div>
  )
}
