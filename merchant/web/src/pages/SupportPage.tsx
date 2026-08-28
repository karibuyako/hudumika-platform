export function SupportPage() {
  return (
    <div className="page">
      <h1>Support</h1>
      <p className="muted">Help, announcements, and tickets for your merchant account.</p>

      <div className="cards">
        <div className="stat-card">
          <div className="stat-label">Open tickets</div>
          <div className="stat-value">0</div>
          <div className="stat-sub">No active issues</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Help articles</div>
          <div className="stat-value">—</div>
          <div className="stat-sub">Knowledge base</div>
        </div>
      </div>

      <h2>Contact</h2>
      <div className="queue-list">
        <div className="queue-item">
          <div className="queue-main">
            <div className="strong">Report an issue</div>
            <div className="muted small">Order, payout, or catalogue problem — we respond within hours.</div>
          </div>
          <div className="queue-actions">
            <button className="btn" type="button">New ticket</button>
          </div>
        </div>
        <div className="queue-item">
          <div className="queue-main">
            <div className="strong">Announcements</div>
            <div className="muted small">Platform updates, fee changes, and policy notices.</div>
          </div>
          <div className="queue-actions">
            <button className="btn btn-ghost" type="button">View</button>
          </div>
        </div>
      </div>
    </div>
  )
}
