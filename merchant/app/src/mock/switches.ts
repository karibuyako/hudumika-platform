/* Mock switches — the single gate between mock and live for the merchant mock backend.
 *
 * One EXPO_PUBLIC_MOCK_* switch per handler group, all default ON in dev
 * (set to 'false' to route that group to the live API):
 *   EXPO_PUBLIC_MOCK_AUTH       auth
 *   EXPO_PUBLIC_MOCK_ORDERS     orders
 *   EXPO_PUBLIC_MOCK_CATALOG    products
 *   EXPO_PUBLIC_MOCK_CATALOGUES  catalogues (export/import/bulk/me)
 *   EXPO_PUBLIC_MOCK_MERCHANTS   merchants (list/detail/apply/claim + settings/payout/stores)
 *   EXPO_PUBLIC_MOCK_FINANCE    finance + finance-extra
 *   EXPO_PUBLIC_MOCK_BI         bi + analytics
 *   EXPO_PUBLIC_MOCK_MARKETING  campaigns + redemptions + dianjin/flash-sales/precision/self-service/coupons (P6c)
 *   EXPO_PUBLIC_MOCK_PROMOTIONS promotions + brand-display (P6c)
 *   EXPO_PUBLIC_MOCK_GROUP_BUY  group-buy deals + vouchers
 *   EXPO_PUBLIC_MOCK_MESSAGING  messaging
 *   EXPO_PUBLIC_MOCK_NOTIFICATIONS  notification preferences + order alert settings (P6)
 *   EXPO_PUBLIC_MOCK_OPS        ops + staff + risk + reviews + announcements
 *   EXPO_PUBLIC_MOCK_STORE      store-ops
 *   EXPO_PUBLIC_MOCK_LOYALTY    loyalty (members + tiers + top-ups)
 *   EXPO_PUBLIC_MOCK_DEVICES    device registry (printers/terminals, P6d)
 *   EXPO_PUBLIC_MOCK_CATALOGUE_EXT  barcodes + combos + menus + videos + bulk-operations (P8)
 *   EXPO_PUBLIC_MOCK_CHAIN      chain dashboard + chain reports (P8)
 *   EXPO_PUBLIC_MOCK_SUPPLY_CHAIN  inventory + suppliers + purchase-orders + returns + warehouses (P8)
 *   EXPO_PUBLIC_MOCK_WEBHOOKS   webhooks + integrations (P8b)
 *   EXPO_PUBLIC_MOCK_TASKS      tasks center — anomalies + violations + activities + setup-guide (P8b)
 *   EXPO_PUBLIC_MOCK_STAFF_OPS  staff shifts + attendance + performance + commissions + approvals (P8b)
 *   EXPO_PUBLIC_MOCK_REPORTS    scheduled reports + CRM journeys + data exports + privacy export (P8c)
 *   EXPO_PUBLIC_MOCK_ANALYTICS_EXT  store-score + customers + customer-distribution + marketing analytics (P8c)
 *   EXPO_PUBLIC_MOCK_PRINT_JOBS print jobs (create + history + detail, P6d)
 *
 * Master override: EXPO_PUBLIC_MOCK_ALL (default ON). Mocks never load when
 * EXPO_PUBLIC_ENVIRONMENT=production. Registered in docs/ENV-VARS.md.
 */
import type { HttpHandler } from 'msw';

import { ALL_HTTP_HANDLERS, HANDLERS_BY_MODULE, type MockModuleName } from '@/mock/handlers';

/** Only bundled when mocks are enabled — referenced solely inside the
 * mock-enabled branch below (never exported: Metro keeps export getters, which
 * would retain the literal in production bundles). CI asserts production
 * exports never contain this marker (see .github/workflows/ci.yml). */
const MOCK_RUNTIME_MARKER = 'hudumika-mock-runtime';

const mock = (v: string | undefined, def = true) => (v === undefined ? def : v !== 'false');

// Release builds (EAS preview/production, web export) never load mocks.
// typeof-guarded: node bundles (tests, mock-gateway) have no __DEV__ → dev-on.
const MOCK_PRODUCTION =
  process.env.EXPO_PUBLIC_ENVIRONMENT === 'production' ||
  (typeof __DEV__ !== 'undefined' && !__DEV__);
const MOCK_MASTER = mock(process.env.EXPO_PUBLIC_MOCK_ALL);

