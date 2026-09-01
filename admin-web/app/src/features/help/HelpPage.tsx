import { useState, useEffect, type FormEvent } from 'react'
import {
  adminBroadcastNotification,
  adminCreateHelpArticle,
  adminUpdateHelpArticle,
  adminListScheduledNotifications,
  adminCancelScheduledNotification,
  type AdminBroadcastNotification202,
  type AdminBroadcastNotificationBody,
  type AdminCreateHelpArticle201,
  type AdminScheduledNotification,
} from '@hudumika/contract'
import { Field, InlineError, Toast } from '../../components/FormBits'
import { parseApiError } from '../../lib/api-error'

type Tab = 'articles' | 'broadcast' | 'scheduled'

export function HelpPage() {
  const [tab, setTab] = useState<Tab>('articles')

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Content ops</h1>
      </div>
      <div className="tabs">
        <button
          type="button"
          className={`tab${tab === 'articles' ? ' active' : ''}`}
          onClick={() => setTab('articles')}
        >
          Help articles
        </button>
        <button
          type="button"
          className={`tab${tab === 'broadcast' ? ' active' : ''}`}
          onClick={() => setTab('broadcast')}
        >
          Broadcast
        </button>
        <button
          type="button"
          className={`tab${tab === 'scheduled' ? ' active' : ''}`}
          onClick={() => setTab('scheduled')}
        >
          Scheduled
        </button>
      </div>
      {tab === 'articles' ? <HelpArticles /> : tab === 'broadcast' ? <BroadcastNotifications /> : <ScheduledNotifications />}
    </div>
  )
}

