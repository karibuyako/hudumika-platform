# HUDumika Merchant — CRM

Customer segmentation and automated journeys across the chain, plus the privacy rules that govern customer data. Segments and journeys are contract-live (backend M9c); the unified customer profile view is a planned contract addition and is not built.

## Segmentation (`/segments`)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/segments` | Segment list | `CustomerSegment[]` |
| POST | `/segments` | Create a segment | `CustomerSegment` / 201 |

`CustomerSegment`: `name` (≤80), `rules` (opaque rules object, server-validated), `memberCount`, `createdAt`.

- Invalid rules → `SEGMENT_RULES_INVALID` (422 with field errors).
- Segments are chain-scoped (`merchant_group_id`) and evaluated server-side; `memberCount` is computed, never client-estimated.
- Screen: list (loading skeleton → empty "No segments yet — create your first" → error + retry → cards with `memberCount`) and editor (rule builder form → validation → saving → success toast).
- Rule builder honesty: the editor edits the `rules` object with the field shapes the API accepts; unsupported predicates are not offered.

## Automated journeys (`/journeys`)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/journeys` | Journey list | `CustomerJourney[]` |
| POST | `/journeys` | Create a journey | `CustomerJourney` / 201 |

`CustomerJourney`: `name` (≤80), `trigger` (e.g. `order.completed`), `actions[]`, `status`, `createdAt`.

| Action field | Values |
| --- | --- |
| `type` | `push` / `sms` / `coupon` / `email` |
| `delayHours` | integer (required per action) |
| `template` | message template string |

- Statuses: `draft` / `active` / `paused`; invalid triggers → `JOURNEY_TRIGGER_INVALID`.
- Journey editor: trigger picker + ordered action list (type, delay, template) → activate/pause toggle; states: loading skeleton → empty → error + retry → success.
- Delivery of actions uses the existing notification channels (push, SMS, email) via the notification outbox — the CRM layer does not add a separate messaging stack.

## Unified customer profile — planned (contract addition)

- Segments and journeys are backed by a unified customer profile view (orders, spend, visits across stores) server-side; a dedicated customer-profile endpoint (search, 360° view, profile edits) is a planned contract addition, not in the contract today.
- Until it lands, the CRM screens render segments, member counts, and journeys only — no per-customer profile UI and no fabricated profile data.

## Omnichannel note

- Channels available today: push, SMS, and email via notification preferences and journey actions; in-app center covers the rest.
- WeChat-like private-domain messaging (private group chat surfaces beyond in-app conversations) is planned, not built — no UI claims it exists.

## Privacy

- Customer data is masked by default: conversation participants expose `maskedPhone` only (MESSAGES.md); journey/segment screens never render raw customer PII.
- Consent: marketing actions (SMS/email journeys) respect customer notification preferences and consent — channel toggles are customer-controlled, high-priority system events excepted (backend/NOTIFICATIONS.md).
- GDPR/local compliance: customers own their data; the enterprise data export path (`POST /data/exports`, scopes `all`/`orders`/`customers`/`catalogue`/`financial`) is the data-ownership and portability mechanism (SECURITY.md), permissioned and audited.
- No hardcoded contact data anywhere; identifiers come from the API only.

## Screen states and rules

- All CRM screens: loading skeleton → empty → error + retry → success; mutations optimistic with server rollback (422/409).
- MSW parity: segment shapes (`rules`, `memberCount`), journey shapes (trigger, `actions[]` with `type`/`delayHours`/`template`, statuses), and error codes (`SEGMENT_RULES_INVALID`, `JOURNEY_TRIGGER_INVALID`) must match the contract.
