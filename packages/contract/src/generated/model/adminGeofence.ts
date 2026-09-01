export type AdminGeofence = {
  id: string
  name: string
  type: string
  active: boolean
  boundary?: Record<string, unknown>
  createdAt: string
}
