export function EarningsPage() {
  return (
    <div className="page">
      <div className="page-title-row">
        <div>
          <h1>Earnings</h1>
          <p className="muted">Track payouts, pending balances and transaction history.</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-ghost" type="button">
            Export CSV
          </button>
        </div>
      </div>

      <div className="cards">
        <div className="stat-card success">
          <div className="stat-value">TZS 1,240,500</div>
          <div className="stat-label">Available balance</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">TZS 280,000</div>
          <div className="stat-label">Pending</div>
          <div className="stat-sub">3 bookings awaiting payout</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">TZS 4,120,000</div>
          <div className="stat-label">Total earned (30d)</div>
        </div>
      </div>

      <h2>Recent payouts</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Payout</th>
              <th>Booking</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono-strong">PO-9981</td>
              <td className="mono">BK-10440</td>
              <td className="mono">TZS 60,000</td>
              <td>
                <span className="pill pill-ok">Settled</span>
              </td>
              <td className="muted small">2026-08-26 18:20</td>
            </tr>
            <tr>
              <td className="mono-strong">PO-9974</td>
              <td className="mono">BK-10421</td>
              <td className="mono">TZS 30,000</td>
              <td>
                <span className="pill pill-warn">Pending</span>
              </td>
              <td className="muted small">2026-08-27 09:12</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
