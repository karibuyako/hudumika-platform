import { useEffect, useState } from 'react'
import { getMyCatalogue } from '@hudumika/contract'

interface CatalogueItem {
  id?: string
  name: string
  priceTZS: number
  available: boolean
}

export function CataloguePage() {
  const [items, setItems] = useState<CatalogueItem[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void getMyCatalogue()
      .then((res) => {
        if (cancelled) return
        if (res.status === 200) {
          const data = res.data as { items?: CatalogueItem[] }
          setItems((data.items ?? []).slice(0, 10))
        } else {
          setItems([])
        }
      })
      .catch(() => {
        if (!cancelled) setItems([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="page">
      <div className="page-title-row">
        <div>
          <h1>Catalogue</h1>
          <p className="muted">Items, pricing, and visibility — edits sync to the storefront.</p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button">Add item</button>
        </div>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Price</th>
              <th>Available</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items === null ? (
              <tr><td colSpan={4} style={{ padding: 20, textAlign: 'center' }} className="muted small">Loading…</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={4} style={{ padding: 20, textAlign: 'center' }} className="muted small">No items yet — add your first catalogue item.</td></tr>
            ) : (
              items.map((it, idx) => (
                <tr key={it.id ?? String(idx)}>
                  <td>{it.name}</td>
                  <td className="mono">{it.priceTZS.toLocaleString()} TZS</td>
                  <td>{it.available ? <span className="pill pill-ok">Available</span> : <span className="pill pill-bad">Hidden</span>}</td>
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
