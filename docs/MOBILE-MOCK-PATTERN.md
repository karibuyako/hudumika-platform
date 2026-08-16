# Mobile Mock Pattern (React Native)

MSW only works in browsers. On React Native, mocks are **typed repositories behind an interface**: the screen depends on the interface, never on mocks or the HTTP client directly.

## The pattern

```ts
// src/orders/orderRepository.ts  — THE INTERFACE (screens import only this)
import type { OrderDetail } from '@hudumika/contract'

export interface OrderRepository {
  listActive(): Promise<OrderDetail[]>
  getById(orderId: string): Promise<OrderDetail>
  assign(orderId: string, riderId: string, reason: string): Promise<OrderDetail>
}

// src/orders/orderRepository.mock.ts  — fixture implementation (faker data, no network)
import type { OrderDetail } from '@hudumika/contract'
import { fixtureOrderDetail, fixtureDispatchableOrder } from '@hudumika/contract/fixtures'
import type { OrderRepository } from './orderRepository'

export class MockOrderRepository implements OrderRepository {
  private store = new Map<string, OrderDetail>(
    Array.from({ length: 6 }, () => {
      const o = fixtureDispatchableOrder()
      return [o.id, o]
    }),
  )

  async listActive() { return [...this.store.values()] }

  async getById(orderId: string) {
    const order = this.store.get(orderId)
    if (!order) throw new Error(`order ${orderId} not found`)
    return order
  }

  async assign(orderId: string, riderId: string, reason: string) {
    const order = await this.getById(orderId)
    const updated = fixtureOrderDetail({ ...order, status: 'rider_assigned', riderId })
    this.store.set(orderId, updated)
    return updated
  }
}

// src/orders/orderRepository.api.ts  — live implementation (generated client)
import { adminListOrders, adminAssignOrderToRider, type AdminAssignOrderToRiderBody } from '@hudumika/contract'
import type { OrderRepository } from './orderRepository'

export class ApiOrderRepository implements OrderRepository {
  async listActive() {
    const res = await adminListOrders()
    return res.status === 200 ? res.data : []
  }
  async getById(orderId: string) {
    const res = await adminListOrders()
    if (res.status !== 200) throw new Error('fetch failed')
    const order = res.data.find((o) => o.id === orderId)
    if (!order) throw new Error(`order ${orderId} not found`)
    return order
  }
  async assign(orderId: string, riderId: string, reason: string) {
    const res = await adminAssignOrderToRider(orderId, { riderId, reason } satisfies AdminAssignOrderToRiderBody)
    if (res.status !== 200) throw new Error(`assign failed (${res.status})`)
    return res.data
  }
}

// src/orders/orderRepository.factories.ts  — one switcher per module, env-driven
import { ApiOrderRepository } from './orderRepository.api'
import { MockOrderRepository } from './orderRepository.mock'
import type { OrderRepository } from './orderRepository'

const USE_MOCKS: Record<string, boolean> = {
  orders: process.env.EXPO_PUBLIC_MOCK_ORDERS !== 'false',   // default ON in dev
  // payments: false,   // flip per endpoint as Team 6 ships it
}

export function getOrderRepository(): OrderRepository {
  return USE_MOCKS.orders ? new MockOrderRepository() : new ApiOrderRepository()
}
```

## Rules

1. Screens import the **interface** only. Swapping mock→live touches one file (the factory).
2. Fixtures come from `@hudumika/contract/fixtures` — pure, deterministic (`setFixturesSeed(123)` for demo day), no msw import.
3. When the live endpoint lands, flip one module — **never delete the mock**.
4. Mock repositories keep in-memory state (list → assign → list reflects the change), so demos feel real.

## Env switches (per team)

| App | Env var | Notes |
| --- | --- | --- |
| consumer-mobile | `EXPO_PUBLIC_MOCK_ORDERS`, `..._HOME`, `..._WALLET` | default on |
| rider-mobile | `EXPO_PUBLIC_MOCK_JOBS`, `..._EARNINGS` | default on |
| merchant/provider-mobile | same convention | default on |

Web halves of merchant/provider use MSW (`VITE_USE_MOCKS`) — see `packages/contract/README.md`.