/**
 * Time helpers — contract timestamps are UTC ISO 8601; render with local conversion.
 * Never render raw ISO strings in the UI, never assume a locale or timezone.
 */

/**
 * Convert a UTC ISO timestamp to the user's local timezone for display.
 * Returns '—' for null/undefined/invalid input.
 */
export function toLocal(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString()
}

/**
 * Label for snapshot timestamps per spec: "Snapshot <local>".
 */
export function snapshotLabel(iso: string | null | undefined): string {
  return `Snapshot ${toLocal(iso)}`
}
