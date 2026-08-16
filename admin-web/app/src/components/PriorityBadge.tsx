import type { OrderDetail } from '@hudumika/contract'

export function PriorityBadge({ priority }: { priority?: OrderDetail['priority'] }) {
  if (!priority || priority === 'normal') return null
  return <span className={`badge ${priority}`}>{priority}</span>
}
