import { Link } from 'react-router-dom'

export function NotFoundPage() {
  return (
    <div className="state-card" role="alert">
      <div className="state-title">Page not found</div>
      <div className="state-message">The page you requested does not exist or you do not have access.</div>
      <Link to="/" className="btn" style={{ display: 'inline-block', textDecoration: 'none' }}>
        Back to Control Tower
      </Link>
    </div>
  )
}
