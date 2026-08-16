import { http, HttpResponse } from 'msw'
import { SERVICE_GROUPS, HOME_SERVICES } from '@/data/constants'

const leads: Array<Record<string, unknown>> = []

export const handlers = [
  http.get('/api/services', () =>
    HttpResponse.json({ groups: SERVICE_GROUPS, homeServices: HOME_SERVICES }),
  ),

  http.post('/api/leads', async ({ request }) => {
    const payload = (await request.json()) as Record<string, unknown>
    const lead = { id: `lead_${Date.now()}`, ...payload, createdAt: new Date().toISOString() }
    leads.push(lead)
    return HttpResponse.json({ lead }, { status: 201 })
  }),

  http.post('/api/orders', async ({ request }) => {
    const payload = await request.json()
    return HttpResponse.json(
      { order: { id: `order_${Date.now()}`, status: 'pending', payload } },
      { status: 201 },
    )
  }),

  http.post('/api/bookings', async ({ request }) => {
    const payload = await request.json()
    return HttpResponse.json(
      { booking: { id: `booking_${Date.now()}`, status: 'pending_provider_confirmation', payload } },
      { status: 201 },
    )
  }),

  http.post('/api/auth/request-otp', async ({ request }) => {
    const payload = await request.json()
    return HttpResponse.json({ accepted: true, channel: 'mock', payload })
  }),
]