const MOCK_AUTH = mock(process.env.EXPO_PUBLIC_MOCK_AUTH);
const MOCK_ORDERS = mock(process.env.EXPO_PUBLIC_MOCK_ORDERS);
const MOCK_CATALOG = mock(process.env.EXPO_PUBLIC_MOCK_CATALOG);
const MOCK_CATALOGUES = mock(process.env.EXPO_PUBLIC_MOCK_CATALOGUES);
const MOCK_MERCHANTS = mock(process.env.EXPO_PUBLIC_MOCK_MERCHANTS);
const MOCK_FINANCE = mock(process.env.EXPO_PUBLIC_MOCK_FINANCE);
const MOCK_BI = mock(process.env.EXPO_PUBLIC_MOCK_BI);
const MOCK_MARKETING = mock(process.env.EXPO_PUBLIC_MOCK_MARKETING);
const MOCK_PROMOTIONS = mock(process.env.EXPO_PUBLIC_MOCK_PROMOTIONS);
const MOCK_GROUP_BUY = mock(process.env.EXPO_PUBLIC_MOCK_GROUP_BUY);
const MOCK_MESSAGING = mock(process.env.EXPO_PUBLIC_MOCK_MESSAGING);
const MOCK_NOTIFICATIONS = mock(process.env.EXPO_PUBLIC_MOCK_NOTIFICATIONS);
const MOCK_OPS = mock(process.env.EXPO_PUBLIC_MOCK_OPS);
const MOCK_STORE = mock(process.env.EXPO_PUBLIC_MOCK_STORE);
const MOCK_LOYALTY = mock(process.env.EXPO_PUBLIC_MOCK_LOYALTY);
const MOCK_DEVICES = mock(process.env.EXPO_PUBLIC_MOCK_DEVICES);
const MOCK_CATALOGUE_EXT = mock(process.env.EXPO_PUBLIC_MOCK_CATALOGUE_EXT);
const MOCK_CHAIN = mock(process.env.EXPO_PUBLIC_MOCK_CHAIN);
const MOCK_SUPPLY_CHAIN = mock(process.env.EXPO_PUBLIC_MOCK_SUPPLY_CHAIN);
const MOCK_WEBHOOKS = mock(process.env.EXPO_PUBLIC_MOCK_WEBHOOKS);
const MOCK_TASKS = mock(process.env.EXPO_PUBLIC_MOCK_TASKS);
const MOCK_STAFF_OPS = mock(process.env.EXPO_PUBLIC_MOCK_STAFF_OPS);
const MOCK_REPORTS = mock(process.env.EXPO_PUBLIC_MOCK_REPORTS);
const MOCK_ANALYTICS_EXT = mock(process.env.EXPO_PUBLIC_MOCK_ANALYTICS_EXT);
const MOCK_PRINT_JOBS = mock(process.env.EXPO_PUBLIC_MOCK_PRINT_JOBS);

/** Master gate: off in production builds, off when EXPO_PUBLIC_MOCK_ALL=false,
 * off when every module switch is 'false'. */
export const MOCK_ENABLED =
  MOCK_MASTER &&
  !MOCK_PRODUCTION &&
  (MOCK_AUTH || MOCK_ORDERS || MOCK_CATALOG || MOCK_CATALOGUES || MOCK_MERCHANTS || MOCK_FINANCE || MOCK_BI || MOCK_MARKETING || MOCK_PROMOTIONS || MOCK_GROUP_BUY || MOCK_MESSAGING || MOCK_NOTIFICATIONS || MOCK_OPS || MOCK_STORE || MOCK_LOYALTY || MOCK_DEVICES || MOCK_CATALOGUE_EXT || MOCK_CHAIN || MOCK_SUPPLY_CHAIN || MOCK_WEBHOOKS || MOCK_TASKS || MOCK_STAFF_OPS || MOCK_REPORTS || MOCK_ANALYTICS_EXT || MOCK_PRINT_JOBS);

const MODULE_SWITCHES: readonly (readonly [MockModuleName, boolean])[] = [
  ['auth', MOCK_AUTH],
  ['orders', MOCK_ORDERS],
  ['catalog', MOCK_CATALOG],
  ['catalogues', MOCK_CATALOGUES],
  ['merchants', MOCK_MERCHANTS],
  ['finance', MOCK_FINANCE],
  ['bi', MOCK_BI],
  ['marketing', MOCK_MARKETING],
  ['promotions', MOCK_PROMOTIONS],
  ['groupBuy', MOCK_GROUP_BUY],
  ['messaging', MOCK_MESSAGING],
  ['notifications', MOCK_NOTIFICATIONS],
  ['ops', MOCK_OPS],
  ['store', MOCK_STORE],
  ['loyalty', MOCK_LOYALTY],
  ['devices', MOCK_DEVICES],
  ['catalogueExt', MOCK_CATALOGUE_EXT],
  ['chain', MOCK_CHAIN],
  ['supplyChain', MOCK_SUPPLY_CHAIN],
  ['webhooks', MOCK_WEBHOOKS],
  ['tasks', MOCK_TASKS],
  ['staffOps', MOCK_STAFF_OPS],
  ['reports', MOCK_REPORTS],
  ['analyticsExt', MOCK_ANALYTICS_EXT],
  ['printJobs', MOCK_PRINT_JOBS],
];

/** HTTP handlers of the enabled modules — all of them when every switch is on. */
export function mockHttpHandlers(): readonly HttpHandler[] {
  if (!MOCK_ENABLED) return [];
  // Inline literal comparison — consts are not folded by the minifier in
  // modules with exports (babel hoists `exports.X = …`), but literal-literal
  // comparisons always are; that dead-code removal drops the marker line
  // below from production bundles (asserted in .github/workflows/ci.yml).
  if (process.env.EXPO_PUBLIC_ENVIRONMENT === 'production') return [];
  console.debug(MOCK_RUNTIME_MARKER);
  if (MODULE_SWITCHES.every(([, on]) => on)) return ALL_HTTP_HANDLERS;
  return MODULE_SWITCHES.filter(([, on]) => on).flatMap(([name]) => HANDLERS_BY_MODULE[name]);
}
