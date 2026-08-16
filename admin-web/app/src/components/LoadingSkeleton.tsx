interface LoadingSkeletonProps {
  kind?: 'stats' | 'table' | 'list' | 'cards'
  rows?: number
}

export function LoadingSkeleton({ kind = 'table', rows = 5 }: LoadingSkeletonProps) {
  if (kind === 'stats') {
    return (
      <div className="cards" aria-busy="true" aria-label="Loading">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="stat-card skeleton" />
        ))}
      </div>
    )
  }
  if (kind === 'cards') {
    return (
      <div className="cards" aria-busy="true" aria-label="Loading">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="stat-card skeleton" style={{ height: 96 }} />
        ))}
      </div>
    )
  }
  return (
    <table className="table" aria-busy="true" aria-label="Loading">
      <tbody>
        {Array.from({ length: rows }).map((_, i) => (
          <tr key={i}>
            {Array.from({ length: 5 }).map((__, j) => (
              <td key={j}>
                <span className="skeleton-line" style={{ width: `${55 + ((i * 13 + j * 29) % 40)}%` }} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
