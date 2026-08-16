import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  FleetAccountStatus as FleetAccountStatusConst,
  createFleetAccount,
  listFleetAccounts,
  updateFleetAccount,
  type FleetAccount,
  type FleetAccountStatus,
} from '@hudumika/contract'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { DetailDrawer } from '../../components/DetailDrawer'
import { ErrorState } from '../../components/ErrorState'
import { Field, InlineError, Toast } from '../../components/FormBits'
import { FilterChips } from '../../components/FilterChips'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { StatusPill } from '../../components/StatusPill'
import { parseApiError } from '../../lib/api-error'
import { toLocal } from '../../lib/time'

type StatusFilter = 'all' | FleetAccountStatus

const STATUSES = Object.values(FleetAccountStatusConst)

const STATUS_OPTIONS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  ...STATUSES.map((s) => ({ key: s as StatusFilter, label: s })),
]

function toneFor(status: FleetAccountStatus): 'ok' | 'bad' {
  return status === 'active' ? 'ok' : 'bad'
}

interface FleetAccountForm {
  name: string
  ownerUserId: string
  regions: string
  status: FleetAccountStatus
}

function parseRegions(input: string): string[] {
  return input
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
}

const COLUMNS: DataTableColumn<FleetAccount>[] = [
  { key: 'name', header: 'Name', render: (a) => a.name, sortValue: (a) => a.name },
  { key: 'owner', header: 'Owner', render: (a) => a.ownerUserId ?? '—', className: 'mono' },
  {
    key: 'drivers',
    header: 'Driver sub-accounts',
    render: (a) => ((a.driverSubAccountIds ?? []).length === 0 ? '—' : (a.driverSubAccountIds ?? []).length),
    className: 'mono',
  },
  {
    key: 'vehicles',
    header: 'Vehicles',
    render: (a) => ((a.vehicles ?? []).length === 0 ? '—' : (a.vehicles ?? []).length),
    className: 'mono',
  },
  {
    key: 'regions',
    header: 'Regions',
    render: (a) =>
      (a.regions ?? []).length === 0 ? (
        '—'
      ) : (
        <>
          {(a.regions ?? []).map((r) => (
            <span key={r} className="tag">
              {r}
            </span>
          ))}
        </>
      ),
  },
  { key: 'status', header: 'Status', render: (a) => <StatusPill status={a.status} tone={toneFor(a.status)} /> },
  { key: 'created', header: 'Created', render: (a) => toLocal(a.createdAt), className: 'muted' },
]

export function FleetAccountsPage() {
  const [accounts, setAccounts] = useState<FleetAccount[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const [status, setStatus] = useState<StatusFilter>('all')
  const [selected, setSelected] = useState<FleetAccount | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<FleetAccount | null>(null)
  const [formBusy, setFormBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
    listFleetAccounts().then((res) => {
      if (res.status === 200) setAccounts(res.data)
      else setError(parseApiError(res, 'Failed to load fleet accounts').message)
    })
  }, [retryKey])

  const statusCounts = useMemo(() => {
    const map: Partial<Record<StatusFilter, number>> = { all: accounts?.length ?? 0 }
    for (const s of STATUSES) map[s] = (accounts ?? []).filter((a) => a.status === s).length
    return map
  }, [accounts])

  const visible = useMemo(
    () => (accounts ?? []).filter((a) => status === 'all' || a.status === status),
    [accounts, status],
  )

  function submitCreate(form: FleetAccountForm) {
    setFormBusy(true)
    setFormError(null)
    createFleetAccount({
      id: '',
      name: form.name.trim(),
      status: form.status,
      ...(form.ownerUserId.trim() ? { ownerUserId: form.ownerUserId.trim() } : {}),
      ...(form.regions.trim() ? { regions: parseRegions(form.regions) } : {}),
    }).then((res) => {
      if (res.status === 201) {
        setToast('Fleet account created')
        setCreateOpen(false)
        setRetryKey((k) => k + 1)
      } else {
        setFormError(parseApiError(res, 'Could not create fleet account').message)
      }
      setFormBusy(false)
    })
  }

  function submitEdit(form: FleetAccountForm) {
    if (!editTarget) return
    setFormBusy(true)
    setFormError(null)
    updateFleetAccount(editTarget.id, {
      id: editTarget.id,
      name: form.name.trim(),
      status: form.status,
    }).then((res) => {
      if (res.status === 200) {
        setToast('Fleet account updated')
        setSelected(res.data)
        setEditTarget(null)
        setRetryKey((k) => k + 1)
      } else {
        setFormError(parseApiError(res, 'Could not update fleet account').message)
      }
      setFormBusy(false)
    })
  }

  if (error) {
    return (
      <ErrorState title="Failed to load fleet accounts" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
    )
  }
  if (!accounts) return <LoadingSkeleton kind="table" />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Fleet accounts</h1>
        {toast && (
          <div className="page-actions">
            <Toast message={toast} />
          </div>
        )}
      </div>

      <div className="toolbar">
        <FilterChips
          options={STATUS_OPTIONS}
          value={status}
          onChange={setStatus}
          counts={statusCounts}
          ariaLabel="Fleet account status"
        />
        <button
          type="button"
          className="btn"
          onClick={() => {
            setToast(null)
            setFormError(null)
            setCreateOpen(true)
          }}
        >
          New account
        </button>
      </div>

      <DataTable
        rows={visible}
        columns={COLUMNS}
        rowKey={(a) => a.id}
        onRowClick={setSelected}
        exportable
        exportFileName="fleet-accounts"
        emptyTitle="No fleet accounts"
        ariaLabel="Fleet accounts"
      />

      <p className="muted small">Fleet accounts are audited (fleet.*); suspension blocks driver sub-accounts.</p>

      {selected && (
        <FleetAccountDrawer
          account={selected}
          onClose={() => setSelected(null)}
          onToast={setToast}
          onListChanged={() => setRetryKey((k) => k + 1)}
          onEdit={(a) => {
            setToast(null)
            setFormError(null)
            setEditTarget(a)
          }}
        />
      )}

      {createOpen && (
        <FleetAccountFormModal
          initial={null}
          busy={formBusy}
          error={formError}
          onSubmit={submitCreate}
          onClose={() => {
            if (!formBusy) setCreateOpen(false)
          }}
        />
      )}

      {editTarget && (
        <FleetAccountFormModal
          initial={editTarget}
          busy={formBusy}
          error={formError}
          onSubmit={submitEdit}
          onClose={() => {
            if (!formBusy) setEditTarget(null)
          }}
        />
      )}
    </div>
  )
}

