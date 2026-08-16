import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  adminListBookings,
  adminListCustomers,
  adminListMerchants,
  adminListOrders,
  adminListProviders,
  adminListRiders,
  getShipmentCustody,
  listShipments,
  type AdminGlobalSearch200Item,
  type AdminGlobalSearch200ItemEntityType,
  type AdminListCustomers200Item,
  type BookingDetail,
  type CustodyEntry,
  type MerchantAdmin,
  type OrderDetail,
  type ProviderAdmin,
  type RiderAdmin,
  type Shipment,
} from '@hudumika/contract'
import { DetailDrawer } from '../../components/DetailDrawer'
import { StatusPill } from '../../components/StatusPill'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { toLocal } from '../../lib/time'
import { formatTZS } from '../../lib/money'

const OK_STATUSES = ['live', 'active', 'approved', 'open', 'paid']
const BAD_STATUSES = ['blocked', 'suspended', 'cancelled', 'failed', 'closed']

export function statusTone(status: string): 'ok' | 'bad' | 'warn' | 'brand' {
  const s = status.toLowerCase()
  if (OK_STATUSES.includes(s)) return 'ok'
  if (BAD_STATUSES.includes(s)) return 'bad'
  if (s === 'pending') return 'warn'
  return 'brand'
}

const MODULES: Record<AdminGlobalSearch200ItemEntityType, { module: string; route: string }> = {
  order: { module: 'Orders', route: '/commerce/orders' },
  shipment: { module: 'Shipments', route: '/logistics/shipments' },
  customer: { module: 'Customers', route: '/customers' },
  provider: { module: 'Providers', route: '/services/providers' },
  rider: { module: 'Riders', route: '/logistics/riders' },
  merchant: { module: 'Merchants', route: '/commerce/merchants' },
  booking: { module: 'Bookings', route: '/bookings' },
  hub: { module: 'Hubs', route: '/operations/hubs' },
  vehicle: { module: 'Fleet', route: '/operations/fleet' },
  ticket: { module: 'Support inbox', route: '/support/inbox' },
  conversation: { module: 'Conversations', route: '/conversations' },
}

const NO_ADAPTER_TYPES: AdminGlobalSearch200ItemEntityType[] = ['hub', 'vehicle', 'ticket', 'conversation']

const NO_ADAPTER_NOTE = 'Full timelines, scans, and audit history live in the owning module.'

type EntityDetail =
  | { kind: 'order'; data: OrderDetail }
  | { kind: 'shipment'; data: Shipment; custody: CustodyEntry[] }
  | { kind: 'rider'; data: RiderAdmin }
  | { kind: 'merchant'; data: MerchantAdmin }
  | { kind: 'customer'; data: AdminListCustomers200Item }
  | { kind: 'booking'; data: BookingDetail }
  | { kind: 'provider'; data: ProviderAdmin }

async function fetchEntityDetail(item: AdminGlobalSearch200Item): Promise<EntityDetail | null> {
  const id = item.id.toLowerCase()
  switch (item.entityType) {
    case 'order': {
      const res = await adminListOrders()
      if (res.status !== 200) throw new Error(`Failed to load order detail (${res.status})`)
      const order = res.data.find((o) => o.id.toLowerCase() === id)
      return order ? { kind: 'order', data: order } : null
    }
    case 'shipment': {
      const res = await listShipments()
      if (res.status !== 200) throw new Error(`Failed to load shipment detail (${res.status})`)
      const shipment = res.data.find((s) => s.id.toLowerCase() === id)
      if (!shipment) return null
      const custodyRes = await getShipmentCustody(shipment.id)
      if (custodyRes.status !== 200) throw new Error(`Failed to load custody (${custodyRes.status})`)
      return { kind: 'shipment', data: shipment, custody: custodyRes.data }
    }
    case 'rider': {
      const res = await adminListRiders()
      if (res.status !== 200) throw new Error(`Failed to load rider detail (${res.status})`)
      const rider = res.data.find((r) => r.id.toLowerCase() === id)
      return rider ? { kind: 'rider', data: rider } : null
    }
    case 'merchant': {
      const res = await adminListMerchants()
      if (res.status !== 200) throw new Error(`Failed to load merchant detail (${res.status})`)
      const merchant = res.data.find((m) => m.id.toLowerCase() === id)
      return merchant ? { kind: 'merchant', data: merchant } : null
    }
    case 'customer': {
      const res = await adminListCustomers()
      if (res.status !== 200) throw new Error(`Failed to load customer detail (${res.status})`)
      const customer = res.data.find((c) => c.id.toLowerCase() === id)
      return customer ? { kind: 'customer', data: customer } : null
    }
    case 'booking': {
      const res = await adminListBookings()
      if (res.status !== 200) throw new Error(`Failed to load booking detail (${res.status})`)
      const booking = res.data.find((b) => b.id.toLowerCase() === id)
      return booking ? { kind: 'booking', data: booking } : null
    }
    case 'provider': {
      const res = await adminListProviders()
      if (res.status !== 200) throw new Error(`Failed to load provider detail (${res.status})`)
      const provider = res.data.find((p) => p.id.toLowerCase() === id)
      return provider ? { kind: 'provider', data: provider } : null
    }
  }
  return null
}

