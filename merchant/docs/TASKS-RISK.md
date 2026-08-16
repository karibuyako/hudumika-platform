# HUDumika Merchant — Tasks & Risk Center

The Tasks tab (mobile bottom bar) and its web equivalent centralize everything
that needs merchant attention: product anomalies, store violations, platform
activity submissions, the store setup guide, and risk events.

## Task list (`GET /tasks`)

| Field | Values |
| --- | --- |
| `kind` | `anomaly` (products), `violation` (store), `activity` (submissions), `setup` (guide) |
| `severity` | `info`, `warning`, `critical` |
| `status` | `open`, `in_progress`, `done`, `dismissed` |
| refs | `refType`/`refId` link to the affected order, item, or event |

- Filter by kind and status; the dashboard shows the unread/critical count.
- Row deep-links to the fix surface (product editor, store settings, event detail).
- Update status via `PATCH /tasks/{taskId}` (`TASK_NOT_FOUND`, `TASK_STATUS_INVALID`); a note is optional.

## Product anomalies (`GET /tasks/anomalies`)

Detected by backend rules (out of stock beyond threshold, zero-price items,
price drops >50% in 24h, category mismatch):

- Each row links to the inventory adjust or product editor screen.
- Resolving the underlying issue (stock adjust, price fix) auto-completes the task; manual `done` is allowed with a note.

## Store violations (`GET /tasks/violations`)

- Rating drops below policy threshold, sustained slow acceptance, policy
  reminders (license expiry via `/store/qualifications`).
- `critical` violations also raise a `task.new` push to managers.
- Dismissing requires a note; repeated dismissals of the same violation re-open it.

## Activity submissions (`GET /tasks/activities`, `POST /tasks/activities`)

- Platform campaign enrollment submissions (see platform events in PROMOTIONS.md).
- Statuses `submitted` → `approved`/`rejected`; `ACTIVITY_ALREADY_SUBMITTED` blocks duplicates.
- Rejected submissions show the reason and allow re-submission with corrections.

## Store setup guide (`GET /tasks/setup-guide`, `POST /tasks/setup-guide/{stepId}/complete`)

- Ordered checklist (`SetupStep`: title, order, completed, deepLink) covering
  profile, qualifications, payout account, printers, table QR, first product.
- Completing a step navigates to its deep link; progress mirrors the onboarding wizard state.

## Risk events (`GET /risk/events`, `POST /risk/{riskEventId}/review`)

- Anomaly detection feed: unusual refund patterns, order velocity spikes,
  chargebacks, suspicious customer accounts.
- Review with `decision` `resolved`/`dismissed` + reason; `RISK_ALREADY_REVIEWED` on repeats.
- Every decision is audited; critical events also alert the owner (`risk.event_detected`).

## Merchant audit view (`GET /audit/me`)

- Own-scope audit trail (money, status, moderation actions involving this merchant).
- Append-only read; export reuses the data export flow.

## Client error reporting (`POST /monitoring/errors`)

- The app posts unhandled errors (message, stack, context) without auth; no PII in the payload.

## Screen states

Task list: loading skeleton → empty ("All clear — no tasks") → error + retry →
grouped list with severity badges. Detail: reason, refs, timeline; actions show
loading → success toast → status pill update; `dismissed` rows are collapsible.

# Round-2 additions (deep survey — `docs/REFERENCE-SURVEY.md`)

## Task kinds and action deep links

- Contract `TaskItem.kind` enum: `anomaly` (products), `violation` (store), `activity` (submissions), `setup` (guide). The reference-app grouping product / store / review / activity maps onto it: anomalies = product tasks, violations = store tasks, activities = submissions; **review** is not a contract kind — review-related work arrives as violations or lives on the reviews surface (MESSAGES.md).
- Action deep links: `SetupStep.deepLink` covers setup steps; tasks carry `refType` / `refId` and the client resolves rows to the fix surface (open-product, promos, campaign, traffic, review, settings, orders) from `refType`. A typed action enum is a contract gap.

