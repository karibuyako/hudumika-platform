export function CustomersPage() {
  return (
    <div className="page">
      <h1>Customers</h1>
      <p className="muted">Repeat buyers, order history, and support context for your store.</p>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Orders</th>
              <th>Last order</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>—</td>
              <td className="mono">—</td>
              <td className="muted small">No customer data yet</td>
              <td><button className="btn btn-ghost" type="button" disabled>View</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="muted small">Customer insights will appear once orders flow through your store.</p>
    </div>
  )
}
