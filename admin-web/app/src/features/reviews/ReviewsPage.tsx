import { useState, type FormEvent } from 'react'
import { adminModerateReview, type AdminModerateReviewBodyAction, type Review, type ReviewState } from '@hudumika/contract'
import { InlineError, Toast } from '../../components/FormBits'
import { ReasonPrompt } from '../../components/ReasonPrompt'
import { StatusPill } from '../../components/StatusPill'
import { parseApiError } from '../../lib/api-error'
import { toLocal } from '../../lib/time'
import { useSession } from '../../lib/session'
import { can } from '../../lib/permissions'

type ModerateAction = AdminModerateReviewBodyAction

interface HistoryEntry {
  id: string
  action: ModerateAction
  reason: string
  at: string
}

const PROMPT_DESCRIPTION: Record<ModerateAction, string> = {
  publish: 'Publish the review so it is visible to customers.',
  hide: 'Hide the review from public display.',
  delete: 'Delete the review permanently — this cannot be undone.',
}

const PAST_TENSE: Record<ModerateAction, string> = {
  publish: 'published',
  hide: 'hidden',
  delete: 'deleted',
}

function actionTone(action: ModerateAction): 'ok' | 'warn' | 'bad' {
  if (action === 'publish') return 'ok'
  if (action === 'hide') return 'warn'
  return 'bad'
}

function stateTone(state: ReviewState): 'ok' | 'warn' | 'bad' | 'muted' {
  if (state === 'published') return 'ok'
  if (state === 'hidden') return 'warn'
  if (state === 'deleted') return 'bad'
  return 'muted'
}

/**
 * Reviews & moderation. There is no admin reviews-list endpoint in the
 * contract — moderation is keyed by review ID from disputes, orders, or
 * reports, so this page is a lookup-driven moderation tool.
 */
export function ReviewsPage() {
  const [query, setQuery] = useState('')
  const [reviewId, setReviewId] = useState<string | null>(null)
  const [promptAction, setPromptAction] = useState<ModerateAction | null>(null)
  const [busy, setBusy] = useState(false)
  const [promptError, setPromptError] = useState<string | null>(null)
  const [panelError, setPanelError] = useState<string | null>(null)
  const [result, setResult] = useState<Review | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])

  const session = useSession()
  const allowed = can(session, 'review.moderate')

  if (!allowed) {
    return (
      <div className="page">
        <div className="page-title-row">
          <h1>Reviews &amp; Moderation</h1>
        </div>
        <p className="muted small">Review moderation requires review.moderate</p>
      </div>
    )
  }

  function handleLookup(e: FormEvent) {
    e.preventDefault()
    const id = query.trim()
    if (!id) return
    setReviewId(id)
    setResult(null)
    setPanelError(null)
    setToast(null)
  }

  function openPrompt(action: ModerateAction) {
    setPromptError(null)
    setPanelError(null)
    setToast(null)
    setPromptAction(action)
  }

  async function moderate(reason: string) {
    if (!reviewId || !promptAction) return
    const action = promptAction
    setBusy(true)
    setPromptError(null)
    const res = await adminModerateReview({ reviewId, action, reason })
    if (res.status === 200) {
      setResult(res.data)
      setHistory((prev) => [...prev, { id: reviewId, action, reason, at: new Date().toISOString() }])
      setToast(`Review ${reviewId} ${PAST_TENSE[action]}`)
      setPromptAction(null)
    } else {
      setPanelError(parseApiError(res).message)
      setPromptAction(null)
    }
    setBusy(false)
  }

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Reviews &amp; Moderation</h1>
        {toast && (
          <div className="page-actions">
            <Toast message={toast} />
          </div>
        )}
      </div>

      {!reviewId ? (
        <div className="state-card">
          <div className="state-title">Review moderation is keyed by review ID</div>
          <div className="state-message">Open the review from a dispute, order, or report.</div>
          <form className="toolbar" aria-label="Review ID lookup" onSubmit={handleLookup}>
            <label className="field-label" htmlFor="review-id">
              Review ID
            </label>
            <input
              id="review-id"
              className="field"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="rev_…"
              autoComplete="off"
            />
            <button type="submit" className="btn" aria-label="Look up review" disabled={!query.trim()}>
              Look up
            </button>
          </form>
        </div>
      ) : (
        <div className="state-card">
          <div className="state-title">Moderate review</div>
          <p className="muted small">
            Review ID: <span className="mono">{reviewId}</span>
          </p>
          {panelError && <InlineError message={panelError} />}
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => openPrompt('publish')}>
              Publish
            </button>
            <button type="button" className="btn" onClick={() => openPrompt('hide')}>
              Hide
            </button>
            <button type="button" className="btn btn-danger" onClick={() => openPrompt('delete')}>
              Delete
            </button>
          </div>

          {result && (
            <div className="meta-grid">
              <div className="meta-item">
                <span className="meta-label">State</span>
                <span className="meta-value">
                  <StatusPill status={result.state} tone={stateTone(result.state)} />
                </span>
              </div>
              <div className="meta-item">
                <span className="meta-label">Rating</span>
                <span className="meta-value mono">rating {result.rating} / 5</span>
              </div>
              <div className="meta-item">
                <span className="meta-label">Author</span>
                <span className="meta-value">{result.authorName ?? '—'}</span>
              </div>
              <div className="meta-item">
                <span className="meta-label">Target</span>
                <span className="meta-value mono">{result.targetId}</span>
              </div>
              <div className="meta-item">
                <span className="meta-label">Created</span>
                <span className="meta-value muted">{toLocal(result.createdAt)}</span>
              </div>
              <div className="meta-item">
                <span className="meta-label">Body</span>
                <span className="meta-value">{result.body ?? '—'}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {history.length > 0 && (
        <div>
          <h3>Session history</h3>
          <p className="muted small">Session only — the authoritative audit trail is in Audit Logs.</p>
          <div className="queue-list">
            {history.map((h, i) => (
              <div key={i} className="queue-item">
                <div className="queue-main">
                  <div>
                    <span className="mono">{h.id}</span> <StatusPill status={h.action} tone={actionTone(h.action)} />
                  </div>
                  <div className="muted small">{toLocal(h.at)}</div>
                  <div className="small">{h.reason}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {promptAction && (
        <ReasonPrompt
          title="Moderate review"
          description={PROMPT_DESCRIPTION[promptAction]}
          maxLength={1000}
          tone={promptAction === 'delete' ? 'danger' : 'default'}
          busy={busy}
          error={promptError}
          onSubmit={moderate}
          onClose={() => setPromptAction(null)}
        />
      )}
    </div>
  )
}
