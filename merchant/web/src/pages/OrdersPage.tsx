import { useEffect, useState } from 'react'
import { searchOrders } from '@hudumika/contract'

interface OrderRow {
  id: string
  status: string
  totalTZS: number
}

export function OrdersPage() {
  const [rows, setRows] = useState<OrderRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await searchOrders({ limit: 20 })
        if (cancelled) return
        if (res.status === 200) {
          const data = res.data as unknown
          // contract mock may return array or { items: [] } — normalize
          const list = Array.isArray(data) ? (data as OrderRow[]) : (data as { items?: OrderRow[] })?.items ?? []
          setRows(list.slice(0, 8).map((o, i) => ({ id: (o as unknown as { id?: string })?.id ?? `ORD-${String(i + 1).padStart(4, '0')}`, status: (o as unknown as { status?: string })?.status ?? 'pending', totalTZS: (o as unknown as { totalTZS?: number })?.totalTZS ?? 0 })))
        } else {
          setRows([])
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load orders')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="page">
      <div className="page-title-row">
        <div>
          <h1>Orders</h1>
          <p className="muted">Incoming orders to accept, prepare, and hand off. Mock-backed via MSW in development.</p>
        </div>
        <div className="page-actions">
          <span className="pill pill-brand">Mock</span>
        </div>
      </div>

      {error && <div className="inline-error">{error}</div>}

      <div className="toolbar">
        <input className="topbar-search" placeholder="Search order ID or customer" aria-label="Search orders" />
        <div className="toolbar-spacer" />
        <button className="btn btn-ghost" type="button">Export</button>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Status</th>
              <th>Total</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows === null ? (
              <tr>
                <td colSpan={4} className="muted small" style={{ padding: 20, textAlign: 'center' }}>Loading…</td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted small" style={{ padding: 20, textAlign: 'center' }}>No orders yet — new orders will appear here.</td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="mono">{row.id}</td>
                  <td><span className="pill pill-info">{row.status}</span></td>
                  <td className="mono">{row.totalTZS.toLocaleString()} TZS</td>
                  <td><button className="btn" type="button">View</button></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
