# HUDumika RIDER — Performance

Scorecard and leaderboards: `GET /riders/me/performance` (`RiderPerformance`), `GET /riders/me/leaderboard` (`Leaderboard`). All values are server-computed (sweeper-derived views, `backend/DATA-MODEL.md` `rider_performance / leaderboards`); the app renders, never calculates.

## Scorecard (`GET /riders/me/performance`)

Optional `from` / `to` query params (dates) filter the window; defaults are server-side.

| Field | Meaning | Display |
| --- | --- | --- |
| `acceptanceRate` | 0–100; offers accepted ÷ offers received in the window | % stat |
| `onTimePct` | share of deliveries completed at or before the ETA | % stat |
| `ratingAverage` | customer rating average | star row + value |
| `completedOrders` | deliveries completed in the window | integer stat |
| `earningsTZS` | ledger-derived earnings in the window (fees + tips + bonuses) | `TZS x,xxx` |
| `safetyScore` | 0–100 composite (incidents, SOS, POD quality, safe-riding signals) | gauge |
| `behaviorScore` | telemetry-based 0–100; `null` until telemetry ships — render "Coming soon" (planned, SECURITY.md) | gauge / planned badge |
| `reliabilityScore` | 0–100, per `DISPATCH.md` anti-gaming factors | gauge |

- Gauges use the design-system palette; `success` band at 80+, neutral mid, `danger` below threshold (copy only — thresholds are never shown as hard rules).
- `benchmarks`: `{teamAverage, fleetAverage, percentileRank}` — each nullable; hide the compare row when null (pool too small), never render a placeholder value.
- `trends[]`: `{label, value}` points per metric (labels server-provided, e.g. weekly buckets) — line chart per metric, brand palette (DESIGN-SYSTEM analytics chart). The app renders buckets, never computes them.
- Errors: 404 `PERFORMANCE_UNAVAILABLE` (scorecard not ready) → empty-state variant + retry.

## Leaderboard (`GET /riders/me/leaderboard`)

Query: `metric` required, `deliveries | rating | earnings | on_time`; `period` `daily | weekly | monthly` (default `weekly`); `limit` default 10.

`Leaderboard`: `{metric, period, entries[{rank, riderName, value}], myEntry{rank, value}}`.

- `entries` = top `limit` riders in the period; `myEntry` is always present even when outside the top rows (`rank` may exceed `limit`).
- Value formatting by metric: `deliveries` integer; `earnings` `TZS x,xxx` (never floats, EARNINGS.md); `rating` one decimal; `on_time` `%`.
- `riderName` is the rider's display name; leaderboard rows are the only shared surface where another rider's name appears (SECURITY.md) — no phone, no earnings-per-order, no ledger data.
- The `earnings` value is the period ranking figure from the performance view — never presented as a wallet balance (EARNINGS.md note).
- `leaderboard.updated` (weekly digest, in-app, per `backend/NOTIFICATIONS.md`) refreshes the screen and shows a digest banner.
- Errors: 404 `LEADERBOARD_UNAVAILABLE` → empty-state variant + retry.

## Rider level (star tier)

- `RiderPerformance.level` ∈ `bronze | silver | gold | platinum` (default `bronze`) — the rider's star level, derived server-side from performance (acceptance, on-time, rating, reliability; Meituan-style).
- `levelBenefits[]` (array of strings) is the config-driven benefit list for the current tier (e.g. priority dispatch, lower withdrawal fees); render it on the Profile badge and the Performance screen.
- On tier change the server emits a level-up notification (in-app/push); the badge and benefit list refetch from `GET /riders/me/performance`.
- Display: badge + tier name on Profile (`bronze` → `platinum`), benefits as a list; the app never computes the level or its thresholds (EARNINGS.md rider level benefits).

## Comparisons flow

```text
Performance tab → Scorecard → Metric detail (trends + benchmark row)
  → Compare (me vs team vs fleet + percentile) → Safety detail → Leaderboard
```

1. Scorecard: summary stat cards + gauge row.
2. Metric detail: one metric expanded — trends chart, current value, benchmark row, what-impacts-it copy.
3. Compare: side-by-side bars — me vs `teamAverage` vs `fleetAverage`, plus `percentileRank` badge ("Top X%"); rows hidden where a benchmark is `null`.
4. Safety: `safetyScore` explanation screen — factors read-only, composite is server-side; behavior score area shows the planned state; **safety coaching** (proactive tips based on driving-behavior analysis — e.g. "reduce hard braking to improve score") is planned with telemetry, currently surfaced as static guidance cards in the Safety Center.
5. Leaderboard: metric × period switcher (segments, not free input); podium + rows; `myEntry` pinned at bottom; weekly-digest banner.

