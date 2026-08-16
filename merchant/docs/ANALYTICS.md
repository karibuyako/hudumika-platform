# HUDumika Merchant — Analytics

Business intelligence: real-time dashboard, traffic and product performance, revenue composition, industry benchmarks, and report exports. AI diagnostics are contract-defined but phased (backend M7e) and not yet built — the UI does not expose them until they ship.

## Dashboard (`GET /analytics/dashboard`)

`AnalyticsDashboard`: `date`, `today`, `live`.

| Group | Fields | UI |
| --- | --- | --- |
| `today` | `orderCount`, `dineInCount`, `groupBuyCount`, `revenueTZS`, `newCustomers`, `averageOrderValueTZS` | stat tiles |
| `live` | `activeOrders`, `activeDineInTables`, `openAlerts` | live strip, auto-refresh |

- `averageOrderValueTZS` (AOV) is server-computed — the client never divides `revenueTZS` by `orderCount`.
- Dashboard exit criterion (backend M7e): dashboard totals must match ledger totals; the earnings screen is the reconciliation view (EARNINGS.md).
- States: loading skeleton → empty day ("No activity yet today") → error + retry → tiles; live strip polls on an env-configured interval.

## Traffic analysis (`GET /analytics/traffic?from&to`)

`TrafficAnalysis`: `totals`, `byChannel[]` — each `{channel, visits, orders, conversionRate}`.

| Channel | Meaning |
| --- | --- |
| `search` | found via search |
| `category` | category browse |
| `promotion` | via a promotion campaign |
| `group_buy` | via a group buy deal |
| `dine_in_qr` | QR scan at a table |
| `direct` | direct store visit |
| `referral` | referred link |

Traffic screen: date range picker, stacked bar of visits by channel per DESIGN-SYSTEM analytics chart (brand palette), conversion rate column. States: loading / empty range / error + retry / chart.

## Product performance (`GET /analytics/products?from&to`)

`ProductPerformance[]`: `catalogueItemId`, `name`, `unitsSold`, `revenueTZS`, `ordersCount`, `availabilityRate`.

- Sortable table (units / revenue / orders); rows deep-link to the catalogue item (MENU-CATALOGUE.md). `availabilityRate` is the fraction of time the item was sellable — low values flag paused items.
- States: loading skeleton → empty ("No sales in range") → error + retry → table; export via report export below.

## Revenue composition (`GET /analytics/revenue?from&to`)

`RevenueAnalysis`: `totalTZS`, `byChannel[]` — `{channel, amountTZS}` with channel enum `delivery` / `dine_in` / `group_buy` / `pickup`.

- Donut/bar composition chart; each slice deep-links to its surface (orders, dine-in bills, group buy vouchers, pickup orders).
- Cross-check with EARNINGS.md: wallet `settlement` / `group_buy_settlement` transactions explain the same money at a different granularity.

## Industry benchmarks (`GET /analytics/benchmarks`)

`BenchmarkSummary`: `category`, `merchantScore` (0–100 store score), `industryAverage`, `percentileRank`, `metrics[]` (`metric`, `merchant`, `average`).

- Score + percentile rendered as a gauge; metrics rows compare merchant vs category average.
- Values are server-computed from real data — never hardcoded marketing numbers (SHARED-FLOWS rating rule applies to metrics).

## Review analytics (`GET /analytics/reviews?from&to`)

`ReviewAnalytics`: `from`, `to`, `ratingAverage`, `reviewCount`, `replyRate`, `trendByDay[]` (`{date, count, avgRating}`).

- Rating trend line (avgRating per day) + review count bars; `replyRate` = share of reviews with a merchant reply (drives the reply discipline view, MESSAGES.md).
- States: loading skeleton → empty range ("No reviews in range") → error + retry → trend chart; values server-computed, never client-derived from the review list.

## Market analysis (`GET /analytics/market?category=&cityId=`)

`MarketAnalysis`: `category`, `demandIndex`, `trend` (`growing` / `stable` / `declining`), `topSearches[]`, `competitorCount`, `suggestedPriceBandTZS` (`{low, high}`).

- Demand gauge (`demandIndex` + trend pill), top-search chips, competitor count, and a suggested price band (integer TZS, e.g. `TZS 8,000`–`TZS 12,000`, rendered with separators) — inputs for menu/pricing decisions; suggestions are advisory only.
- States: loading skeleton → empty (no market data for the category) → error + retry → cards; `category` is a required query param, picked from the store's categories (MENU-CATALOGUE.md).

## AI diagnostics (`GET /analytics/diagnostics`) — phased M7e

