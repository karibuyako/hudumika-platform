# HUDumika RIDER — Penalties and Appeals

Model and process for reliability penalties, warnings, and appeals, mapped to the existing reliability score (0–100) from `backend/DISPATCH.md`. The score is computed server-side and rendered read-only (ONBOARDING.md section 7).

## Principles

- Penalties are score-based, not cash fines; no money is deducted by a penalty.
- Declines alone are free; only patterns trigger penalties (dispatch anti-gaming).
- Every penalty is appealable once via a support ticket.
- Appeals are decided by rider operations (admin); every decision is audited.

## Penalty categories

| Category | Trigger (per DISPATCH.md) | Score impact |
| --- | --- | --- |
| Cancellation after acceptance | Rider accepts an assignment, then cancels before pickup | Deduction (largest) |
| No-show at pickup | Accepted, never picks up; order re-assigned | Deduction (escalation of cancellation after acceptance) |
| Late arrival at merchant | Pickup past the 15 min pickup window | Deduction |
| Repeated declines | 3+ declines inside one hour | Deduction (first declines free) |

Impact magnitude and decay are server-side (weighted by recency); the app never computes or predicts the score.

## Warning → deduction thresholds

| Stage | Condition | Rider sees |
| --- | --- | --- |
| Informational | First reliability event in 90 days | In-app banner + `penalty.issued` (planned event) |
| Warning | 2 events in 30 days | Warning banner on Home; score card explains |
| Deduction | 3+ events in 30 days | Score drops; penalty list shows each event |
| Review | Score below 40 | Ops review; rider notified; online toggle stays enabled pending review |

## Issuance and visibility

- Issued server-side at event time; the rider sees: the score card (Settings → Reliability), the penalty list (planned, `contract addition needed`), and the `penalty.issued` notification (planned, consistent with backend event naming).
- Until penalty history is in the contract, the rider sees the reliability notice on the order event timeline and the score change; details go in the appeal ticket body.

## Appeals flow

1. Penalty issued → rider opens an appeal within 14 days: `POST /support/tickets` with subject `Appeal: reliability penalty`, body template referencing the penalty, the order (`TicketCreate.orderId`), and the reason.
2. Evidence: text evidence in ticket messages (append-only, max 4000); photo evidence upload is `contract addition needed` (ticket attachments).
3. Routing: ticket track `rider`; rider operations (admin) reviews `OrderDetail.events`, pickup times, and dispatch logs.
4. Decision: upheld, overruled, or partially upheld, with a reason in the ticket thread.
5. Outcome notification: `appeal.resolved` (planned event) + ticket `resolved` status; score recalculates server-side on overrule.
6. Audit trail: ticket messages are append-only (SUPPORT.md) and every decision is an audit log entry; the requester can reopen within 14 days.

## Decision outcomes

| Decision | Effect |
| --- | --- |
| Upheld | Penalty stands; warning counters unchanged |
| Overruled | Penalty removed; score recalculated; warning reset |
| Partially upheld | Deduction reduced; remaining warning stands |

## Screen state checklist (penalty detail + appeal)

| State | Behavior |
| --- | --- |
| Loading | Skeleton penalty card / ticket thread |
| Empty | "No penalties in the last 90 days" + score card |
| Error | `ErrorResponse.message` + retry |
| Retry | Refetch score and penalties |
| Success | Penalty list, threshold explanation, appeal button per open penalty |

## Contract additions needed

- Penalty/reliability event history endpoint (or history on `RiderPrivate`).
- `penalty.issued` and `appeal.resolved` events in `backend/NOTIFICATIONS.md`.
- Machine-readable appeal decision payload (or reuse the ticket resolution reason).
- Ticket message attachments for evidence upload.
