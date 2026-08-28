import { useEffect, useState } from 'react'
import { getMerchantWallet } from '@hudumika/contract'

export function EarningsPage() {
  const [wallet, setWallet] = useState<{ withdrawableTZS: number; pendingTZS?: number; totalTZS: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    void getMerchantWallet()
      .then((res) => {
        if (cancelled) return
        if (res.status === 200) {
          setWallet(res.data as { withdrawableTZS: number; pendingTZS?: number; totalTZS: number })
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="page">
      <h1>Earnings</h1>
      <p className="muted">Wallet, pending settlement, and payout history.</p>

      <div className="cards">
        <div className="stat-card success">
          <div className="stat-value">{wallet ? `${wallet.withdrawableTZS.toLocaleString()} TZS` : '—'}</div>
          <div className="stat-label">Withdrawable</div>
          <div className="stat-sub">Ready for payout</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{wallet?.pendingTZS != null ? `${wallet.pendingTZS.toLocaleString()} TZS` : '—'}</div>
          <div className="stat-label">Pending</div>
          <div className="stat-sub">In settlement</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{wallet ? `${wallet.totalTZS.toLocaleString()} TZS` : '—'}</div>
          <div className="stat-label">Total earned</div>
          <div className="stat-sub">Lifetime</div>
        </div>
      </div>

      <h2>Payouts</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Payout</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono">—</td>
              <td className="mono">—</td>
              <td><span className="pill pill-muted">No history</span></td>
              <td className="muted small">—</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
