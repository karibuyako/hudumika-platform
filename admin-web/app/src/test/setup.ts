import '@testing-library/jest-dom/vitest'
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest'
import { setupServer } from 'msw/node'
import { getHudumikaMocks } from '@hudumika/contract/mocks'
import { cleanup } from '@testing-library/react'
import { seedStaffSession } from '../lib/session'

const server = setupServer(...getHudumikaMocks())

export { server }

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
beforeEach(() => {
  seedStaffSession()
})
afterEach(() => {
  server.resetHandlers()
  cleanup()
})
afterAll(() => server.close())
