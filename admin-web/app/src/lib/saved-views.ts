/**
 * Saved views — persist DataTable sort + column visibility per table in
 * localStorage so operators can switch between saved configurations without
 * manually re-selecting columns or re-sorting.
 *
 * Key schema: `hudumika.views.{tableId}` → SavedView[]
 */

export interface SavedView {
  name: string
  sortKey: string | null
  sortDir: 'asc' | 'desc'
  visibleKeys: string[] | null
  createdAt: string
}

const PREFIX = 'hudumika.views.'

function keyFor(tableId: string): string {
  return `${PREFIX}${tableId}`
}

/** Load all saved views for a table. Returns [] when empty or on error. */
export function loadSavedViews(tableId: string): SavedView[] {
  try {
    const raw = localStorage.getItem(keyFor(tableId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (v): v is SavedView =>
        typeof v === 'object' &&
        v !== null &&
        typeof (v as SavedView).name === 'string' &&
        typeof (v as SavedView).createdAt === 'string',
    )
  } catch {
    return []
  }
}

/** Save (upsert) a view by name. */
export function saveView(tableId: string, view: SavedView): void {
  const views = loadSavedViews(tableId)
  const idx = views.findIndex((v) => v.name === view.name)
  if (idx >= 0) views[idx] = view
  else views.push(view)
  try {
    localStorage.setItem(keyFor(tableId), JSON.stringify(views))
  } catch {
    // storage unavailable — no-op
  }
}

/** Delete a view by name. */
export function deleteView(tableId: string, name: string): void {
  const views = loadSavedViews(tableId).filter((v) => v.name !== name)
  try {
    localStorage.setItem(keyFor(tableId), JSON.stringify(views))
  } catch {
    // ignore
  }
}