- Contract-ready: `[{severity: issue | warning | opportunity, topic, insight ≤2000, action}]`.
- Not built yet: the diagnostics card renders "coming in a later release" until backend M7e ships; no mock fabricates insights.

## Report exports (`POST /analytics/reports/export`)

| Field | Value |
| --- | --- |
| Body | `reportType` (`revenue` / `products` / `traffic` / `orders`), `from`, `to` |
| Response | `{downloadUrl, expiresInSeconds}` (default 900) |
| Gating | permissioned (owner/manager) and logged (audit trail) |

- Export flow: pick range + type → request → downloading spinner → link card with expiry countdown → open `downloadUrl` (never hardcoded).
- Errors: `ANALYTICS_RANGE_INVALID` (bad range), `ANALYTICS_REPORT_EXCEEDS_LIMIT` (range too large — narrow it), `ANALYTICS_EXPORT_NOT_READY` (retry with backoff), 403 for non-permissioned roles.

## Hourly trends (`GET /analytics/hourly-trends?date=`)

- Returns `[{hour, revenueTZS, orderCount}]` for the day — bar/line chart of revenue and orders per hour; `date` is required.
- The hourly view on the dashboard reuses this endpoint (mobile "HourlyRevenue" quick view). States: loading skeleton → empty day ("No data for this date") → error + retry → chart with `TZS 1,234`-formatted axis.

## Traffic funnel (`GET /analytics/funnel?from&to`)

- `{steps: [{name, count}]}` with step names exactly `impressions` → `store_visits` → `menu_views` → `orders` → `completed`.
- Render as a funnel/step chart with per-step conversion percentage computed server-side values only (counts are API numbers; the client may divide consecutive counts for display, never fabricate steps).
- States: loading → empty range → error + retry → funnel chart.

## Store score (`GET /analytics/store-score`)

- `StoreScore`: `score` (0–100), `ratingAverage`, `breakdown[]` (`factor`, `score`).
- Gauge + factor bars (e.g. `delivery_speed`); the score feeds benchmarks (`GET /analytics/benchmarks`) and violation tasks (TASKS-RISK.md). Values are server-computed from real data — never hardcoded (SHARED-FLOWS rating rule).

## Order analytics (`GET /analytics/order-analytics?from&to`)

- `{totalOrders, byHour: [{hour, count}], byPriceBand: [{band, count}], avgOrderValueTZS}`.
- Hour heatmap + price-band histogram; `avgOrderValueTZS` (AOV) is server-computed — the client never divides totals. States: loading / empty range / error + retry / charts.

## Customer insights (`GET /analytics/customers?from&to`) and distribution (`GET /analytics/customer-distribution`)

- Insights: `{newCustomers, returningCustomers, retentionRate}` — stat tiles plus a new-vs-returning split.
- Distribution: `[{area, customerCount}]` — geographic breakdown by service area; renders as a list/bars (no map tiles in v1).
- Privacy: only aggregated counts; no customer PII in either payload (SECURITY.md masking rules).

## Sales forecast (`GET /analytics/forecast?horizonDays=`)

- `[{date, predictedRevenueTZS, confidence}]`, `horizonDays` default 7 — predictive card on the dashboard; confidence renders as a percentage bar.
- Forecasts are advisory; the UI labels them "prediction" and never mixes them into historical totals.

## Top dishes (`GET /analytics/top-dishes?from&to&limit=`)

- `{top: ProductPerformance[], bottom: ProductPerformance[]}` (`limit` default 10); each entry has `catalogueItemId`, `name`, `unitsSold`, `revenueTZS`, `ordersCount`, `availabilityRate`.
- Best/worst lists deep-link to the catalogue item; `availabilityRate` explains why a bottom dish underperforms (paused items). States: loading → empty ("No sales in range") → error + retry → lists.

## Screen states and rules

- All analytics screens: loading / empty / error+retry / success chart; 429 honored with `Retry-After`.
- Money axes formatted `TZS 1,234` with separators; percentages from server values only.
- MSW parity: dashboard `today`/`live` shapes, channel enums, benchmark payloads, review analytics, market analysis payloads, export response, diagnostics placeholder, plus hourly-trends, funnel step names, store-score breakdown, order-analytics, customer insights/distribution, forecast, and top-dishes shapes — all matching the contract.

## Chain analytics (multi-store)

- Cross-store comparison (`GET /chain/analytics?from&to`) and the unified chain dashboard (`GET /chain/dashboard`) extend these metrics to the chain scope — MULTI-STORE.md, ENTERPRISE-FINANCE.md.

