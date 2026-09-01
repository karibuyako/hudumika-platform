import { useEffect, useRef, useCallback, useState } from 'react'

interface WSMessage {
  type: string
  room?: string
  payload?: any
}

export function useWebSocket(room: string, onMessage: (payload: any) => void) {
  const wsRef = useRef<WebSocket | null>(null)
  const [connected, setConnected] = useState(false)
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage

  useEffect(() => {
    const apiBase = import.meta.env.VITE_ADMIN_API_URL || ''
    const wsBase = apiBase.replace(/^http/, 'ws')
    const ws = new WebSocket(`${wsBase}/api/v1/admin/ws`)
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      ws.send(JSON.stringify({ type: 'subscribe', room }))
    }

    ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data)
        if (msg.room === room && msg.payload) {
          onMessageRef.current(msg.payload)
        }
      } catch {
        // ignore malformed messages
      }
    }

    ws.onclose = () => setConnected(false)
    ws.onerror = () => setConnected(false)

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'unsubscribe', room }))
      }
      ws.close()
    }
  }, [room])

  return { connected, ws: wsRef }
}
