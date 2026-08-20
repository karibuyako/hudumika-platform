import { getHudumikaMocks } from '@hudumika/contract/mocks'

/**
 * Contract-sourced MSW handlers.
 * Uses the generated mocks from `@hudumika/contract` so public-frontend never
 * invents endpoints (e.g. `/api/leads`). The contract mock handlers register
 * wildcard paths like `* /merchants` which match both same-origin relative
 * fetches and any future `/api/v1` gateway prefix.
 *
 * For local marketing fixtures (groups/homeServices) the components read
 * `src/data/constants.ts` directly — no fetch layer needed.
 */
export const handlers = getHudumikaMocks()
