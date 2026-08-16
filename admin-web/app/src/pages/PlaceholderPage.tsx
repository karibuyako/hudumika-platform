export function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="page">
      <h1>{title}</h1>
      <p className="muted">Module scaffold — implementation follows in the admin-module sprints.</p>
    </div>
  )
}