import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useWebSocket } from './useWebSocket'

vi.stubEnv('VITE_ADMIN_API_URL', '')

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  static instances: MockWebSocket[] = []
  url: string
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  readyState = 0
  sentMessages: string[] = []

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sentMessages.push(data)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close'))
  }

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  simulateMessage(data: string) {
    this.onmessage?.(new MessageEvent('message', { data }))
  }
}

const origDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')

beforeEach(() => {
  MockWebSocket.instances = []
  Object.defineProperty(globalThis, 'WebSocket', {
    value: MockWebSocket,
    writable: true,
    configurable: true,
  })
})

afterEach(() => {
  MockWebSocket.instances = []
  if (origDescriptor) {
    Object.defineProperty(globalThis, 'WebSocket', origDescriptor)
  }
})

describe('useWebSocket', () => {
  it('connects and subscribes to room on open', async () => {
    const onMessage = vi.fn()
    renderHook(() => useWebSocket('map:rider-positions', onMessage))

    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1)
    })

    const ws = MockWebSocket.instances[0]
    act(() => {
      ws.simulateOpen()
    })

    expect(ws.sentMessages).toContain(
      JSON.stringify({ type: 'subscribe', room: 'map:rider-positions' }),
    )
  })

  it('calls onMessage when matching room message arrives', async () => {
    const onMessage = vi.fn()
    renderHook(() => useWebSocket('map:rider-positions', onMessage))

    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1)
    })

    const ws = MockWebSocket.instances[0]
    act(() => {
      ws.simulateOpen()
    })

    act(() => {
      ws.simulateMessage(
        JSON.stringify({ type: 'rider-positions', room: 'map:rider-positions', payload: [] }),
      )
    })

    expect(onMessage).toHaveBeenCalledWith([])
  })

  it('ignores messages for other rooms', async () => {
    const onMessage = vi.fn()
    renderHook(() => useWebSocket('map:rider-positions', onMessage))

    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1)
    })

    const ws = MockWebSocket.instances[0]
    act(() => {
      ws.simulateOpen()
    })

    act(() => {
      ws.simulateMessage(
        JSON.stringify({ type: 'traffic', room: 'map:traffic', payload: {} }),
      )
    })

    expect(onMessage).not.toHaveBeenCalled()
  })

  it('unsubscribes and closes on unmount', async () => {
    const onMessage = vi.fn()
    const { unmount } = renderHook(() => useWebSocket('map:rider-positions', onMessage))

    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1)
    })

    const ws = MockWebSocket.instances[0]
    act(() => {
      ws.simulateOpen()
    })

    const closeSpy = vi.spyOn(ws, 'close')

    unmount()

    expect(ws.sentMessages).toContain(
      JSON.stringify({ type: 'unsubscribe', room: 'map:rider-positions' }),
    )
    expect(closeSpy).toHaveBeenCalled()
  })

  it('does not send unsubscribe if not connected on unmount', async () => {
    const onMessage = vi.fn()
    const { unmount } = renderHook(() => useWebSocket('map:rider-positions', onMessage))

    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1)
    })

    const ws = MockWebSocket.instances[0]
    const sendSpy = vi.spyOn(ws, 'send')

    unmount()

    expect(sendSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('"type":"unsubscribe"'),
    )
  })

  it('tracks connected state', async () => {
    const onMessage = vi.fn()
    const { result } = renderHook(() => useWebSocket('map:rider-positions', onMessage))

    expect(result.current.connected).toBe(false)

    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1)
    })

    act(() => {
      MockWebSocket.instances[0].simulateOpen()
    })

    expect(result.current.connected).toBe(true)
  })

  it('sets connected to false on close', async () => {
    const onMessage = vi.fn()
    const { result } = renderHook(() => useWebSocket('map:rider-positions', onMessage))

    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1)
    })

    const ws = MockWebSocket.instances[0]
    act(() => {
      ws.simulateOpen()
    })

    expect(result.current.connected).toBe(true)

    act(() => {
      ws.close()
    })

    expect(result.current.connected).toBe(false)
  })

  it('ignores malformed messages without crashing', async () => {
    const onMessage = vi.fn()
    renderHook(() => useWebSocket('map:rider-positions', onMessage))

    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1)
    })

    const ws = MockWebSocket.instances[0]
    act(() => {
      ws.simulateOpen()
    })

    act(() => {
      ws.simulateMessage('not-json')
    })

    expect(onMessage).not.toHaveBeenCalled()
  })

  it('uses ws from the returned ref', async () => {
    const onMessage = vi.fn()
    const { result } = renderHook(() => useWebSocket('map:rider-positions', onMessage))

    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1)
    })

    act(() => {
      MockWebSocket.instances[0].simulateOpen()
    })

    expect(result.current.ws.current).toBe(MockWebSocket.instances[0])
  })
})
