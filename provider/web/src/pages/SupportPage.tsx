export function SupportPage() {
  return (
    <div className="page">
      <div className="page-title-row">
        <div>
          <h1>Support</h1>
          <p className="muted">Get help with bookings, payouts and account issues.</p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button">
            Open ticket
          </button>
        </div>
      </div>

      <div className="queue-list">
        <div className="queue-item">
          <div className="queue-main">
            <strong>Contact provider support</strong>
            <span className="muted small">Chat with our Ops team 08:00–20:00 EAT · response in ~10 minutes</span>
          </div>
          <button className="btn btn-ghost" type="button">
            Start chat
          </button>
        </div>
        <div className="queue-item">
          <div className="queue-main">
            <strong>Help center</strong>
            <span className="muted small">Guides on bookings, cancellations, payouts and dispute flow</span>
          </div>
          <a className="btn btn-ghost" href="#" onClick={(e) => e.preventDefault()}>
            Browse articles
          </a>
        </div>
      </div>

      <h2>Recent tickets</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Ticket</th>
              <th>Subject</th>
              <th>Status</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono-strong">TK-4421</td>
              <td>Payout not received for BK-10421</td>
              <td>
                <span className="pill pill-warn">Open</span>
              </td>
              <td className="muted small">2026-08-27 14:10</td>
            </tr>
            <tr>
              <td className="mono-strong">TK-4398</td>
              <td>Customer no-show dispute</td>
              <td>
                <span className="pill pill-ok">Resolved</span>
              </td>
              <td className="muted small">2026-08-22 09:00</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
