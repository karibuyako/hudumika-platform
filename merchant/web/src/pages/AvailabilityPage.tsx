import { useEffect, useState } from 'react'
import { getMyStoreSettings } from '@hudumika/contract'

export function AvailabilityPage() {
  const [status, setStatus] = useState<string>('Loading…')

  useEffect(() => {
    let cancelled = false
    void getMyStoreSettings()
      .then((res) => {
        if (cancelled) return
        if (res.status === 200) {
          const data = res.data as { isOpen?: boolean; hours?: unknown }
          setStatus(data.isOpen ? 'Open' : 'Closed')
        } else {
          setStatus('Unknown — configure your store hours')
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('Unavailable offline')
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="page">
      <h1>Availability</h1>
      <p className="muted">Store hours, temporary closures, and stock sync. Current status: <strong>{status}</strong></p>

      <div className="cards">
        <div className="stat-card">
          <div className="stat-label">Store hours</div>
          <div className="stat-value" style={{ fontSize: 16 }}>09:00 — 21:00</div>
          <div className="stat-sub">Edit in Settings</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Temporary closure</div>
          <div className="stat-value" style={{ fontSize: 16 }}>None</div>
          <div className="stat-sub">Add closure in Settings</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Inventory sync</div>
          <div className="stat-value" style={{ fontSize: 16 }}>Mock</div>
          <div className="stat-sub">Connect POS to sync stock</div>
        </div>
      </div>

      <h2>Controls</h2>
      <div className="queue-list">
        <div className="queue-item">
          <div className="queue-main">
            <div className="strong">Open / Close store</div>
            <div className="muted small">Immediately reflects on the customer app</div>
          </div>
          <div className="queue-actions">
            <button className="btn" type="button">Toggle</button>
          </div>
        </div>
        <div className="queue-item">
          <div className="queue-main">
            <div className="strong">Catalogue availability</div>
            <div className="muted small">Hide sold-out items or show as sold out</div>
          </div>
          <div className="queue-actions">
            <button className="btn btn-ghost" type="button">Manage</button>
          </div>
        </div>
      </div>
    </div>
  )
}