type DetailPhase = 'loading' | 'error' | 'no-adapter' | 'missing' | 'done'

function useEntityDetail(item: AdminGlobalSearch200Item, retryKey: number) {
  const [phase, setPhase] = useState<DetailPhase>(() =>
    NO_ADAPTER_TYPES.includes(item.entityType) ? 'no-adapter' : 'loading',
  )
  const [detail, setDetail] = useState<EntityDetail | null>(null)

  useEffect(() => {
    let cancelled = false
    if (NO_ADAPTER_TYPES.includes(item.entityType)) {
      setPhase('no-adapter')
      setDetail(null)
      return
    }
    setPhase('loading')
    setDetail(null)
    fetchEntityDetail(item)
      .then((d) => {
        if (cancelled) return
        if (d) {
          setDetail(d)
          setPhase('done')
        } else setPhase('missing')
      })
      .catch(() => {
        if (!cancelled) setPhase('error')
      })
    return () => {
      cancelled = true
    }
  }, [item.entityType, item.id, retryKey])

  return { phase, detail }
}

function OrderDetailSections({ order }: { order: OrderDetail }) {
  const items = order.items ?? []
  return (
    <div className="drawer-grid">
      <div>
        <h3>Timeline</h3>
        <div className="timeline">
          {[...order.events]
            .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
            .map((ev, i) => (
              <div key={i} className="timeline-item">
                <div className="timeline-dot" />
                <div>
                  <div className="small strong">{ev.status}</div>
                  <div className="muted small">
                    {toLocal(ev.at)} · {ev.by}
                  </div>
                  {ev.note && <div className="muted small">{ev.note}</div>}
                </div>
              </div>
            ))}
        </div>

        <h3>Items</h3>
        <p className="small">
          {items.length} item{items.length === 1 ? '' : 's'}
        </p>
        <p className="small">
          Total <span className="mono">{formatTZS(order.totals.totalTZS)}</span>
        </p>
      </div>
      <div>
        <h3>Parties</h3>
        <p className="small">
          <span className="mono">{order.merchantId}</span> · merchant
          {order.riderId && (
            <>
              <br />
              <span className="mono">{order.riderId}</span> · rider
            </>
          )}
        </p>

        <h3>Origin / Destination</h3>
        <p className="small">
          {order.deliveryAddress.label}
          <br />
          <span className="muted">{order.deliveryAddress.lines}</span>
          {order.deliveryAddress.landmark && (
            <>
              <br />
              <span className="muted">{order.deliveryAddress.landmark}</span>
            </>
          )}
        </p>
      </div>
    </div>
  )
}

