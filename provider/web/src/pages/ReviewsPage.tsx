export function ReviewsPage() {
  const reviews = [
    { id: 'RV-201', author: 'Asha K.', rating: 5, comment: 'Excellent service, very professional!', date: '2026-08-27', booking: 'BK-10440' },
    { id: 'RV-198', author: 'John M.', rating: 4, comment: 'Good work, arrived on time.', date: '2026-08-24', booking: 'BK-10421' },
    { id: 'RV-195', author: 'Rehema S.', rating: 5, comment: 'Highly recommended!', date: '2026-08-20', booking: 'BK-10390' },
  ]

  return (
    <div className="page">
      <div className="page-title-row">
        <div>
          <h1>Reviews</h1>
          <p className="muted">Customer feedback on your completed bookings.</p>
        </div>
      </div>

      <div className="kpi">
        <div className="stat-card">
          <div className="stat-value">4.8</div>
          <div className="stat-label">Average rating</div>
          <div className="stat-sub">312 total</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">98%</div>
          <div className="stat-label">Completion rate</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">12</div>
          <div className="stat-label">Reviews this month</div>
        </div>
      </div>

      <div className="queue-list">
        {reviews.map((r) => (
          <div key={r.id} className="queue-item">
            <div className="queue-main">
              <strong>
                {r.author} · {'★'.repeat(r.rating)}
                <span className="muted"> {'☆'.repeat(5 - r.rating)}</span>
              </strong>
              <span className="muted small">{r.comment}</span>
              <span className="muted small mono">
                {r.id} · {r.booking} · {r.date}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
