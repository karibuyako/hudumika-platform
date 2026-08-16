import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  adminCreateBanner,
  adminDeleteBanner,
  adminListBanners,
  adminListTemplates,
  adminUpdateBanner,
  adminUpsertTemplate,
  AdminBannerPlacement as PlacementConst,
  AdminTemplateChannel as ChannelConst,
  type AdminBanner,
  type AdminBannerPlacement,
  type AdminTemplate,
  type AdminTemplateChannel,
} from '@hudumika/contract'
import { parseApiError } from '../../lib/api-error'
import { toLocal } from '../../lib/time'
import { useSession } from '../../lib/session'
import { can } from '../../lib/permissions'
import { DetailDrawer } from '../../components/DetailDrawer'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { FilterChips } from '../../components/FilterChips'
import { Field, InlineError, Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { ReasonPrompt } from '../../components/ReasonPrompt'
import { StatusPill } from '../../components/StatusPill'
import { useRefetchOnFocus } from '../../lib/use-refetch-on-focus'

type TabKey = 'banners' | 'templates'
type PlacementFilter = 'all' | AdminBannerPlacement
type ChannelFilter = 'all' | AdminTemplateChannel

const PLACEMENTS = Object.values(PlacementConst)
const CHANNELS = Object.values(ChannelConst)

const PLACEMENT_OPTIONS: Array<{ key: PlacementFilter; label: string }> = [
  { key: 'all', label: 'All' },
  ...PLACEMENTS.map((p) => ({ key: p as PlacementFilter, label: p })),
]

const CHANNEL_OPTIONS: Array<{ key: ChannelFilter; label: string }> = [
  { key: 'all', label: 'All' },
  ...CHANNELS.map((c) => ({ key: c as ChannelFilter, label: c })),
]

interface BannerForm {
  id: string
  title: string
  placement: AdminBannerPlacement
  description: string
  link: string
  active: boolean
  scheduledFrom: string
  scheduledTo: string
}

interface TemplateForm {
  key: string
  channel: AdminTemplateChannel
  subject: string
  body: string
  active: boolean
}

function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function toBannerForm(banner: AdminBanner | null): BannerForm {
  return banner
    ? {
        id: banner.id,
        title: banner.title,
        placement: banner.placement,
        description: banner.description ?? '',
        link: banner.link ?? '',
        active: banner.active ?? false,
        scheduledFrom: toLocalInput(banner.scheduledFrom),
        scheduledTo: toLocalInput(banner.scheduledTo),
      }
    : {
        id: '',
        title: '',
        placement: 'home_top',
        description: '',
        link: '',
        active: true,
        scheduledFrom: '',
        scheduledTo: '',
      }
}

function toBannerPayload(form: BannerForm): AdminBanner {
  return {
    id: form.id,
    title: form.title.trim(),
    placement: form.placement,
    ...(form.description.trim() ? { description: form.description.trim() } : {}),
    ...(form.link.trim() ? { link: form.link.trim() } : {}),
    active: form.active,
    ...(form.scheduledFrom ? { scheduledFrom: new Date(form.scheduledFrom).toISOString() } : {}),
    ...(form.scheduledTo ? { scheduledTo: new Date(form.scheduledTo).toISOString() } : {}),
  }
}

export function ContentPage() {
  const [tab, setTab] = useState<TabKey>('banners')

  const [banners, setBanners] = useState<AdminBanner[] | null>(null)
  const [bannersError, setBannersError] = useState<string | null>(null)
  const [bannersRetryKey, setBannersRetryKey] = useState(0)

  const [templates, setTemplates] = useState<AdminTemplate[] | null>(null)
  const [templatesError, setTemplatesError] = useState<string | null>(null)
  const [templatesRetryKey, setTemplatesRetryKey] = useState(0)

  const [placement, setPlacement] = useState<PlacementFilter>('all')
  const [channel, setChannel] = useState<ChannelFilter>('all')

  const [bannerModal, setBannerModal] = useState<{ banner: AdminBanner | null } | null>(null)
  const [bannerError, setBannerError] = useState<string | null>(null)
  const [bannerBusy, setBannerBusy] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<AdminBanner | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const [templateModalOpen, setTemplateModalOpen] = useState(false)
  const [templateError, setTemplateError] = useState<string | null>(null)
  const [templateBusy, setTemplateBusy] = useState(false)

  const [selectedTemplate, setSelectedTemplate] = useState<AdminTemplate | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const session = useSession()
  const allowed = can(session, 'configuration.edit')

  const loadBanners = useCallback(() => {
    setBannersError(null)
    adminListBanners().then((res) => {
      if (res.status === 200) setBanners(res.data)
      else setBannersError(parseApiError(res, 'Failed to load banners').message)
    })
  }, [])

  useEffect(() => {
    loadBanners()
  }, [loadBanners, bannersRetryKey])

  useRefetchOnFocus(loadBanners)

  useEffect(() => {
    if (tab !== 'templates') return
    setTemplatesError(null)
    adminListTemplates().then((res) => {
      if (res.status === 200) setTemplates(res.data)
      else setTemplatesError(parseApiError(res, 'Failed to load templates').message)
    })
  }, [tab, templatesRetryKey])

  const placementCounts = useMemo(() => {
    const map: Partial<Record<PlacementFilter, number>> = { all: banners?.length ?? 0 }
    for (const p of PLACEMENTS) map[p] = (banners ?? []).filter((b) => b.placement === p).length
    return map
  }, [banners])

  const channelCounts = useMemo(() => {
    const map: Partial<Record<ChannelFilter, number>> = { all: templates?.length ?? 0 }
    for (const c of CHANNELS) map[c] = (templates ?? []).filter((t) => t.channel === c).length
    return map
  }, [templates])

  const visibleBanners = useMemo(
    () => (banners ?? []).filter((b) => placement === 'all' || b.placement === placement),
    [banners, placement],
  )

  const visibleTemplates = useMemo(
    () => (templates ?? []).filter((t) => channel === 'all' || t.channel === channel),
    [templates, channel],
  )

  function submitBanner(form: BannerForm) {
    const editing = bannerModal?.banner ?? null
    setBannerBusy(true)
    setBannerError(null)
    const req = editing ? adminUpdateBanner(editing.id, toBannerPayload(form)) : adminCreateBanner(toBannerPayload(form))
    req.then((res) => {
      if (res.status === 200 || res.status === 201) {
        setBanners((prev) => {
          const list = prev ?? []
          const idx = list.findIndex((b) => b.id === res.data.id)
          return idx === -1 ? [...list, res.data] : list.map((b) => (b.id === res.data.id ? res.data : b))
        })
        setToast(editing ? 'Banner updated' : 'Banner created')
        setBannerModal(null)
        setBannersRetryKey((k) => k + 1)
      } else {
        setBannerError(parseApiError(res, 'Could not save banner').message)
      }
      setBannerBusy(false)
    })
  }

  function confirmDelete(_reason: string) {
    if (!deleteTarget) return
    setDeleteBusy(true)
    setDeleteError(null)
    adminDeleteBanner(deleteTarget.id).then((res) => {
      if (res.status === 204) {
        const removedId = deleteTarget.id
        setBanners((prev) => (prev ?? []).filter((b) => b.id !== removedId))
        setToast('Banner deleted')
        setDeleteTarget(null)
        setBannersRetryKey((k) => k + 1)
      } else {
        setDeleteError(parseApiError(res, 'Could not delete banner').message)
      }
      setDeleteBusy(false)
    })
  }

  function submitTemplate(form: TemplateForm) {
    setTemplateBusy(true)
    setTemplateError(null)
    const payload: AdminTemplate = {
      key: form.key.trim(),
      channel: form.channel,
      ...(form.subject.trim() ? { subject: form.subject.trim() } : {}),
      ...(form.body.trim() ? { body: form.body.trim() } : {}),
      active: form.active,
    }
    adminUpsertTemplate(payload).then((res) => {
      if (res.status === 200) {
        setTemplates((prev) => {
          const list = prev ?? []
          const idx = list.findIndex((t) => t.key === res.data.key)
          return idx === -1 ? [...list, res.data] : list.map((t) => (t.key === res.data.key ? res.data : t))
        })
        setToast('Template saved')
        setTemplateModalOpen(false)
        setTemplatesRetryKey((k) => k + 1)
      } else {
        setTemplateError(parseApiError(res, 'Could not save template').message)
      }
      setTemplateBusy(false)
    })
  }

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Content &amp; SEO</h1>
        {toast && (
          <div className="page-actions">
            <Toast message={toast} />
          </div>
        )}
      </div>

      {!allowed && <p className="muted small">Content edits require configuration.edit</p>}

      <div className="tabs" role="tablist" aria-label="Content sections">
        <button
          role="tab"
          aria-selected={tab === 'banners'}
          className={`tab${tab === 'banners' ? ' active' : ''}`}
          type="button"
          onClick={() => setTab('banners')}
        >
          Banners
        </button>
        <button
          role="tab"
          aria-selected={tab === 'templates'}
          className={`tab${tab === 'templates' ? ' active' : ''}`}
          type="button"
          onClick={() => setTab('templates')}
        >
          Templates
        </button>
      </div>

      {tab === 'banners' ? (
        bannersError ? (
          <ErrorState title="Failed to load banners" message={bannersError} onRetry={() => setBannersRetryKey((k) => k + 1)} />
        ) : !banners ? (
          <LoadingSkeleton kind="table" />
        ) : (
          <>
            <div className="toolbar">
              <FilterChips
                options={PLACEMENT_OPTIONS}
                value={placement}
                onChange={setPlacement}
                counts={placementCounts}
                ariaLabel="Banner placement"
              />
              {allowed && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setToast(null)
                    setBannerError(null)
                    setBannerModal({ banner: null })
                  }}
                >
                  New banner
                </button>
              )}
            </div>
            {visibleBanners.length === 0 ? (
              <EmptyState title="No banners" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Placement</th>
                      <th>Active</th>
                      <th>Schedule</th>
                      <th>Clicks</th>
                      <th>Impressions</th>
                      {allowed && <th>Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleBanners.map((b) => (
                      <tr key={b.id}>
                        <td>{b.title}</td>
                        <td>
                          <span className="tag">{b.placement}</span>
                        </td>
                        <td>
                          <StatusPill status={b.active ? 'active' : 'inactive'} tone={b.active ? 'ok' : 'muted'} label={b.active ? 'Active' : 'Inactive'} />
                        </td>
                        <td className="muted">
                          {toLocal(b.scheduledFrom)} → {toLocal(b.scheduledTo)}
                        </td>
                        <td>{b.clicks ?? '—'}</td>
                        <td>{b.impressions ?? '—'}</td>
                        {allowed && (
                          <td>
                            <button
                              type="button"
                              className="btn"
                              onClick={() => {
                                setToast(null)
                                setBannerError(null)
                                setBannerModal({ banner: b })
                              }}
                            >
                              Edit
                            </button>{' '}
                            <button
                              type="button"
                              className="btn btn-danger"
                              onClick={() => {
                                setToast(null)
                                setDeleteError(null)
                                setDeleteTarget(b)
                              }}
                            >
                              Delete
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )
      ) : templatesError ? (
        <ErrorState title="Failed to load templates" message={templatesError} onRetry={() => setTemplatesRetryKey((k) => k + 1)} />
      ) : !templates ? (
        <LoadingSkeleton kind="table" />
      ) : (
        <>
          <div className="toolbar">
              <FilterChips
                options={CHANNEL_OPTIONS}
                value={channel}
                onChange={setChannel}
                counts={channelCounts}
                ariaLabel="Template channel"
              />
              {allowed && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setToast(null)
                    setTemplateError(null)
                    setTemplateModalOpen(true)
                  }}
                >
                  Upsert template
                </button>
              )}
            </div>
          {visibleTemplates.length === 0 ? (
            <EmptyState title="No templates" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Channel</th>
                    <th>Subject</th>
                    <th>Active</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleTemplates.map((t) => (
                    <tr key={t.key} className="row-click" onClick={() => setSelectedTemplate(t)}>
                      <td className="mono">{t.key}</td>
                      <td>
                        <span className="tag">{t.channel}</span>
                      </td>
                      <td>{t.subject ?? '—'}</td>
                      <td>
                        <StatusPill status={t.active ? 'active' : 'inactive'} tone={t.active ? 'ok' : 'muted'} label={t.active ? 'Active' : 'Inactive'} />
                      </td>
                      <td className="muted">{toLocal(t.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {bannerModal && (
        <BannerModal
          initial={bannerModal.banner}
          busy={bannerBusy}
          error={bannerError}
          onSubmit={submitBanner}
          onClose={() => {
            if (!bannerBusy) setBannerModal(null)
          }}
        />
      )}

      {deleteTarget && (
        <ReasonPrompt
          title="Delete banner"
          description={`Permanently delete "${deleteTarget.title}"?`}
          maxLength={500}
          required
          tone="danger"
          confirmLabel="Delete"
          busy={deleteBusy}
          error={deleteError}
          onSubmit={confirmDelete}
          onClose={() => {
            if (!deleteBusy) setDeleteTarget(null)
          }}
        />
      )}

      {templateModalOpen && (
        <TemplateModal
          busy={templateBusy}
          error={templateError}
          onSubmit={submitTemplate}
          onClose={() => {
            if (!templateBusy) setTemplateModalOpen(false)
          }}
        />
      )}

      {selectedTemplate && <TemplateDrawer template={selectedTemplate} onClose={() => setSelectedTemplate(null)} />}
    </div>
  )
}

function BannerModal({
  initial,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  initial: AdminBanner | null
  busy: boolean
  error: string | null
  onSubmit: (form: BannerForm) => void
  onClose: () => void
}) {
  const [form, setForm] = useState<BannerForm>(() => toBannerForm(initial))

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!form.title.trim()) return
    onSubmit(form)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={initial ? 'Edit banner' : 'New banner'}
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="modal-title">{initial ? 'Edit banner' : 'New banner'}</h3>
        <div className="form-grid">
          <Field label="Title">
            <input
              className="field"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              required
              maxLength={120}
            />
          </Field>
          <Field label="Placement">
            <select
              className="field"
              value={form.placement}
              onChange={(e) => setForm({ ...form, placement: e.target.value as AdminBannerPlacement })}
            >
              {PLACEMENTS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Description">
            <textarea
              className="field"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              maxLength={500}
            />
          </Field>
          <Field label="Link">
            <input
              className="field"
              value={form.link}
              onChange={(e) => setForm({ ...form, link: e.target.value })}
              placeholder="https://"
            />
          </Field>
          <Field label="Scheduled from">
            <input
              type="datetime-local"
              className="field"
              value={form.scheduledFrom}
              onChange={(e) => setForm({ ...form, scheduledFrom: e.target.value })}
            />
          </Field>
          <Field label="Scheduled to">
            <input
              type="datetime-local"
              className="field"
              value={form.scheduledTo}
              onChange={(e) => setForm({ ...form, scheduledTo: e.target.value })}
            />
          </Field>
        </div>
        <Field label="Active">
          <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
        </Field>
        {error && <InlineError message={error} />}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Working…' : initial ? 'Save changes' : 'Create banner'}
          </button>
        </div>
      </form>
    </div>
  )
}

function TemplateModal({
  busy,
  error,
  onSubmit,
  onClose,
}: {
  busy: boolean
  error: string | null
  onSubmit: (form: TemplateForm) => void
  onClose: () => void
}) {
  const [form, setForm] = useState<TemplateForm>({ key: '', channel: 'email', subject: '', body: '', active: true })

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!form.key.trim()) return
    onSubmit(form)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Upsert template"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="modal-title">Upsert template</h3>
        <div className="form-grid">
          <Field label="Key">
            <input
              className="field mono"
              value={form.key}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
              required
              placeholder="e.g. order_confirmation"
            />
          </Field>
          <Field label="Channel">
            <select
              className="field"
              value={form.channel}
              onChange={(e) => setForm({ ...form, channel: e.target.value as AdminTemplateChannel })}
            >
              {CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Subject">
            <input
              className="field"
              value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value })}
              maxLength={160}
            />
          </Field>
          <Field label="Body">
            <textarea
              className="field"
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
              maxLength={10000}
            />
          </Field>
        </div>
        <Field label="Active">
          <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
        </Field>
        {error && <InlineError message={error} />}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Working…' : 'Save template'}
          </button>
        </div>
      </form>
    </div>
  )
}

function TemplateDrawer({ template, onClose }: { template: AdminTemplate; onClose: () => void }) {
  return (
    <DetailDrawer title={template.key} onClose={onClose}>
      <div className="detail-section">
        <h3>Template</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">Key</span>
            <span className="meta-value mono">{template.key}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Channel</span>
            <span className="meta-value">
              <span className="tag">{template.channel}</span>
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Active</span>
            <span className="meta-value">
              <StatusPill status={template.active ? 'active' : 'inactive'} tone={template.active ? 'ok' : 'muted'} label={template.active ? 'Active' : 'Inactive'} />
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Subject</span>
            <span className="meta-value">{template.subject ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Updated</span>
            <span className="meta-value">{toLocal(template.updatedAt)}</span>
          </div>
        </div>
      </div>

      <div className="detail-section">
        <h3>Body</h3>
        <pre className="mono small">{template.body ?? '—'}</pre>
      </div>

      <div className="detail-section">
        <h3>Variables</h3>
        {(template.variables ?? []).length === 0 && <p className="muted small">No variables declared</p>}
        {(template.variables ?? []).map((v) => (
          <span key={v} className="tag mono">
            {v}
          </span>
        ))}
      </div>
    </DetailDrawer>
  )
}
