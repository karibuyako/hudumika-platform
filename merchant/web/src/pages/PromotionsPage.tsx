import { useEffect, useState } from 'react'
import { listMerchantPromotions } from '@hudumika/contract'

interface PromoRow {
  id?: string
  title: string
  status: string
  type?: string
}

export function PromotionsPage() {
  const [rows, setRows] = useState<PromoRow[] | null>(null)

  useEffect(() => {
    let cancelled = false
    // merchantId is required by contract type but mock ignores it
    const params = { merchantId: 'me' } as unknown as Parameters<typeof listMerchantPromotions>[0]
    void listMerchantPromotions(params)
      .then((res) => {
        if (cancelled) return
        if (res.status === 200) {
          const data = res.data as unknown
          const list = Array.isArray(data) ? (data as PromoRow[]) : []
          setRows(list.slice(0, 8))
        } else {
          setRows([])
        }
      })
      .catch(() => {
        if (!cancelled) setRows([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="page">
      <div className="page-title-row">
        <div>
          <h1>Promotions</h1>
          <p className="muted">Discounts, bundles, and group buys — drive repeat orders.</p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button">Create promotion</button>
        </div>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Type</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows === null ? (
              <tr><td colSpan={4} style={{ padding: 20, textAlign: 'center' }} className="muted small">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={4} style={{ padding: 20, textAlign: 'center' }} className="muted small">No promotions yet — create your first offer.</td></tr>
            ) : (
              rows.map((p, idx) => (
                <tr key={p.id ?? String(idx)}>
                  <td>{p.title}</td>
                  <td className="muted small">{p.type ?? '—'}</td>
                  <td><span className="pill pill-info">{p.status}</span></td>
                  <td><button className="btn btn-ghost" type="button">Edit</button></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