function FleetAccountDrawer({
  account,
  onClose,
  onToast,
  onListChanged,
  onEdit,
}: {
  account: FleetAccount
  onClose: () => void
  onToast: (message: string) => void
  onListChanged: () => void
  onEdit: (a: FleetAccount) => void
}) {
  return (
    <DetailDrawer title={account.name} onClose={onClose}>
      <div className="detail-section">
        <h3>Overview</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">ID</span>
            <span className="meta-value mono">{account.id}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Name</span>
            <span className="meta-value">{account.name}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Owner user</span>
            <span className="meta-value mono">{account.ownerUserId ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Driver sub-accounts</span>
            <span className="meta-value">
              {(account.driverSubAccountIds ?? []).length === 0 ? (
                '—'
              ) : (
                <>
                  {(account.driverSubAccountIds ?? []).map((id) => (
                    <span key={id} className="mono">
                      {id}
                      <br />
                    </span>
                  ))}
                </>
              )}
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Vehicles</span>
            <span className="meta-value">
              {(account.vehicles ?? []).length === 0 ? (
                '—'
              ) : (
                <>
                  {(account.vehicles ?? []).map((id) => (
                    <span key={id} className="mono">
                      {id}
                      <br />
                    </span>
                  ))}
                </>
              )}
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Regions</span>
            <span className="meta-value">
              {(account.regions ?? []).length === 0 ? (
                '—'
              ) : (
                <>
                  {(account.regions ?? []).map((r) => (
                    <span key={r} className="tag">
                      {r}
                    </span>
                  ))}
                </>
              )}
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Permissions</span>
            <span className="meta-value">
              {Object.keys(account.permissions ?? {}).length === 0 ? (
                '—'
              ) : (
                <>
                  {Object.keys(account.permissions ?? {}).map((key) => (
                    <span key={key} className="tag">
                      {key}
                    </span>
                  ))}
                </>
              )}
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Status</span>
            <span className="meta-value">
              <StatusPill status={account.status} tone={toneFor(account.status)} />
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Created</span>
            <span className="meta-value">{toLocal(account.createdAt)}</span>
          </div>
        </div>
      </div>

      <div className="page-actions">
        <button type="button" className="btn" onClick={() => onEdit(account)}>
          Edit
        </button>
      </div>

      <p className="muted small">
        Fleet accounts are audited (fleet.*); suspension blocks driver sub-accounts.
      </p>
    </DetailDrawer>
  )
}

function FleetAccountFormModal({
  initial,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  initial: FleetAccount | null
  busy: boolean
  error: string | null
  onSubmit: (form: FleetAccountForm) => void
  onClose: () => void
}) {
  const editing = initial !== null
  const [form, setForm] = useState<FleetAccountForm>(() => ({
    name: initial?.name ?? '',
    ownerUserId: initial?.ownerUserId ?? '',
    regions: (initial?.regions ?? []).join(', '),
    status: initial?.status ?? 'active',
  }))

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) return
    onSubmit(form)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? 'Edit fleet account' : 'New fleet account'}
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="modal-title">{editing ? 'Edit fleet account' : 'New fleet account'}</h3>
        <div className="form-grid">
          <Field label="Name">
            <input
              className="field"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
              maxLength={120}
            />
          </Field>
          {!editing && (
            <>
              <Field label="Owner user ID">
                <input
                  className="field mono"
                  value={form.ownerUserId}
                  onChange={(e) => setForm({ ...form, ownerUserId: e.target.value })}
                  maxLength={120}
                />
              </Field>
              <Field label="Regions" hint="Comma-separated region codes">
                <input
                  className="field"
                  value={form.regions}
                  onChange={(e) => setForm({ ...form, regions: e.target.value })}
                  maxLength={300}
                />
              </Field>
            </>
          )}
          <Field label="Status">
            <select
              className="field"
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value as FleetAccountStatus })}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {error && <InlineError message={error} />}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Working…' : editing ? 'Save changes' : 'Create account'}
          </button>
        </div>
      </form>
    </div>
  )
}