function HelpArticles() {
  const [articleId, setArticleId] = useState('')
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState('')
  const [body, setBody] = useState('')
  const [published, setPublished] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [saved, setSaved] = useState<AdminCreateHelpArticle201 | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setToast(null)
    if (!title.trim()) {
      setError('Title is required')
      return
    }
    if (!category.trim()) {
      setError('Category is required')
      return
    }
    if (!body.trim()) {
      setError('Body is required')
      return
    }
    setSaving(true)
    try {
      if (articleId.trim()) {
        const res = await adminUpdateHelpArticle({
          id: articleId.trim(),
          title: title.trim(),
          category: category.trim(),
          body: body.trim(),
          published,
        })
        if (res.status === 200) {
          setSaved(res.data)
          setToast(`Article updated — ${res.data.id}`)
        } else {
          setError(parseApiError(res, 'Failed to update article').message)
        }
      } else {
        const res = await adminCreateHelpArticle({
          title: title.trim(),
          category: category.trim(),
          body: body.trim(),
          published,
        })
        if (res.status === 201) {
          setSaved(res.data)
          setToast(`Article created — ${res.data.id}`)
        } else {
          setError(parseApiError(res, 'Failed to create article').message)
        }
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="state-card">
        <div className="state-title">Help article tool</div>
        <div className="state-message">
          The admin API has no help-article listing endpoint yet, so this tab is a create/update
          tool. Leave the article ID blank to create a new article, or fill it in to update an
          existing one.
        </div>
      </div>

      {toast && <Toast message={toast} />}

      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Article ID (optional)">
            <input
              className="field"
              value={articleId}
              onChange={(e) => setArticleId(e.target.value)}
              placeholder="art_… blank creates a new article"
            />
          </Field>
          <Field label="Category">
            <input
              className="field"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="e.g. Account, Orders, Payments"
            />
          </Field>
        </div>
        <Field label="Title">
          <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Body">
          <textarea className="field" rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <Field label="Published">
          <input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} />
        </Field>
        {error && <InlineError message={error} />}
        <div className="form-actions">
          <button type="submit" className="btn" disabled={saving}>
            {saving ? 'Saving…' : 'Save article'}
          </button>
        </div>
      </form>

      {saved && (
        <div className="state-card">
          <div className="state-title">{articleId.trim() ? 'Article updated' : 'Article created'}</div>
          <div className="meta-grid">
            <div className="meta-item">
              <span className="meta-label">Article ID</span>
              <span className="meta-value mono">{saved.id}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Title</span>
              <span className="meta-value">{saved.title}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Category</span>
              <span className="meta-value">{saved.category}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function BroadcastNotifications() {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [roles, setRoles] = useState('')
  const [cityIds, setCityIds] = useState('')
  const [scheduledAt, setScheduledAt] = useState('')
  const [deepLink, setDeepLink] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<AdminBroadcastNotification202 | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!title.trim()) {
      setError('Title is required')
      return
    }
    if (!body.trim()) {
      setError('Body is required')
      return
    }
    setSending(true)
    try {
      const roleList = splitList(roles)
      const cityList = splitList(cityIds)
      const audience: NonNullable<AdminBroadcastNotificationBody['audience']> = {}
      if (roleList.length) audience.roles = roleList as NonNullable<AdminBroadcastNotificationBody['audience']>['roles']
      if (cityList.length) audience.cityIds = cityList
      const payload: AdminBroadcastNotificationBody = {
        title: title.trim(),
        body: body.trim(),
        audience: audience.roles || audience.cityIds ? audience : undefined,
        scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
        deepLink: deepLink.trim() ? deepLink.trim() : undefined,
      }
      const res = await adminBroadcastNotification(payload)
      if (res.status === 202) {
        setSent(res.data)
      } else {
        setError(parseApiError(res, 'Failed to send broadcast').message)
      }
    } finally {
      setSending(false)
    }
  }

  return (
    <div>
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Title">
            <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Audience roles" hint="Comma-separated roles: customer, merchant, provider, rider">
            <input className="field" value={roles} onChange={(e) => setRoles(e.target.value)} />
          </Field>
          <Field label="City IDs" hint="Comma-separated city IDs">
            <input className="field" value={cityIds} onChange={(e) => setCityIds(e.target.value)} />
          </Field>
          <Field label="Schedule" hint="Leave blank to send immediately">
            <input
              type="datetime-local"
              className="field"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
            />
          </Field>
          <Field label="Deep link">
            <input className="field" value={deepLink} onChange={(e) => setDeepLink(e.target.value)} />
          </Field>
        </div>
        <Field label="Body">
          <textarea className="field" rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        {error && <InlineError message={error} />}
        <div className="form-actions">
          <button type="submit" className="btn" disabled={sending}>
            {sending ? 'Sending…' : 'Send broadcast'}
          </button>
        </div>
        <p className="muted small">
          Broadcasts are permissioned (admin.broadcast) and audited (content.*).
        </p>
      </form>

      {sent && (
        <div className="state-card">
          <div className="state-title">Broadcast queued</div>
          <div className="meta-grid">
            <div className="meta-item">
              <span className="meta-label">Campaign ID</span>
              <span className="meta-value mono">{sent.campaignId}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Estimated recipients</span>
              <span className="meta-value">{formatCount(sent.estimatedRecipients)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function formatCount(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function ScheduledNotifications() {
  const [notifications, setNotifications] = useState<AdminScheduledNotification[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    adminListScheduledNotifications({}).then((res) => {
      if (res.status === 200) setNotifications(res.data)
      else setError('Failed to load scheduled notifications')
    })
  }, [])

  async function handleCancel(id: string) {
    const res = await adminCancelScheduledNotification(id, { reason: 'Cancelled by admin' })
    if (res.status === 200) {
      setToast('Notification cancelled')
      setNotifications((prev) => (prev ?? []).filter((n) => n.id !== id))
    }
  }

  return (
    <div>
      <h2>Scheduled notifications</h2>
      {toast && <Toast message={toast} />}
      {error && <InlineError message={error} />}
      {!notifications && !error && <p className="muted small">Loading…</p>}
      {notifications && notifications.length === 0 && <p className="muted small">No scheduled notifications.</p>}
      {notifications && notifications.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Audience</th>
                <th>Scheduled</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {notifications.map((n) => (
                <tr key={n.id}>
                  <td className="strong">{n.title}</td>
                  <td>{String(n.audience)}</td>
                  <td className="muted">{n.scheduledAt ? new Date(n.scheduledAt).toLocaleString() : '—'}</td>
                  <td>{String(n.status)}</td>
                  <td>
                    {String(n.status) === 'pending' && (
                      <button type="button" className="btn btn-ghost" onClick={() => handleCancel(n.id)}>Cancel</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
