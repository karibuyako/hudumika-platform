import { useCallback, useEffect, useState } from 'react'
import {
  adminListWebhookHealth,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
} from '@hudumika/contract'
import { toLocal } from '../../lib/time'
import { parseApiError, type ApiErrorInfo } from '../../lib/api-error'
import { DetailDrawer } from '../../components/DetailDrawer'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { ErrorState } from '../../components/ErrorState'
import { FilterChips } from '../../components/FilterChips'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { StatusPill } from '../../components/StatusPill'
import { useRefetchOnFocus } from '../../lib/use-refetch-on-focus'

type Filter = 'all' | 'failing'

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'failing', label: 'Failing only' },
]

const STATUS_TONE: Record<WebhookDeliveryStatus, 'ok' | 'bad' | 'warn'> = {
  success: 'ok',
  failed: 'bad',
  retrying: 'warn',
}

const COLUMNS: DataTableColumn<WebhookDelivery>[] = [
  { key: 'id', header: 'ID', render: (d) => d.id, className: 'mono' },
  { key: 'webhookId', header: 'Webhook ID', render: (d) => d.webhookId, className: 'mono' },
  { key: 'event', header: 'Event', render: (d) => d.event },
  { key: 'status', header: 'Status', render: (d) => <StatusPill status={d.status} tone={STATUS_TONE[d.status]} /> },
  { key: 'attempts', header: 'Attempts', render: (d) => d.attempts, sortValue: (d) => d.attempts, className: 'mono' },
  { key: 'statusCode', header: 'Status code', render: (d) => d.statusCode ?? '—', className: 'mono' },
  { key: 'nextRetry', header: 'Next retry', render: (d) => toLocal(d.nextRetryAt), className: 'muted' },
  { key: 'deliveredAt', header: 'Delivered', render: (d) => toLocal(d.deliveredAt), sortValue: (d) => d.deliveredAt ?? null, className: 'muted' },
]

export function WebhooksPage() {
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [selected, setSelected] = useState<WebhookDelivery | null>(null)
  const [error, setError] = useState<ApiErrorInfo | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const load = useCallback(() => {
    setError(null)
    const params = filter === 'failing' ? { failingOnly: true } : undefined
    adminListWebhookHealth(params).then((res) => {
      if (res.status === 200) setDeliveries(res.data)
      else setError(parseApiError(res, 'Failed to load webhooks'))
    })
  }, [filter])

  useEffect(() => {
    load()
  }, [load, retryKey])

  useRefetchOnFocus(load)

  if (error) {
    return (
      <ErrorState
        title="Failed to load webhooks"
        message={error.message}
        requestId={error.requestId}
        onRetry={() => setRetryKey((k) => k + 1)}
      />
    )
  }
  if (!deliveries) return <LoadingSkeleton kind="table" />

  return (
    <div className="page">
      <h1>Webhooks</h1>
      <FilterChips
        options={FILTERS}
        value={filter}
        onChange={setFilter}
        ariaLabel="Webhook health filters"
      />

      <DataTable
        rows={deliveries}
        columns={COLUMNS}
        rowKey={(d) => d.id}
        onRowClick={setSelected}
        exportable
        exportFileName="webhook-deliveries"
        tableId="webhooks"
        emptyTitle="No webhook deliveries found"
        emptyHint="Delivery activity appears here as merchants subscribe."
        ariaLabel="Webhook deliveries"
      />

      {selected && <WebhookDrawer delivery={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

function WebhookDrawer({ delivery, onClose }: { delivery: WebhookDelivery; onClose: () => void }) {
  return (
    <DetailDrawer title={delivery.id} onClose={onClose}>
      <div className="detail-section">
        <h3>Delivery</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">ID</span>
            <span className="meta-value mono">{delivery.id}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Webhook ID</span>
            <span className="meta-value mono">{delivery.webhookId}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Event</span>
            <span className="meta-value">{delivery.event}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Status</span>
            <span className="meta-value">
              <StatusPill status={delivery.status} tone={STATUS_TONE[delivery.status]} />
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Attempts</span>
            <span className="meta-value mono">{delivery.attempts}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Status code</span>
            <span className="meta-value mono">{delivery.statusCode ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Next retry</span>
            <span className="meta-value">{toLocal(delivery.nextRetryAt)}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Delivered</span>
            <span className="meta-value">{toLocal(delivery.deliveredAt)}</span>
          </div>
        </div>
      </div>

      <p className="muted small">
        Failing webhooks notify the merchant owner; retry follows server backoff. Persistent failures
        surface in the control tower.
      </p>
    </DetailDrawer>
  )
}
