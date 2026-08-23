import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const GATEWAY_URL = 'https://hudumika-api-production.up.railway.app'

const API_PROXY = {
  '^/(admin|auth|api|ws|provider|merchant|rider|public|bookings|catalogues|orders|payments|users|services|reviews|notifications|finance|marketing|events|search|support|travel|hotels|assistant|cities|payouts|healthz|docs|openapi.json)':
    {
      target: GATEWAY_URL,
      changeOrigin: true,
      secure: false,
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