## Scheduled reports (automated delivery)

- Recurring report delivery is a separate surface: `GET/POST /reports`, `PATCH/DELETE /reports/{reportId}` (cadence daily/weekly/monthly, format csv/xlsx/pdf, email recipients) — AI-AUTOMATION.md. On-demand exports stay here (`POST /analytics/reports/export`); scheduled reports run server-side and notify `report.ready` to recipients.

# Round-2 additions (deep survey — `docs/REFERENCE-SURVEY.md`)

## Customer analytics

| Surface | Contract | Reference-app extras (contract gaps) |
| --- | --- | --- |
| Customer insights | `GET /analytics/customers` → `{newCustomers, returningCustomers, retentionRate}` | `avgOrderFrequency`, `avgLifetimeValue` (LTV), `churnRate`, `monthlyTrend` |
| Segments | `/segments` (CRM.md — `memberCount`, rules) | VIP / Regular / At-Risk / Lost classes + per-segment recommended actions |
| Distribution | `GET /analytics/customer-distribution` → `[{area, customerCount}]` | distance bands (0–2 / 2–5 / 5–10 / 10+ km) + density |

- Privacy rule unchanged: aggregated counts only, no customer PII in any payload.

## Traffic funnel (contract gap on carts)

- Contract funnel steps (exact enum): `impressions` → `store_visits` → `menu_views` → `orders` → `completed`. The reference app inserts `carts` before orders — `carts` is a contract gap (funnel enum has no carts). Per-stage conversion renders from server counts (client may divide consecutive counts for display); the change-% column (vs previous period) is a gap — no delta field in the contract.

## Benchmark radar (contract gap)

- `GET /analytics/benchmarks` supplies `category`, `merchantScore`, `industryAverage`, `percentileRank`, `metrics[]`. The reference radar (you vs market vs top competitor) and suggestions-with-impact cards are contract gaps (no competitor breakdown or impact field); the gauge + metric rows remain the contract rendering.

## Product performance (contract gap)

- `ProductPerformance`: `catalogueItemId`, `name`, `unitsSold`, `revenueTZS`, `ordersCount`, `availabilityRate`. Margin, satisfaction, growth, `avgMargin`, and `addOnRate` columns are reference-app extras — contract gaps; `CatalogueItem.costTZS` is the available margin input (MENU-CATALOGUE.md).

## Order analytics (contract gap)

- `GET /analytics/order-analytics` → `{totalOrders, byHour[], byPriceBand[], avgOrderValueTZS}`. `avgDeliveryTime`, `cancelRate`, `refundRate`, and `avgDeliveryDist` are contract gaps; the heatmap + price-band histogram stay the contract rendering.

## Store score history (contract gap)

- `GET /analytics/store-score` is a snapshot (`score`, `ratingAverage`, `breakdown[]`). A monthly history series is a contract gap — render the current score gauge only.

## Diagnostic report (contract gap on shape)

- `GET /analytics/diagnostics` returns `[{severity: issue|warning|opportunity, topic, insight <=2000, action}]`. The reference report bundle (`overallHealth`, `strengths`, `weaknesses`, `recommendations`, `riskAlerts`) is a richer object not in the contract — render the array form as defined; the bundled shape is a gap.

## Market analysis (contract gap on fields)

- `GET /analytics/market?category=&cityId=` → `{category, demandIndex, trend: growing|stable|declining, topSearches[], competitorCount, suggestedPriceBandTZS{low, high}}`. `marketSize`, `avgPriceRange`, `demandGrowth`, `topCategories`, `trends[]`, and `priceDistribution` are contract gaps.

## Revenue composition (contract gap on splits)

- `GET /analytics/revenue` is channel-only (`delivery` / `dine_in` / `group_buy` / `pickup`). Payment-method and time-of-day splits are contract gaps; the donut + channel deep links stay as documented.

## Dish sales, forecast, report bundle (contract gaps)

- `GET /analytics/top-dishes` → `{top, bottom}` of `ProductPerformance[]` — margin and `addOnRate` columns are gaps.
- `GET /analytics/forecast?horizonDays=` → `[{date, predictedRevenueTZS, confidence}]` — weather factors (`rain` / `temp` / `orderDelta` / `tips`) are gaps; forecasts stay labeled "prediction" and never mix into historical totals.
- Report bundle: `POST /analytics/reports/export` accepts `reportType` `revenue` / `products` / `traffic` / `orders`. The 30-day bundle (summary / dailySeries / topDishes / channels / issues) is a contract gap; scheduled reports (AI-AUTOMATION.md) are the closest contract surface.
