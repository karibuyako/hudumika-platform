import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { adminAssignBookingProvider, adminListBookings, cancelBooking, type BookingDetail, type BookingStatus } from '@hudumika/contract'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { DetailDrawer } from '../../components/DetailDrawer'
import { ErrorState } from '../../components/ErrorState'
import { InlineError, Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { ReasonPrompt } from '../../components/ReasonPrompt'
import { StatusPill } from '../../components/StatusPill'
import { parseApiError, type ApiErrorInfo } from '../../lib/api-error'
import { formatTZS } from '../../lib/money'
import { toLocal } from '../../lib/time'
import { useSession } from '../../lib/session'
import { can } from '../../lib/permissions'
import { useRefetchOnFocus } from '../../lib/use-refetch-on-focus'

type Bucket = 'all' | 'needs_provider' | 'active' | 'completed' | 'cancelled' | 'disputed'

const NEEDS_PROVIDER: BookingStatus[] = ['matching', 'offered', 'provider_requested']
const ACTIVE: BookingStatus[] = [
  'provider_accepted',
  'scheduled',
  'reminder_sent',
  'en_route',
  'provider_arrived',
  'check_in',
  'diagnosing',
  'quote_required',
  'quote_submitted',
  'quote_accepted',
  'in_progress',
  'completion_review',
  'awaiting_customer_confirmation',
]
const COMPLETED: BookingStatus[] = ['completed', 'settled', 'warranty']
const CANCELLED: BookingStatus[] = ['cancelled', 'customer_cancelled', 'provider_cancelled', 'refunded', 'declined', 'no_show']
const DISPUTED: BookingStatus[] = ['disputed', 'escalated']

function needsProvider(b: BookingDetail) {
  return !b.providerId && NEEDS_PROVIDER.includes(b.status)
}

const BUCKETS: Array<{ key: Bucket; label: string; match: (b: BookingDetail) => boolean }> = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'needs_provider', label: 'Needs provider', match: needsProvider },
  { key: 'active', label: 'Active', match: (b) => ACTIVE.includes(b.status) },
  { key: 'completed', label: 'Completed', match: (b) => COMPLETED.includes(b.status) },
  { key: 'cancelled', label: 'Cancelled', match: (b) => CANCELLED.includes(b.status) },
  { key: 'disputed', label: 'Disputed', match: (b) => DISPUTED.includes(b.status) },
]

const COLUMNS: DataTableColumn<BookingDetail>[] = [
  { key: 'booking', header: 'Booking', render: (b) => short(b.id), className: 'mono' },
  { key: 'service', header: 'Service', render: (b) => short(b.serviceId), className: 'mono' },
  { key: 'provider', header: 'Provider', render: (b) => (b.providerId ? short(b.providerId) : '—') },
  { key: 'status', header: 'Status', render: (b) => <StatusPill status={b.status} tone={statusTone(b.status)} /> },
  { key: 'scheduled', header: 'Scheduled', render: (b) => toLocal(b.scheduledFor), sortValue: (b) => b.scheduledFor, className: 'muted' },
  { key: 'price', header: 'Price', render: (b) => formatTZS(b.price?.totalTZS), sortValue: (b) => b.price?.totalTZS ?? 0, align: 'right' },
  { key: 'technician', header: 'Technician', render: (b) => (b.technicianId ? short(b.technicianId) : '—') },
]

function statusTone(status: BookingStatus) {
  if (['completed', 'settled', 'warranty'].includes(status)) return 'ok'
  if ([...CANCELLED, ...DISPUTED].includes(status)) return 'bad'
  if (['in_progress', 'en_route', 'provider_arrived', 'diagnosing', 'quote_accepted'].includes(status)) return 'info'
  if (['scheduled', 'reminder_sent'].includes(status)) return 'warn'
  return 'brand'
}

