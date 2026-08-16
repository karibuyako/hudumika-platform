# HUDumika Support Tickets

## Tracks

| Track | Requesters | Default priority |
| --- | --- | --- |
| consumer | customer | normal |
| merchant | merchant members | normal |
| provider | providers | normal |
| rider | riders | normal |

Any role can open a ticket; tickets are tagged with the requester's role for routing.

## Lifecycle

```text
open -> assigned -> in_progress -> resolved -> closed
           \-> (reopen from resolved)
```

1. Requester opens a ticket (`POST /support/tickets`) with subject, body, optional order/booking reference.
2. Queue routing: auto-assign to the correct support team by role; priority from subject keywords or order/booking state (`critical` for payment or delivery issues).
3. Agent replies via messages; requester gets a notification (`ticket.reply`).
4. Requester or agent resolves; resolution requires confirmation from the requester where policy says so (money issues).
5. Closed tickets can be reopened within 14 days.

## Priority and SLAs

| Priority | Definition | Response SLA | Resolution SLA |
| --- | --- | --- | --- |
| low | general questions | 48 h | 7 days |
| normal | standard issues | 24 h | 72 h |
| high | payments, failed delivery, blocked account | 4 h | 24 h |
| critical | safety, fraud, data breach | 15 min | 4 h |

SLA timers run from first message; missed SLAs appear on the admin overview queue.

## Escalation

- High/critical tickets not touched within SLA → escalated to operations manager.
- Money disputes → linked to dispute hold on the order/booking payout.
- Legal/compliance matters → routed to compliance reviewer, auto-audited.

## Requester rules

- One open ticket per subject; duplicate subjects get linked, not stacked.
- Ticket messages are append-only; edits are not supported.
- Sensitive data (payment references, documents) is masked in the requester view.

## Admin surface

- Queue with filters: track, status, priority, agent, SLA overdue.
- Assign/reassign tickets; only staff with support roles may do so.
- Every state change is an audit log entry.
