import { useCallback, useEffect, useState } from 'react'
import {
  adminListCustomers,
  adminSearchUsers,
  adminSetUserStatus,
  type AdminListCustomers200Item,
  type AdminSearchUsers200Item,
} from '@hudumika/contract'
import { ErrorState } from '../../components/ErrorState'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { DetailDrawer } from '../../components/DetailDrawer'
import { AuditTrailSection } from '../../components/AuditTrailSection'
import { ReasonPrompt } from '../../components/ReasonPrompt'
import { StatusPill } from '../../components/StatusPill'
import { FilterChips } from '../../components/FilterChips'
import { MaskedField } from '../../components/MaskedField'
import { Toast } from '../../components/FormBits'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { formatTZS } from '../../lib/money'
import { toLocal } from '../../lib/time'
import { parseApiError } from '../../lib/api-error'
import { useSession } from '../../lib/session'
import { can } from '../../lib/permissions'
import { useRefetchOnFocus } from '../../lib/use-refetch-on-focus'

type StatusFilter = 'all' | 'active' | 'suspended'

const STATUS_OPTIONS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'suspended', label: 'Suspended' },
]

/** Unified row shape: list-customers rows carry order aggregates, search-users rows carry identity fields. */
type CustomerRow = {
  id: string
  phone: string
  fullName?: string
  role?: string
  status?: string
  orderCount?: number
  totalSpendTZS?: number
  lastOrderAt?: string | null
  joinedAt?: string
  lastActiveAt?: string | null
}

function toRow(c: AdminListCustomers200Item | AdminSearchUsers200Item): CustomerRow {
  return c
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 10) return phone
  const head = phone.startsWith('+') ? phone.slice(0, 4) : phone.slice(0, 3)
  return `${head} ••• ${digits.slice(-3)}`
}

function toneFor(status: string | undefined): 'ok' | 'bad' | 'warn' | 'muted' {
  if (status === 'active') return 'ok'
  if (status === 'suspended') return 'bad'
  if (status === 'pending_verification') return 'warn'
  return 'muted'
}

interface PromptState {
  user: CustomerRow
  to: 'active' | 'suspended'
}

const COLUMNS: DataTableColumn<CustomerRow>[] = [
  {
    key: 'phone',
    header: 'Phone',
    render: (c) => <MaskedField value={c.phone} permission="audit.unmask" label="Phone" />,
  },
  { key: 'name', header: 'Name', render: (c) => c.fullName ?? '—' },
  { key: 'role', header: 'Role', render: (c) => c.role ?? '—' },
  { key: 'status', header: 'Status', render: (c) => <StatusPill status={c.status ?? '—'} tone={toneFor(c.status)} /> },
  { key: 'orders', header: 'Orders', render: (c) => c.orderCount ?? '—', sortValue: (c) => c.orderCount ?? 0 },
  {
    key: 'total',
    header: 'Total spend',
    render: (c) => formatTZS(c.totalSpendTZS),
    sortValue: (c) => c.totalSpendTZS ?? 0,
    align: 'right',
  },
  {
    key: 'lastOrder',
    header: 'Last order',
    render: (c) => toLocal(c.lastOrderAt),
    sortValue: (c) => c.lastOrderAt ?? null,
    className: 'muted',
  },
  { key: 'joined', header: 'Joined', render: (c) => toLocal(c.joinedAt), className: 'muted' },
]

export function CustomersPage() {
  const session = useSession()
  const canSuspend = can(session, 'customer.suspend')
  const [rows, setRows] = useState<CustomerRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [selected, setSelected] = useState<CustomerRow | null>(null)
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [promptError, setPromptError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    const params = query.trim() ? { q: query.trim() } : {}
    const req =
      status === 'all' ? adminListCustomers(params) : adminSearchUsers({ ...params, status })
    req.then((res) => {
      if (res.status === 200) setRows(res.data.map(toRow))
      else setError(parseApiError(res, 'Failed to load customers').message)
    })
  }, [query, status])

  useEffect(() => {
    load()
  }, [load, retryKey])

  useRefetchOnFocus(load)

  if (error) {
    return (
      <ErrorState
        title="Failed to load customers"
        message={error}
        onRetry={() => setRetryKey((k) => k + 1)}
      />
    )
  }
  if (!rows) return <LoadingSkeleton kind="table" />

  function submitStatus(reason: string) {
    if (!prompt) return
    setBusy(true)
    setPromptError(null)
    adminSetUserStatus(prompt.user.id, { status: prompt.to, reason }).then((res) => {
      if (res.status === 200) {
        setToast(prompt.to === 'suspended' ? 'Customer suspended' : 'Customer activated')
        setPrompt(null)
        setSelected(null)
        setRetryKey((k) => k + 1)
      } else {
        setPromptError(parseApiError(res, 'Could not update status').message)
        setBusy(false)
      }
    })
  }

  return (
    <div className="page">
      <h1>Customers</h1>

      <div className="toolbar">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            setToast(null)
            setQuery(search.trim())
          }}
        >
          <input
            className="topbar-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or phone"
            aria-label="Search customers"
          />
        </form>
        <FilterChips
          options={STATUS_OPTIONS}
          value={status}
          onChange={(s) => {
            setStatus(s)
            setToast(null)
          }}
          ariaLabel="Customer status"
        />
      </div>

      {toast && <Toast message={toast} />}

      <DataTable
        rows={rows}
        columns={COLUMNS}
        rowKey={(c) => c.id}
        onRowClick={setSelected}
        emptyTitle="No customers found"
        exportable
        exportFileName="customers"
        tableId="customers"
        ariaLabel="Customers"
      />

      {selected && (
        <DetailDrawer title={selected.fullName ?? maskPhone(selected.phone)} onClose={() => setSelected(null)}>
          <div className="meta-grid">
            <div className="meta-item">
              <span className="meta-label">ID</span>
              <span className="meta-value mono">{selected.id}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Role</span>
              <span className="meta-value">{selected.role ?? '—'}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Status</span>
              <span className="meta-value">
                <StatusPill status={selected.status ?? '—'} tone={toneFor(selected.status)} />
              </span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Joined</span>
              <span className="meta-value">{toLocal(selected.joinedAt)}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Last active</span>
              <span className="meta-value">{toLocal(selected.lastActiveAt)}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Orders</span>
              <span className="meta-value">{selected.orderCount ?? '—'}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Total spend</span>
              <span className="meta-value">{formatTZS(selected.totalSpendTZS)}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Phone</span>
              <span className="meta-value">
                <MaskedField value={selected.phone} permission="audit.unmask" label="Phone" />
              </span>
            </div>
          </div>
          <div className="page-actions">
            {canSuspend &&
              (selected.status === 'suspended' ? (
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    setToast(null)
                    setPrompt({ user: selected, to: 'active' })
                  }}
                >
                  Activate
                </button>
              ) : (
                <button
                  className="btn btn-danger"
                  type="button"
                  onClick={() => {
                    setToast(null)
                    setPrompt({ user: selected, to: 'suspended' })
                  }}
                >
                  Suspend
                </button>
              ))}
          </div>
          <AuditTrailSection entityType="customer" entityId={selected.id} label="Audit" />
        </DetailDrawer>
      )}

      {prompt && (
        <ReasonPrompt
          title={prompt.to === 'suspended' ? 'Suspend customer' : 'Activate customer'}
          maxLength={500}
          required
          tone={prompt.to === 'suspended' ? 'danger' : 'default'}
          busy={busy}
          error={promptError}
          onSubmit={submitStatus}
          onClose={() => {
            if (!busy) setPrompt(null)
          }}
        />
      )}
    </div>
  )
}
