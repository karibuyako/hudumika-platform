import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { adminListContent, adminCreateContent, adminUpdateContentState, type AdminContent } from '@hudumika/contract'
import { parseApiError } from '../../lib/api-error'
import { toLocal } from '../../lib/time'
import { DetailDrawer } from '../../components/DetailDrawer'
import { ErrorState } from '../../components/ErrorState'
import { EmptyState } from '../../components/EmptyState'
import { Field, InlineError, Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { StatusPill } from '../../components/StatusPill'
import { DataTable, type DataTableColumn } from '../../components/DataTable'

const STATE_TONE: Record<string, 'ok' | 'bad' | 'info' | 'muted'> = {
  published: 'ok', draft: 'info', review: 'warn' as never, archived: 'muted',
}

const COLUMNS: DataTableColumn<AdminContent>[] = [
  { key: 'title', header: 'Title', render: (c) => <span className="mono-strong">{c.title}</span> },
  { key: 'type', header: 'Type', render: (c) => <span className="tag">{c.type}</span> },
  { key: 'state', header: 'State', render: (c) => <StatusPill status={c.state} tone={STATE_TONE[c.state] ?? 'muted'} /> },
  { key: 'created', header: 'Created', render: (c) => toLocal(c.createdAt), className: 'muted' },
]

export function ContentEditorialPage() {
  const [contents, setContents] = useState<AdminContent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [selected, setSelected] = useState<AdminContent | null>(null)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    setContents([])
    adminListContent().then((res) => {
      if (res.status === 200) setContents(res.data)
      else setError(parseApiError(res, 'Failed to load content').message)
    })
  }, [])

  useEffect(() => {
    load()
  }, [load, retryKey])

  function handleCreate(e: FormEvent) {
    e.preventDefault()
    const form = e.target as HTMLFormElement
    const fd = new FormData(form)
    setBusy(true)
    setCreateError(null)
    adminCreateContent({
      title: (fd.get('title') as string ?? '').trim(),
      body: (fd.get('body') as string ?? '').trim(),
      type: fd.get('type') as string as AdminContent['type'],
    }).then((res) => {
      if (res.status === 201) {
        setCreating(false)
        setToast('Content draft created')
        setContents((prev) => [...prev, res.data])
      } else {
        setCreateError(parseApiError(res, 'Create failed').message)
      }
      setBusy(false)
    })
  }

  async function advanceState(contentId: string, newState: AdminContent['state'], reason: string) {
    const res = await adminUpdateContentState(contentId, { state: newState, reason })
    if (res.status === 200) {
      setContents((prev) => prev.map((c) => (c.id === contentId ? res.data : c)))
      setToast(`Content moved to ${newState}`)
      setSelected(null)
    }
    return parseApiError(res, 'State update failed')
  }

  if (error) return <ErrorState title="Failed to load content" message={error} onRetry={() => setRetryKey((k) => k + 1)} />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>CMS editorial</h1>
        <div className="page-actions">
          {toast && <Toast message={toast} />}
          <button type="button" className="btn" onClick={() => setCreating(true)}>New draft</button>
        </div>
      </div>
      <p className="muted small">Create and manage CMS content through the editorial workflow: draft → review → publish.</p>

      {contents.length === 0 ? (
        <EmptyState title="No content yet" hint="Create a draft to get started." />
      ) : (
        <DataTable rows={contents} columns={COLUMNS} rowKey={(c) => c.id} onRowClick={setSelected} emptyTitle="No content" tableId="content-editorial" ariaLabel="Content editorial" />
      )}

      {selected && (
        <DetailDrawer title={selected.title} onClose={() => setSelected(null)}>
          <div className="meta-grid">
            <div className="meta-item"><span className="meta-label">ID</span><span className="meta-value mono">{selected.id}</span></div>
            <div className="meta-item"><span className="meta-label">Type</span><span className="meta-value">{selected.type}</span></div>
            <div className="meta-item"><span className="meta-label">State</span><span className="meta-value"><StatusPill status={selected.state} tone={STATE_TONE[selected.state] ?? 'muted'} /></span></div>
            <div className="meta-item"><span className="meta-label">Created</span><span className="meta-value">{toLocal(selected.createdAt)}</span></div>
          </div>
          <div className="detail-section">
            <h3>Body</h3>
            <div className="muted small" style={{ whiteSpace: 'pre-wrap' }}>{selected.body}</div>
          </div>
          <div className="detail-section">
            <h3>Workflow</h3>
            {selected.state === 'draft' && <button type="button" className="btn" onClick={() => advanceState(selected.id, 'review', 'Submitting for review')}>Submit for review</button>}
            {selected.state === 'review' && <button type="button" className="btn" onClick={() => advanceState(selected.id, 'published', 'Publishing content')}>Publish</button>}
            {selected.state === 'published' && <button type="button" className="btn btn-danger" onClick={() => advanceState(selected.id, 'archived', 'Archiving content')}>Archive</button>}
          </div>
        </DetailDrawer>
      )}

      {creating && (
        <div className="modal-backdrop" onClick={() => !busy && setCreating(false)}>
          <form className="modal" role="dialog" aria-modal="true" aria-label="New content" onClick={(e) => e.stopPropagation()} onSubmit={handleCreate}>
            <h3 className="modal-title">New content draft</h3>
            <Field label="Title"><input name="title" className="field" required maxLength={200} /></Field>
            <Field label="Type">
              <select name="type" className="field">
                <option value="article">Article</option>
                <option value="page">Page</option>
                <option value="faq">FAQ</option>
                <option value="announcement">Announcement</option>
              </select>
            </Field>
            <Field label="Body"><textarea name="body" className="field" rows={8} required placeholder="Write content here…" /></Field>
            {createError && <InlineError message={createError} />}
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setCreating(false)} disabled={busy}>Cancel</button>
              <button type="submit" className="btn" disabled={busy}>{busy ? 'Creating…' : 'Create'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
