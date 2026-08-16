export async function submitLead(payload: Record<string, unknown>) {
  const response = await fetch('/api/leads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) throw new Error('Lead submission failed')
  return response.json()
}

export async function fetchServices() {
  const response = await fetch('/api/services')
  if (!response.ok) throw new Error('Service catalog unavailable')
  return response.json()
}