function ShipmentDetailSections({ shipment, custody }: { shipment: Shipment; custody: CustodyEntry[] }) {
  return (
    <>
      <h3>Shipment</h3>
      <p className="small">
        <span className="mono">{shipment.shipmentNumber}</span> · {shipment.status}
        <br />
        <span className="muted">Order</span> <span className="mono">{shipment.orderId}</span>
      </p>

      <h3>Scans & custody</h3>
      {custody.length === 0 && <p className="muted small">No custody entries</p>}
      <div className="timeline">
        {custody.map((e) => (
          <div key={e.id} className="timeline-item">
            <div className="timeline-dot" />
            <div>
              <div className="small strong">{e.eventType}</div>
              <div className="muted small">
                {e.actorType ? `${e.actorType}${e.actorId ? ` · ${e.actorId}` : ''}` : e.actorId ?? 'system'}
                {e.deviceId ? ` · device ${e.deviceId}` : ''}
              </div>
              {(e.previousState != null || e.newState != null) && (
                <div className="mono small">
                  {e.previousState ?? '—'} → {e.newState ?? '—'}
                </div>
              )}
              {e.evidence && <div className="muted small">{e.evidence}</div>}
              <div className="muted small">{toLocal(e.at)}</div>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

function RiderDetailSections({ rider }: { rider: RiderAdmin }) {
  return (
    <>
      <h3>Status</h3>
      <p className="small">
        <StatusPill status={rider.verification} tone={statusTone(rider.verification)} />
      </p>
      <h3>Parties</h3>
      <p className="small">{rider.city}</p>
      <h3>Reliability</h3>
      <p className="small">{rider.reliabilityScore ?? '—'} / 100</p>
    </>
  )
}

function MerchantDetailSections({ merchant }: { merchant: MerchantAdmin }) {
  const categories = merchant.categories ?? []
  return (
    <>
      <h3>Business</h3>
      <p className="small">{merchant.businessName}</p>
      <h3>Location</h3>
      <p className="small">{merchant.city}</p>
      <h3>Categories</h3>
      <p className="small">
        {categories.length > 0
          ? categories.map((c, i) => (
              <span key={c}>
                {i > 0 ? ' ' : ''}
                <span className="tag">{c}</span>
              </span>
            ))
          : '—'}
      </p>
      <h3>Verification</h3>
      <p className="small">
        <StatusPill status={merchant.verification} tone={statusTone(merchant.verification)} />
      </p>
      <h3>Rating</h3>
      <p className="small">{merchant.rating.toFixed(1)} / 5</p>
    </>
  )
}

function CustomerDetailSections({ customer }: { customer: AdminListCustomers200Item }) {
  return (
    <>
      <h3>Activity</h3>
      <p className="small">
        {customer.orderCount ?? '—'} orders · <span className="mono">{formatTZS(customer.totalSpendTZS)}</span>{' '}
        total spend
        <br />
        <span className="muted">Last order {toLocal(customer.lastOrderAt)}</span>
      </p>
    </>
  )
}

function BookingDetailSections({ booking }: { booking: BookingDetail }) {
  return (
    <>
      <h3>Service</h3>
      <p className="small mono">{booking.serviceId}</p>
      <h3>Schedule</h3>
      <p className="small">{toLocal(booking.scheduledFor)}</p>
      <h3>Status</h3>
      <p className="small">
        <StatusPill status={booking.status} tone={statusTone(booking.status)} />
      </p>
    </>
  )
}

function ProviderDetailSections({ provider }: { provider: ProviderAdmin }) {
  const serviceAreas = provider.serviceAreas ?? []
  return (
    <>
      <h3>Service areas</h3>
      <p className="small">
        {serviceAreas.length > 0
          ? serviceAreas.map((a, i) => (
              <span key={a}>
                {i > 0 ? ' ' : ''}
                <span className="tag">{a}</span>
              </span>
            ))
          : '—'}
      </p>
      <h3>Reliability</h3>
      <p className="small">{provider.reliabilityScore} / 100</p>
    </>
  )
}

function EntityDetails({
  item,
  retryKey,
  onRetry,
}: {
  item: AdminGlobalSearch200Item
  retryKey: number
  onRetry: () => void
}) {
  const { phase, detail } = useEntityDetail(item, retryKey)

  if (phase === 'loading') return <LoadingSkeleton kind="table" rows={2} />
  if (phase === 'error')
    return (
      <div>
        <p className="muted small">Detail unavailable</p>
        <p className="small">
          <button className="btn" type="button" onClick={onRetry}>
            Retry
          </button>
        </p>
      </div>
    )
  if (phase === 'no-adapter') return <p className="muted small">{NO_ADAPTER_NOTE}</p>
  if (phase === 'missing') return <p className="muted small">No extended detail for this record</p>
  if (!detail) return null

  switch (detail.kind) {
    case 'order':
      return <OrderDetailSections order={detail.data} />
    case 'shipment':
      return <ShipmentDetailSections shipment={detail.data} custody={detail.custody} />
    case 'rider':
      return <RiderDetailSections rider={detail.data} />
    case 'merchant':
      return <MerchantDetailSections merchant={detail.data} />
    case 'customer':
      return <CustomerDetailSections customer={detail.data} />
    case 'booking':
      return <BookingDetailSections booking={detail.data} />
    case 'provider':
      return <ProviderDetailSections provider={detail.data} />
  }
}

export function EntityView({ item, onClose }: { item: AdminGlobalSearch200Item; onClose: () => void }) {
  const link = MODULES[item.entityType]
  const [retryKey, setRetryKey] = useState(0)
  return (
    <DetailDrawer title={item.label} onClose={onClose}>
      <div className="meta-grid">
        <div className="meta-item">
          <span className="meta-label">Entity type</span>
          <span className="meta-value">
            <span className="tag">{item.entityType}</span>
          </span>
        </div>
        <div className="meta-item">
          <span className="meta-label">ID</span>
          <span className="meta-value mono">{item.id}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Label</span>
          <span className="meta-value">{item.label}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Status</span>
          <span className="meta-value">
            {item.status ? <StatusPill status={item.status} tone={statusTone(item.status)} /> : '—'}
          </span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Region</span>
          <span className="meta-value">{item.region ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Updated</span>
          <span className="meta-value muted">{toLocal(item.updatedAt)}</span>
        </div>
      </div>

      <h3>Details</h3>
      <EntityDetails item={item} retryKey={retryKey} onRetry={() => setRetryKey((k) => k + 1)} />

      <h3>Audit history</h3>
      <p className="small">
        <Link className="btn" to="/audit/logs">
          Open audit trail
        </Link>
      </p>
      <p className="muted small">Filter by entity to see its audit trail.</p>

      <h3>Actions</h3>
      <p className="small">
        <Link className="btn" to={link.route}>
          Open in {link.module}
        </Link>
      </p>
    </DetailDrawer>
  )
}