export function BookingsPage() {
  const session = useSession()
  const canAssign = can(session, 'order.override')
  const [bookings, setBookings] = useState<BookingDetail[] | null>(null)
  const [bucket, setBucket] = useState<Bucket>('all')
  const [selected, setSelected] = useState<BookingDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const load = useCallback(() => {
    setError(null)
    adminListBookings().then((res) => {
      if (res.status === 200) setBookings(res.data)
      else setError(`Failed to load bookings (${res.status})`)
    })
  }, [])

  useEffect(() => {
    load()
  }, [load, retryKey])

  useRefetchOnFocus(load)

  const counts = useMemo(() => {
    if (!bookings) return new Map<Bucket, number>()
    const map = new Map<Bucket, number>()
    for (const b of BUCKETS) map.set(b.key, bookings.filter(b.match).length)
    return map
  }, [bookings])

  const visible = useMemo(
    () => (bookings ?? []).filter(BUCKETS.find((b) => b.key === bucket)!.match),
    [bookings, bucket],
  )

  if (error) return <ErrorState title="Failed to load bookings" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
  if (!bookings) return <LoadingSkeleton kind="table" />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Bookings</h1>
      </div>
      {notice && <Toast message={notice} />}
      <div className="filters">
        {BUCKETS.map((b) => (
          <button
            key={b.key}
            className={`chip${bucket === b.key ? ' active' : ''}`}
            onClick={() => setBucket(b.key)}
          >
            {b.label} <span className="chip-count">{counts.get(b.key) ?? 0}</span>
          </button>
        ))}
      </div>

      <DataTable
        rows={visible}
        columns={COLUMNS}
        rowKey={(b) => b.id}
        onRowClick={setSelected}
        emptyTitle={bookings.length === 0 ? 'No bookings found' : 'No bookings in this bucket'}
        ariaLabel="Bookings"
      />

      {selected && (
        <BookingDrawer
          booking={selected}
          canAssign={canAssign}
          onClose={() => setSelected(null)}
          onAssigned={() => {
            setNotice(`Provider assigned to ${short(selected.id)}`)
            setSelected(null)
            setRetryKey((k) => k + 1)
          }}
        />
      )}
    </div>
  )
}

