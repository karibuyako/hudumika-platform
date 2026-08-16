export function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="btn" onClick={onClick} type="button">
      Retry
    </button>
  )
}
