import { useEffect, useState } from 'react'
import { getMyMerchant } from '@hudumika/contract'

export function OverviewPage() {
  const [merchantName, setMerchantName] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getMyMerchant()
      .then((res) => {
        if (cancelled) return
        if (res.status === 200) {
          const data = res.data as { businessName?: string }
          setMerchantName(data.businessName ?? 'Your store')
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="muted">Daily pulse for {merchantName ?? 'your merchant workspace'} — orders, catalogue, and earnings at a glance.</p>
        </div>
      </div>

      <div className="cards">
        <div className="stat-card">
          <div className="stat-value">—</div>
          <div className="stat-label">Today&apos;s orders</div>
          <div className="stat-sub">Live once the backend connects</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">—</div>
          <div className="stat-label">Pending fulfilment</div>
          <div className="stat-sub">Orders awaiting acceptance</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">—</div>
          <div className="stat-label">Catalogue items</div>
          <div className="stat-sub">Managed in Catalogue</div>
        </div>
        <div className="stat-card success">
          <div className="stat-value">—</div>
          <div className="stat-label">Earnings (7d)</div>
          <div className="stat-sub">Settled via payouts</div>
        </div>
      </div>

      <h2>Getting started</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Area</th>
              <th>Description</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Orders</td>
              <td>Accept, prepare, and hand off orders to riders</td>
              <td><span className="pill pill-muted">Mock</span></td>
            </tr>
            <tr>
              <td>Catalogue</td>
              <td>Manage items, prices, and availability</td>
              <td><span className="pill pill-muted">Mock</span></td>
            </tr>
            <tr>
              <td>Availability</td>
              <td>Store hours, closures, and stock sync</td>
              <td><span className="pill pill-muted">Mock</span></td>
            </tr>
            <tr>
              <td>Earnings</td>
              <td>Wallet, payouts, and statements</td>
              <td><span className="pill pill-muted">Mock</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