function BookingDrawer({
  booking,
  canAssign,
  onClose,
  onAssigned,
}: {
  booking: BookingDetail
  canAssign: boolean
  onClose: () => void
  onAssigned: () => void
}) {
  const session = useSession()
  const canCancel = can(session, 'booking.cancel')
  const [assigning, setAssigning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [showCancelPrompt, setShowCancelPrompt] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  async function handleCancel(reason: string) {
    setBusy(true)
    setCancelError(null)
    const res = await cancelBooking(booking.id, { reason })
    setBusy(false)
    if (res.status === 200) {
      setToast('Booking cancelled')
      onClose()
    } else {
      setCancelError(parseApiError(res, 'Cancel failed').message)
    }
  }
  return (
    <>
      <DetailDrawer title={<span className="mono-strong">{booking.id}</span>} onClose={onClose}>
        <div className="drawer-grid">
          <div>
            <h3>Booking</h3>
            <div className="meta-grid">
              <div className="meta-item">
                <span className="meta-label">ID</span>
                <span className="meta-value mono">{booking.id}</span>
              </div>
              <div className="meta-item">
                <span className="meta-label">Status</span>
                <span className="meta-value">
                  <StatusPill status={booking.status} tone={statusTone(booking.status)} />
                </span>
              </div>
              <div className="meta-item">
                <span className="meta-label">Service</span>
                <span className="meta-value mono">{booking.serviceId}</span>
              </div>
              <div className="meta-item">
                <span className="meta-label">Provider</span>
                <span className="meta-value">{booking.providerId ? short(booking.providerId) : '—'}</span>
              </div>
              <div className="meta-item">
                <span className="meta-label">Technician</span>
                <span className="meta-value">{booking.technicianId ? short(booking.technicianId) : '—'}</span>
              </div>
              <div className="meta-item">
                <span className="meta-label">Scheduled for</span>
                <span className="meta-value">{toLocal(booking.scheduledFor)}</span>
              </div>
              <div className="meta-item">
                <span className="meta-label">SLA deadline</span>
                <span className="meta-value">{toLocal(booking.slaDeadlineAt)}</span>
              </div>
            </div>

            {needsProvider(booking) && (
              <>
                <h3>Assignment</h3>
                <p className="muted small">No provider assigned to this booking yet.</p>
                {canAssign && (
                  <button className="btn" type="button" onClick={() => setAssigning(true)}>
                    Assign provider
                  </button>
                )}
              </>
            )}

            <h3>Events</h3>
            <div className="timeline">
              {[...(booking.events ?? [])]
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
          </div>
          <div>
            <h3>Address</h3>
            <p className="small">
              {booking.address.label}
              <br />
              <span className="muted">{booking.address.lines}</span>
              {booking.address.landmark && (
                <>
                  <br />
                  <span className="muted">{booking.address.landmark}</span>
                </>
              )}
              <br />
              <span className="muted">{booking.address.contactPhone}</span>
            </p>

            <h3>Money (TZS)</h3>
            {booking.price ? (
              <table className="table table-sm">
                <tbody>
                  <tr><td>Subtotal</td><td>{formatTZS(booking.price.subtotalTZS)}</td></tr>
                  <tr><td>Delivery fee</td><td>{formatTZS(booking.price.deliveryFeeTZS)}</td></tr>
                  <tr><td>Platform fee</td><td>{formatTZS(booking.price.platformFeeTZS)}</td></tr>
                  <tr><td>Tax</td><td>{formatTZS(booking.price.taxTZS)}</td></tr>
                  <tr><td>Discount</td><td>{booking.price.discountTZS ? `−${formatTZS(booking.price.discountTZS)}` : formatTZS(booking.price.discountTZS)}</td></tr>
                  <tr className="row-total"><td>Total</td><td>{formatTZS(booking.price.totalTZS)}</td></tr>
                </tbody>
              </table>
            ) : (
              <p className="muted small">No price set</p>
            )}
          </div>
        </div>
      </DetailDrawer>
      {toast && <Toast message={toast} />}
      {canCancel && (
        <div className="detail-section">
          <h3>Actions</h3>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              setCancelError(null)
              setShowCancelPrompt(true)
            }}
          >
            Cancel booking
          </button>
        </div>
      )}
      {showCancelPrompt && (
        <ReasonPrompt
          title="Cancel booking"
          description={`Cancel booking ${booking.id} — current status: ${booking.status}.`}
          tone="danger"
          busy={busy}
          error={cancelError}
          onSubmit={async (reason) => {
            await handleCancel(reason)
            if (!cancelError) setShowCancelPrompt(false)
          }}
          onClose={() => {
            if (!busy) setShowCancelPrompt(false)
          }}
        />
      )}
      {assigning && <AssignProviderModal booking={booking} onClose={() => setAssigning(false)} onAssigned={onAssigned} />}
    </>
  )
}

function AssignProviderModal({
  booking,
  onClose,
  onAssigned,
}: {
  booking: BookingDetail
  onClose: () => void
  onAssigned: () => void
}) {
  const [providerId, setProviderId] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiErrorInfo | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const pid = providerId.trim()
    const r = reason.trim()
    if (!pid || !r) return
    setBusy(true)
    setError(null)
    const res = await adminAssignBookingProvider(booking.id, { providerId: pid, reason: r })
    if (res.status === 200) {
      onAssigned()
    } else {
      setError(parseApiError(res, 'Assignment failed'))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Assign provider"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="modal-title">Assign provider</h3>
        <p className="muted small">
          Manual dispatch override for <span className="mono">{booking.id}</span>.
        </p>
        <div className="form-grid">
          <label className="field-block">
            <span className="field-label">Provider ID</span>
            <input
              ref={inputRef}
              className="field"
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
              placeholder="prv_…"
              required
              aria-required="true"
            />
          </label>
          <label className="field-block">
            <span className="field-label">Reason</span>
            <textarea
              className="field"
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explain why this action is taken (audited)"
              required
              aria-required="true"
            />
          </label>
        </div>
        {error && (
          <>
            <InlineError message={error.message} />
            <p className="muted small">{error.code}</p>
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Working…' : 'Assign'}
          </button>
        </div>
      </form>
    </div>
  )
}

function short(id: string) {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}
