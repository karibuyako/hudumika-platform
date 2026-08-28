export function NotificationsPage() {
  const items = [
    { id: 'N-301', title: 'New booking request', body: 'BK-10482 — House cleaning — Msasani — 11:30 AM today', time: '10 min ago', unread: true },
    { id: 'N-299', title: 'Payout settled', body: 'PO-9981 credited TZS 60,000 for BK-10440', time: '2 hours ago', unread: false },
    { id: 'N-298', title: 'Customer message', body: 'Asha K.: “Please bring extra cleaning supplies”', time: '5 hours ago', unread: true },
  ]

  return (
    <div className="page">
      <div className="page-title-row">
        <div>
          <h1>Notifications</h1>
          <p className="muted">Inbox for booking updates and system alerts.</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-ghost" type="button">
            Mark all read
          </button>
        </div>
      </div>

      <div className="queue-list">
        {items.map((n) => (
          <div key={n.id} className="queue-item">
            <div className="queue-main">
              <strong>
                {n.title} {n.unread && <span className="pill pill-info">New</span>}
              </strong>
              <span className="muted small">{n.body}</span>
              <span className="muted small mono">{n.id} · {n.time}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
