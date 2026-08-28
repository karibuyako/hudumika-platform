type Service = { id: string; name: string; price: string; duration: string; active: boolean }

const SERVICES: Service[] = [
  { id: 'SVC-001', name: 'House Cleaning — Standard', price: 'TZS 35,000', duration: '2 hours', active: true },
  { id: 'SVC-002', name: 'House Cleaning — Deep', price: 'TZS 65,000', duration: '4 hours', active: true },
  { id: 'SVC-003', name: 'Plumbing — Fix & Repair', price: 'TZS 40,000', duration: '1.5 hours', active: false },
  { id: 'SVC-004', name: 'AC Service', price: 'TZS 55,000', duration: '2 hours', active: true },
]

export function CataloguePage() {
  return (
    <div className="page">
      <div className="page-title-row">
        <div>
          <h1>Catalogue</h1>
          <p className="muted">Manage your service listings, pricing and availability.</p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button">
            Add service
          </button>
        </div>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Service</th>
              <th>Price</th>
              <th>Duration</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {SERVICES.map((svc) => (
              <tr key={svc.id}>
                <td>
                  <div className="mono-strong">{svc.name}</div>
                  <div className="muted small mono">{svc.id}</div>
                </td>
                <td className="mono">{svc.price}</td>
                <td className="muted small">{svc.duration}</td>
                <td>{svc.active ? <span className="pill pill-ok">Active</span> : <span className="pill pill-muted">Draft</span>}</td>
                <td>
                  <button className="btn btn-ghost" type="button">
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
