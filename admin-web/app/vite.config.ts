import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const RAILWAY_PROD = 'https://hudumika-api-production.up.railway.app'

// Per admin-web/DEPLOYMENT.md and docs/API-BASE-CONVENTION.md the live API is
// injected via VITE_ADMIN_API_URL. The dev proxy falls back to Railway prod
// so `VITE_USE_MOCKS=false` works locally without extra env.
const PROXY_TARGET = process.env.VITE_ADMIN_API_URL?.replace(/\/api\/v1\/?$/, '') || RAILWAY_PROD

const API_PROXY = {
  '^/(admin|auth|api|ws|provider|merchant|rider|public|bookings|catalogues|orders|payments|users|services|reviews|notifications|finance|marketing|events|search|support|travel|hotels|assistant|cities|payouts|healthz|docs|openapi.json)':
    {
      target: PROXY_TARGET,
      changeOrigin: true,
      secure: true,
    },
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4173,
    proxy: API_PROXY,
  },
  preview: {
    proxy: API_PROXY,
  },
})