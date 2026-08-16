interface PaginationProps {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}

export function Pagination({ page, pageSize, total, onPageChange }: PaginationProps) {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)))
  const current = Math.min(Math.max(1, page), pages)
  return (
    <div className="pagination">
      <span>
        Page {current} of {pages}
      </span>
      <div className="pagination-actions">
        <button className="btn" type="button" disabled={current <= 1} onClick={() => onPageChange(current - 1)}>
          Prev
        </button>
        <button className="btn" type="button" disabled={current >= pages} onClick={() => onPageChange(current + 1)}>
          Next
        </button>
      </div>
    </div>
  )
}
