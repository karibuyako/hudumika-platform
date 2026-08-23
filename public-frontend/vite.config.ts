import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

const API_TARGET = 'https://hudumika-api-production.up.railway.app'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api/v1': { target: API_TARGET, changeOrigin: true, secure: false },
      '/api': { target: API_TARGET, changeOrigin: true, secure: false },
      '/leads': { target: API_TARGET, changeOrigin: true, secure: false, rewrite: (p) => `/api/v1${p}` },
      '/services': { target: API_TARGET, changeOrigin: true, secure: false, rewrite: (p) => `/api/v1${p}` },
    },
  },
  preview: {
    proxy: {
      '/api/v1': { target: API_TARGET, changeOrigin: true, secure: false },
      '/api': { target: API_TARGET, changeOrigin: true, secure: false },
      '/leads': { target: API_TARGET, changeOrigin: true, secure: false, rewrite: (p) => `/api/v1${p}` },
      '/services': { target: API_TARGET, changeOrigin: true, secure: false, rewrite: (p) => `/api/v1${p}` },
    },
  },
})