## Best hours and earnings analytics

- `RiderPerformance` adds: `avgPerTripTZS` (integer, nullable — mean earnings per completed trip in the window, `TZS x,xxx`), `onlineHoursWeek` (number, nullable — hours online in the week) and `topHours` (`string[]` — best-performing hours of the week).
- Scorecard rendering: "Hours online (week)" stat (`onlineHoursWeek`, one decimal, hidden when `null`), "Avg per trip" stat (`TZS x,xxx`, hidden when `null` — pool too small), and a "Best hours" section — a bar strip of `topHours` (hour labels, e.g. `18:00`, `19:00`, `20:00`) showing when earnings are strongest; the strip is a server-derived visualization, never a scheduling claim (EARNINGS.md analytics section renders the same data on the earnings dashboard).
- All three are derived-performance values (sweeper views, may lag the ledger); states: loading skeleton → `null` fields hidden → error (retry) → success (stats + best-hours strip).

## AI coach and retention (Phase 3)

- **AI Performance Coach** (planned, `backend/ROADMAP.md` M10c): personalized recommendations (shift timing from the demand forecast, acceptance/on-time levers) served by a backend model — the UI renders recommendations only when the model ships; until then the coach entry shows "Coming soon".
- **Retention risk** (planned): a backend retention-risk model (engagement, penalties, complaints — `backend/AI-LAYER.md`) may flag at-risk riders; surfaced read-only in the scorecard header when live, never client-computed.
- **Behavioral analytics expansion** (planned, telemetry): speeding and hard-braking events will feed `safetyScore`/`behaviorScore` once consented telemetry ships (SECURITY.md) — today `behaviorScore` is `null` and `safetyScore` uses available events (POD, SOS, incidents, reliability).

## Per-screen states

| State | Behavior |
| --- | --- |
| Loading | skeleton cards + gauge placeholders |
| Empty | scorecard: "No performance data in this period" + range picker; leaderboard: "Leaderboard not available yet" |
| Error | `ErrorResponse.message` + retry; `PERFORMANCE_UNAVAILABLE` / `LEADERBOARD_UNAVAILABLE` → their empty variants |
| Retry | refetch `performance` / `leaderboard` with the same params |
| Success | gauges, trends charts, benchmark rows, leaderboard with `myEntry` highlighted |

## Blueprint pass — streak, security score, goals progress

- `RiderPerformance.deliveryStreak` (integer, default 0) — consecutive-day delivery streak, server-derived; renders as a streak badge on the scorecard header ("{n}-day streak") with milestone badges (config-driven copy, e.g. 7 / 14 / 30 days). The app never computes the streak; `0` hides the badge.
- `RiderPerformance.securityScore` (0–100, nullable) — fraud/security score; the Security detail screen also surfaces `GET /riders/me/security` (score + `alerts[]`, SECURITY.md). When `null` the scorecard shows the planned state, never a fabricated value.
- Goals progress on the scorecard: `GET /riders/me/goals` (`earningsGoalTZS`, `hoursGoalPerWeek`) + `RiderPerformance.earningsTZS` render a "Weekly goal" progress bar (`earningsTZS / earningsGoalTZS` display ratio, capped at 100%). Goal edits on Goals & Schedule refetch it (VEHICLE-TOOLS.md). The ratio is a display computation only — goals and earnings both stay server-shaped.

## Data honesty

- Scorecard values are sweeper-derived views and may lag the live ledger; never present them as real-time. Money renders per EARNINGS.md (`TZS x,xxx`, integer only).
- `behaviorScore` and telemetry inputs are planned; until they ship `behaviorScore` is `null` and `safetyScore` uses available events (POD, SOS, incidents, reliability factors).
- Goals progress bar states: loading skeleton → server defaults when no goals are stored → progress vs goal; `GOALS_INVALID` surfaces on the edit screen, never the scorecard.
- Planned (ROADMAP P10c): behavior scoring from telemetry, leaderboard prize/boost eligibility, trend export.
