export type AdminCreateGeofenceBody = {
  name: string
  type: string
  boundary?: Record<string, unknown>
}
