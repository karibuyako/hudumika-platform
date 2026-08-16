# HUDumika Audit Logging

## Purpose

Every action that affects identity, money, status, or moderation is recorded
immutably so the platform can reconstruct what happened, by whom, and when.

## What gets logged

| Category | Examples |
| --- | --- |
| Identity | OTP verified, role switch, profile change, document upload/replace |
| Money | intent created, payment confirmed (webhook), refund, payout batch, exception resolved, adjustment |
| Status | order/booking transitions, cancellations, disputes, no-shows |
| Moderation | review publish/hide/delete, report resolution, content changes |
| Staff | admin login + MFA, approval decisions, ticket assignments, export actions, role changes |

## Entry schema

```json
{
  "id": "uuid",
  "actorUserId": "uuid",
  "actorRole": "merchant_ops",
  "action": "refund.created",
  "entityType": "payment_intent",
  "entityId": "uuid",
  "details": { "before": {...}, "after": {...}, "reason": "..." },
  "ipAddress": "10.0.0.1",
  "requestId": "uuid",
  "createdAt": "2026-08-12T09:30:00Z"
}
```

## Rules

- Append-only: no UPDATE, no DELETE. Corrections are new entries.
- `details` for money actions includes before/after amounts and the reason.
- Every mutation on a staff admin route automatically logs actor + requestId.
- Writes are async (outbox worker) so they never block the business transaction.
- Retention: 7 years for money and identity actions, 2 years for others.

## Access

- Queryable via `/admin/audit-logs` with filters (actor, entity, date range).
- Viewing sensitive entries requires the compliance reviewer role; exports are permissioned and themselves audited.
- Non-staff roles never see audit data.

## Observability link

`requestId` in the audit entry equals the request ID in application logs and
the error response, so an audit entry can be traced to exact log lines.
