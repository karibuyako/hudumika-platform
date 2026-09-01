import { useCallback, useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { EmptyState } from './EmptyState'
import { InlineError } from './FormBits'
import { LoadingSkeleton } from './LoadingSkeleton'
import { Pagination } from './Pagination'
import { downloadCsv, toCsv } from '../lib/csv'
import { deleteView, loadSavedViews, saveView, type SavedView } from '../lib/saved-views'

export interface DataTableColumn<T> {
  key: string
  header: string
  render: (row: T) => ReactNode
  sortValue?: (row: T) => string | number | null
  align?: 'left' | 'right'
  className?: string
}

export interface DataTableProps<T> {
  rows: T[]
  columns: DataTableColumn<T>[]
  rowKey: (row: T) => string
  onRowClick?: (row: T) => void
  selectedRowKey?: string | null
  loading?: boolean
  emptyTitle?: string
  emptyHint?: string
  error?: string | null
  onRetry?: () => void
  exportable?: boolean
  exportFileName?: string
  exportCell?: (row: T) => string | number | null
  pageSize?: number
  ariaLabel?: string
  /** Stable identifier enabling per-table column visibility (persisted in sessionStorage). */
  tableId?: string
}

type SortDir = 'asc' | 'desc'

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  selectedRowKey,
  loading,
  emptyTitle,
  emptyHint,
  error,
  onRetry,
  exportable,
  exportFileName,
  exportCell,
  pageSize,
  ariaLabel,
  tableId,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [page, setPage] = useState(1)
  const [focusIndex, setFocusIndex] = useState<number | null>(null)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [viewsOpen, setViewsOpen] = useState(false)
  const [savedViews, setSavedViews] = useState<SavedView[]>(() =>
    tableId ? loadSavedViews(tableId) : [],
  )
  const [saveName, setSaveName] = useState('')
  const [visibleKeys, setVisibleKeys] = useState<string[] | null>(() => {
    if (!tableId) return null
    try {
      const raw = sessionStorage.getItem(`hudumika.columns.${tableId}`)
      if (!raw) return null
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return null
      return parsed.filter((k): k is string => typeof k === 'string')
    } catch {
      return null
    }
  })

  const size = Math.max(1, pageSize ?? 20)
  const label = ariaLabel ?? 'data-table'

  const visibleColumns = useMemo(() => {
    if (!visibleKeys || visibleKeys.length === 0) return columns
    const visible = columns.filter((c) => visibleKeys.includes(c.key))
    return visible.length >= 1 ? visible : columns
  }, [columns, visibleKeys])

  function toggleColumn(key: string) {
    setVisibleKeys((prev) => {
      const current = prev && prev.length > 0 ? prev : columns.map((c) => c.key)
      const isVisible = current.includes(key)
      if (isVisible && current.length <= 1) return prev ?? current
      const next = isVisible ? current.filter((k) => k !== key) : [...current, key]
      if (tableId) {
        try {
          sessionStorage.setItem(`hudumika.columns.${tableId}`, JSON.stringify(next))
        } catch {
          // storage unavailable — visibility still applies for this render
        }
      }
      return next
    })
  }

  const refreshViews = useCallback(() => {
    if (tableId) setSavedViews(loadSavedViews(tableId))
  }, [tableId])

  function loadView(view: SavedView) {
    setSortKey(view.sortKey)
    setSortDir(view.sortDir)
    setVisibleKeys(view.visibleKeys)
    setPage(1)
    setFocusIndex(null)
    if (tableId) {
      try {
        sessionStorage.setItem(`hudumika.columns.${tableId}`, JSON.stringify(view.visibleKeys ?? columns.map((c) => c.key)))
      } catch {
        // ignore
      }
    }
    setViewsOpen(false)
  }

  function saveCurrentView() {
    const name = saveName.trim()
    if (!name || !tableId) return
    saveView(tableId, {
      name,
      sortKey,
      sortDir,
      visibleKeys,
      createdAt: new Date().toISOString(),
    })
    setSaveName('')
    refreshViews()
  }

  function deleteSavedView(name: string) {
    if (!tableId) return
    deleteView(tableId, name)
    refreshViews()
  }

  useEffect(() => {
    setPage(1)
  }, [rows.length])

  const sorted = useMemo(() => {
    if (!sortKey) return rows
    const column = columns.find((c) => c.key === sortKey)
    if (!column?.sortValue) return rows
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = column.sortValue!(a)
      const bv = column.sortValue!(b)
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av).localeCompare(String(bv)) * dir
    })
  }, [rows, sortKey, sortDir, columns])

  const totalPages = Math.max(1, Math.ceil(sorted.length / size))
  const currentPage = Math.min(Math.max(1, page), totalPages)
  const visible = sorted.slice((currentPage - 1) * size, currentPage * size)

  function toggleSort(column: DataTableColumn<T>) {
    if (sortKey !== column.key) {
      setSortKey(column.key)
      setSortDir('asc')
    } else {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    }
    setPage(1)
    setFocusIndex(null)
  }

  function handleExport() {
    const headers = visibleColumns.map((c) => c.header)
    const data = sorted.map((row) =>
      visibleColumns.map((column) => {
        if (exportCell) return exportCell(row)
        const rendered = column.render(row)
        if (typeof rendered === 'string' || typeof rendered === 'number') return rendered
        return null
      }),
    )
    downloadCsv(exportFileName ?? 'export', toCsv(headers, data))
    window.dispatchEvent(
      new CustomEvent('hudumika.export', {
        detail: { filename: exportFileName ?? 'export', rowCount: sorted.length },
      }),
    )
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTableElement>) {
    if (exportable && (e.key === 'e' || e.key === 'E')) {
      e.preventDefault()
      handleExport()
      return
    }
    if (visible.length === 0) return
    if (e.key === 'j' || e.key === 'J') {
      e.preventDefault()
      setFocusIndex((i) => (i == null ? 0 : Math.min(i + 1, visible.length - 1)))
    } else if (e.key === 'k' || e.key === 'K') {
      e.preventDefault()
      setFocusIndex((i) => (i == null ? visible.length - 1 : Math.max(i - 1, 0)))
    } else if ((e.key === 'Enter' || e.key === ' ') && onRowClick && focusIndex != null && visible[focusIndex]) {
      e.preventDefault()
      onRowClick(visible[focusIndex])
    }
  }

  const activeDescendant = focusIndex != null && visible[focusIndex] ? `${label}-row-${rowKey(visible[focusIndex])}` : undefined

  return (
    <div>
      {(exportable || tableId) && (
        <div className="toolbar">
          {exportable && (
            <button className="btn" type="button" onClick={handleExport}>
              Export CSV
            </button>
          )}
          {tableId && (
            <>
              <button
                className="btn"
                type="button"
                aria-label="Toggle columns"
                aria-expanded={columnsOpen}
                onClick={() => setColumnsOpen((o) => !o)}
              >
                Columns
              </button>
              <button
                className="btn"
                type="button"
                aria-label="Toggle saved views"
                aria-expanded={viewsOpen}
                onClick={() => setViewsOpen((o) => !o)}
              >
                Saved views
              </button>
            </>
          )}
        </div>
      )}
      {tableId && columnsOpen && (
        <div className="state-card">
          <div className="state-title">Columns</div>
          {columns.map((column) => (
            <label key={column.key} className="field-block">
              <input
                type="checkbox"
                checked={visibleColumns.some((c) => c.key === column.key)}
                aria-label={`Show ${column.header} column`}
                onChange={() => toggleColumn(column.key)}
              />{' '}
              {column.header}
            </label>
          ))}
        </div>
      )}
      {tableId && viewsOpen && (
        <div className="state-card">
          <div className="state-title">Saved views</div>
          <form
            className="toolbar"
            onSubmit={(e) => {
              e.preventDefault()
              saveCurrentView()
            }}
          >
            <label className="field-label" htmlFor={`save-view-${tableId}`}>
              View name
            </label>
            <input
              id={`save-view-${tableId}`}
              className="field"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="e.g. High-value orders"
              required
            />
            <button className="btn" type="submit" disabled={!saveName.trim()}>
              Save
            </button>
          </form>
          {savedViews.length === 0 ? (
            <div className="muted small">No saved views yet.</div>
          ) : (
            <div className="rider-list">
              {savedViews.map((v) => (
                <div key={v.name} className="rider-card">
                  <div className="rider-line">
                    <span className="strong">{v.name}</span>
                    <button
                      className="btn btn-ghost"
                      type="button"
                      onClick={() => deleteSavedView(v.name)}
                    >
                      Delete
                    </button>
                  </div>
                  <button className="muted small" type="button" onClick={() => loadView(v)}>
                    {v.sortKey ? `sort ${v.sortKey} ${v.sortDir}` : 'no sort'} · {v.visibleKeys ? `${v.visibleKeys.length} cols` : 'all cols'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {loading && rows.length === 0 ? (
        <LoadingSkeleton kind="table" />
      ) : (
        <table className="table" tabIndex={-1} onKeyDown={handleKeyDown} aria-label={label}>
          <thead>
            <tr>
              {visibleColumns.map((column) => {
                const sortedBy = sortKey === column.key
                return (
                  <th
                    key={column.key}
                    aria-sort={sortedBy ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                  >
                    {column.sortValue ? (
                      <span
                        className="row-click"
                        role="button"
                        tabIndex={0}
                        onClick={() => toggleSort(column)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            toggleSort(column)
                          }
                        }}
                      >
                        {column.header}
                        {sortedBy ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                      </span>
                    ) : (
                      column.header
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody aria-activedescendant={activeDescendant}>
            {error && (
              <tr>
                <td colSpan={visibleColumns.length}>
                  <InlineError message={error} />
                  {onRetry && (
                    <button className="btn" type="button" onClick={onRetry}>
                      Retry
                    </button>
                  )}
                </td>
              </tr>
            )}
            {!error && visible.length === 0 && (
              <tr>
                <td colSpan={visibleColumns.length} className="muted">
                  <EmptyState title={emptyTitle ?? 'No results'} hint={emptyHint} />
                </td>
              </tr>
            )}
            {visible.map((row, index) => {
              const key = rowKey(row)
              const classes = [
                onRowClick ? 'row-click' : '',
                selectedRowKey === key ? 'row-selected' : '',
              ]
                .filter(Boolean)
                .join(' ')
              return (
                <tr
                  key={key}
                  id={`${label}-row-${key}`}
                  data-rowindex={index}
                  className={classes || undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {visibleColumns.map((column) => (
                    <td
                      key={column.key}
                      className={column.className}
                      style={column.align === 'right' ? { textAlign: 'right' } : undefined}
                    >
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {!loading && totalPages > 1 && (
        <Pagination page={currentPage} pageSize={size} total={sorted.length} onPageChange={setPage} />
      )}
    </div>
  )
}
