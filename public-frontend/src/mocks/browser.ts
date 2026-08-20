import { matchRequestUrl, type HttpHandler } from 'msw'
import { setupWorker } from 'msw/browser'
import { handlers } from './handlers'

/**
 * Vite-internal request paths (app modules, pre-bundled deps, virtual modules).
 * The generated MSW patterns are wildcard-prefixed (e.g. `* /merchants`), so
 * they also match dev-server module URLs such as `/src/pages/HomePage.tsx`
 * and would hijack lazy route chunks. Guard every handler against those paths.
 */
const VITE_INTERNAL_PREFIX = /^\/(?:src|node_modules|@id|@fs|@vite|@react-refresh)\//

function guardViteModuleUrls(handler: HttpHandler): HttpHandler {
  const path = handler.info.path
  if (typeof path !== 'string') return handler
  handler.info.path = ({ request }) => {
    const url = new URL(request.url)
    if (VITE_INTERNAL_PREFIX.test(url.pathname)) return false
    return matchRequestUrl(url, path).matches
  }
  return handler
}

export const worker = setupWorker(...handlers.map(guardViteModuleUrls))