## Anomaly quick fix

- Anomaly rows open a quick-fix modal: item summary + detected issue, then jump to the product editor or the inventory stock-adjust screen (MENU-CATALOGUE.md, INVENTORY-SUPPLY-CHAIN.md). Resolution notes are saved via `PATCH /tasks/{taskId}` (`note` <=500); fixing the root cause auto-completes the task, manual `done` is allowed with a note. States: modal loading → fix action → success toast → task status pill update.

## Violations — fines and appeal (contract gap)

- Violations resolve via `PATCH /tasks/{taskId}` (`done` with note) or by fixing the root cause (rating, acceptance time, license expiry via `/store/qualifications`). Fines and an appeal workflow are reference-app features **not in the contract** — no fine fields on `TaskItem`, no appeal endpoint (contract gap: flag before building). `critical` violations keep raising `task.new` to managers.

## Activity submissions — types, budget, reach (contract gap)

- `ActivitySubmission`: `platformEventId` + `status` (`submitted` / `approved` / `rejected`); `POST /tasks/activities` (201) and `ACTIVITY_ALREADY_SUBMITTED` block duplicates. Submission types (Flash Sale / Holiday Promo / Discount / Clearance / Seasonal) and budget + estimated-reach fields are UI form inputs posted alongside the `platformEventId` — no contract enums for them (contract gap). Rejected submissions show the reason and allow re-submission.

## Setup guide

- The 8-step checklist is server-driven: `SetupStep` (`title`, `order`, `completed`, `deepLink`) via `GET /tasks/setup-guide`; `POST /tasks/setup-guide/{stepId}/complete` returns the updated list. Step count and linked screens come from the API — the client renders, never invents steps; progress mirrors the onboarding wizard (ONBOARDING.md).

## Risk engine (thresholds and event types)

- `RiskEvent.type` enum: `refund_ratio` / `refund_velocity` / `large_refund` / `withdrawal_anomaly` / `login_risk` / `unusual_order_pattern`; `status` `open` / `reviewed` / `resolved`; `severity` `low` / `medium` / `high`.
- Detection thresholds (backend sweeper, DATA-MODEL.md): refund ratio > 15%/week, refund velocity >= 3/hour, large refund above the configured threshold, withdrawal > 80% of balance, new-device login. The sweeper's auto-check interval (~15s in the reference app) is deployment config, not fixed by the contract.
- Review stays `POST /risk/{riskEventId}/review` (`decision` `resolved` / `dismissed` + `reason` <=500; `RISK_ALREADY_REVIEWED` on repeats); decisions are audited and `risk.event_detected` alerts the owner.

# Round-3 additions — exact risk-engine thresholds (reference sweeper)

Verified against `src/mock/sweeper.ts` (risk checks run inside the sweeper over active merchants).

| Check | Threshold | Level | Type |
| --- | --- | --- | --- |
| Refund ratio | > 15% of completed orders over the last 7 days (evaluated when >= 5 completed in the week) | high | `refund-ratio` |
| Refund velocity | >= 3 approved refunds in the last hour | high | `refund-velocity` |
| Large refund | single approved refund > 200 units | medium | `large-refund` |
| Withdrawal anomaly | withdrawal > 80% of the available balance | medium | `withdrawal-anomaly` |
| Login risk | new-device login | high | `login_risk` |

- The sweeper's auto-check interval is ~15 s in the reference app (deployment config, not fixed by the contract).
- Existing flags are deduped: no duplicate `open` event of the same type is created for a merchant.
- Each flag also emits an `important` risk-alert notification; review stays `POST /risk/{riskEventId}/review` (`decision` `resolved` / `dismissed` + `reason`; `RISK_ALREADY_REVIEWED` on repeats).
- Audit entries mask PII; every risk decision is audited.
