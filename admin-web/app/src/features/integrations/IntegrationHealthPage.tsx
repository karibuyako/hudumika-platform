import { useEffect, useMemo, useState } from 'react'
import {
  AdminIntegrationHealth200ItemCategory,
  adminIntegrationHealth,
  type AdminIntegrationHealth200Item,
  type AdminIntegrationHealth200ItemHealth,
} from '@hudumika/contract'
import { parseApiError, type ApiErrorInfo } from '../../lib/api-error'
import { toLocal } from '../../lib/time'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { DetailDrawer } from '../../components/DetailDrawer'
import { ErrorState } from '../../components/ErrorState'
import { FilterChips } from '../../components/FilterChips'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { StatusPill } from '../../components/StatusPill'

type CategoryFilter = 'all' | (typeof AdminIntegrationHealth200ItemCategory)[keyof typeof AdminIntegrationHealth200ItemCategory]

const CATEGORIES = Object.values(AdminIntegrationHealth200ItemCategory)

const FILTERS: Array<{ key: CategoryFilter; label: string }> = [
  { key: 'all', label: 'All' },
  ...CATEGORIES.map((c) => ({ key: c as CategoryFilter, label: c })),
]

function healthTone(health: AdminIntegrationHealth200ItemHealth): 'ok' | 'warn' | 'bad' {
  if (health === 'healthy') return 'ok'
  if (health === 'degraded') return 'warn'
  return 'bad'
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

const COLUMNS: DataTableColumn<AdminIntegrationHealth200Item>[] = [
  { key: 'provider', header: 'Provider', render: (i) => i.provider, sortValue: (i) => i.provider, className: 'strong' },
  { key: 'category', header: 'Category', render: (i) => <span className="tag">{i.category}</span> },
  { key: 'health', header: 'Health', render: (i) => <StatusPill status={i.health} tone={healthTone(i.health)} /> },
  { key: 'lastChecked', header: 'Last checked', render: (i) => toLocal(i.lastCheckedAt), sortValue: (i) => i.lastCheckedAt ?? null, className: 'muted' },
  {
    key: 'error',
    header: 'Error',
    render: (i) =>
      i.error ? (
        <span className="muted small" title={i.error}>
          {truncate(i.error, 60)}
        </span>
      ) : (
        '—'
      ),
  },
]

export function IntegrationHealthPage() {
  const [items, setItems] = useState<AdminIntegrationHealth200Item[] | null>(null)
  const [filter, setFilter] = useState<CategoryFilter>('all')
  const [selected, setSelected] = useState<AdminIntegrationHealth200Item | null>(null)
  const [error, setError] = useState<ApiErrorInfo | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    setError(null)
    adminIntegrationHealth().then((res) => {
      if (res.status === 200) setItems(res.data)
      else setError(parseApiError(res, 'Failed to load integrations'))
    })
  }, [retryKey])

  const counts = useMemo(() => {
    const map: Partial<Record<CategoryFilter, number>> = { all: items?.length ?? 0 }
    for (const c of CATEGORIES) map[c] = (items ?? []).filter((i) => i.category === c).length
    return map
  }, [items])

  const visible = useMemo(
    () => (items ?? []).filter((i) => filter === 'all' || i.category === filter),
    [items, filter],
  )

  const paymentAlert = useMemo(() => {
    const payments = (items ?? []).filter((i) => i.category === 'payment')
    const down = payments.filter((i) => i.health === 'down').length
    const degraded = down === 0 && payments.some((i) => i.health === 'degraded')
    return { down, degraded }
  }, [items])

  if (error) {
    return (
      <ErrorState
        title="Failed to load integrations"
        message={error.message}
        requestId={error.requestId}
        onRetry={() => setRetryKey((k) => k + 1)}
      />
    )
  }
  if (!items) return <LoadingSkeleton kind="table" rows={6} />

  return (
    <div className="page">
      <h1>Integration Health</h1>

      {paymentAlert.down > 0 && (
        <div className="notice">Payment provider down — {paymentAlert.down} payment integration(s) failing</div>
      )}
      {paymentAlert.degraded && <p className="muted small">Payment integration degraded</p>}

      <FilterChips
        options={FILTERS}
        value={filter}
        onChange={setFilter}
        counts={counts}
        ariaLabel="Integration category filters"
      />

      <DataTable
        rows={visible}
        columns={COLUMNS}
        rowKey={(i) => i.provider}
        onRowClick={setSelected}
        exportable
        exportFileName="integration-health"
        emptyTitle={items.length === 0 ? 'No integrations registered' : 'No integrations in this category'}
        emptyHint={items.length === 0 ? 'Integration health appears here once providers are registered.' : undefined}
        ariaLabel="Integration health"
      />

      {selected && <IntegrationDrawer item={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

function IntegrationDrawer({
  item,
  onClose,
}: {
  item: AdminIntegrationHealth200Item
  onClose: () => void
}) {
  return (
    <DetailDrawer title={item.provider} onClose={onClose}>
      <div className="detail-section">
        <h3>Integration</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">Provider</span>
            <span className="meta-value">{item.provider}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Category</span>
            <span className="meta-value">
              <span className="tag">{item.category}</span>
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Health</span>
            <span className="meta-value">
              <StatusPill status={item.health} tone={healthTone(item.health)} />
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Last checked</span>
            <span className="meta-value">{toLocal(item.lastCheckedAt)}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Error</span>
            <span className="meta-value">{item.error ?? '—'}</span>
          </div>
        </div>
      </div>
      <p className="muted small">
        Payment-category outages surface as control-tower payment failures; history transitions are audited
        (integration_health.*).
      </p>
    </DetailDrawer>
  )
}
