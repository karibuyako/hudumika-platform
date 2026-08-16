import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  adminGlobalSearch,
  type AdminGlobalSearch200Item,
  type AdminGlobalSearch200ItemEntityType,
} from '@hudumika/contract'
import { toLocal } from '../../lib/time'
import { parseApiError } from '../../lib/api-error'
import { ErrorState } from '../../components/ErrorState'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { EmptyState } from '../../components/EmptyState'
import { FilterChips } from '../../components/FilterChips'
import { StatusPill } from '../../components/StatusPill'
import { InlineError } from '../../components/FormBits'
import { EntityView, statusTone } from './EntityView'

type Filter = 'all' | AdminGlobalSearch200ItemEntityType

const ENTITY_TYPES: AdminGlobalSearch200ItemEntityType[] = [
  'order',
  'shipment',
  'customer',
  'provider',
  'rider',
  'merchant',
  'booking',
  'hub',
  'vehicle',
  'ticket',
  'conversation',
]

const CHIP_OPTIONS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  ...ENTITY_TYPES.map((t) => ({ key: t, label: t })),
]

const PREFIX_HINTS =
  'Prefixes: ORD- order · SHP- shipment · CUS- customer · PRV- provider · RDR- rider · MRC- merchant · JOB- booking'

export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const q = searchParams.get('q') ?? ''
  const [input, setInput] = useState(q)
  const [filter, setFilter] = useState<Filter>('all')
  const [results, setResults] = useState<AdminGlobalSearch200Item[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [inlineError, setInlineError] = useState<string | null>(null)
  const [selected, setSelected] = useState<AdminGlobalSearch200Item | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    if (!q) return
    let cancelled = false
    setResults(null)
    setError(null)
    setInlineError(null)
    adminGlobalSearch({ q, entityTypes: filter === 'all' ? undefined : [filter], limit: 20 }).then((res) => {
      if (cancelled) return
      if (res.status === 200) setResults(res.data)
      else {
        const info = parseApiError(res, 'Search failed')
        if (info.status === 422) setInlineError(`${info.code}: ${info.message}`)
        else setError(`${info.code}: ${info.message}`)
      }
    })
    return () => {
      cancelled = true
    }
  }, [q, filter, retryKey])

  function submit(e: FormEvent) {
    e.preventDefault()
    setSearchParams(input ? { q: input } : {})
  }

  if (error) return <ErrorState title="Failed to search" message={error} onRetry={() => setRetryKey((k) => k + 1)} />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Search</h1>
      </div>

      <form className="toolbar" role="search" onSubmit={submit}>
        <input
          className="topbar-search"
          type="search"
          aria-label="Search"
          placeholder="Search by ID, label, or prefix…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button className="btn" type="submit">
          Search
        </button>
      </form>

      <p className="muted small">{PREFIX_HINTS}</p>

      <FilterChips options={CHIP_OPTIONS} value={filter} onChange={setFilter} ariaLabel="Entity type" />

      {inlineError && <InlineError message={inlineError} />}

      {!q ? (
        <EmptyState title="Search the platform" hint="Type an entity ID or a prefix to find orders, shipments, customers and more." />
      ) : !results ? (
        <LoadingSkeleton kind="table" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Label</th>
              <th>ID</th>
              <th>Status</th>
              <th>Region</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {results.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  <EmptyState
                    title="No matches"
                    hint="Try an entity ID prefix — e.g. ORD- for orders, SHP- for shipments, CUS- for customers."
                  />
                </td>
              </tr>
            )}
            {results.map((item) => (
              <tr key={`${item.entityType}:${item.id}`} className="row-click" onClick={() => setSelected(item)}>
                <td>
                  <span className="tag">{item.entityType}</span>
                </td>
                <td>{item.label}</td>
                <td>
                  <span className="mono">{item.id}</span>
                </td>
                <td>{item.status ? <StatusPill status={item.status} tone={statusTone(item.status)} /> : '—'}</td>
                <td>{item.region ?? '—'}</td>
                <td className="muted">{toLocal(item.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selected && <EntityView item={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
