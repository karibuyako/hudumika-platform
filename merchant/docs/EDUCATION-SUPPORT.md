# HUDumika Merchant — Education and Support

Learning resources and help surfaces for merchants: marketing academy, operation tips, business manager contact, service center, feedback, and FAQ. API-backed parts are the support ticket flow; content surfaces are static bundles (localized, environment-driven).

## Marketing academy

- Case studies and short courses on running the store: menu hygiene, promotion playbooks, group buy design, dine-in QR adoption, loyalty programs.
- Content model: static, localized bundles (`en` first, `sw`-ready, `ar`-capable) served from the app shell — no contract endpoint exists for courses; a content API is a proposed gap.
- Phase note: the academy library is not built yet; the tab renders the course index once content ships.

## Operation tips

- Contextual tips surface inside screens: e.g. "auto-accept between 30–300 seconds" on the acceptance toggle (SETTINGS.md), "verification history doubles as dispute audit" on voucher verify (GROUP-BUY.md).
- Tips render from the i18n bundle keyed by screen id — never hardcoded strings in code.

## Business manager contact

- Your dedicated business manager (account manager) contact: phone/email/office hours come from environment-driven config on the account payload — never hardcoded in the app.
- The contact card is visible to verified merchants only; unverified accounts see the service center instead.

## Service center (support tickets)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| POST | `/support/tickets` | Open ticket (`subject` ≤160, `body` ≤4000, optional `orderId`) | `Ticket` / 201 |
| GET | `/support/tickets/me` | Own tickets | `Ticket[]` |
| GET | `/support/tickets/{ticketId}` | Detail with `messages[]` | `TicketDetail` |
| POST | `/support/tickets/{ticketId}/messages` | Reply (`body` ≤4000) | `TicketDetail` / 201 |

- Priorities: `low` / `normal` / `high` / `critical`; statuses `open` → `assigned` → `in_progress` → `resolved` / `closed`. Replies from agents appear with `authorRole: agent`.
- Ticket categories map to prefilled subjects (payout account change, withdrawal issue, closure protection, promotion moderation appeal, device pairing).
- Screen states: list (loading skeleton → empty "No tickets yet" → error + retry → rows with status pills) and thread (loading → messages → reply composer with char limit → success toast).

## Feedback submission

- Product feedback uses the same ticket flow with a `feedback` subject convention — there is no dedicated feedback endpoint in the contract (proposed gap).
- In-app rating prompts are gated to real usage moments (after a completed settlement or export), never on first launch.

## Help / FAQ

- FAQ: localized bundle grouped by area (orders, dine-in, group buy, promotions, loyalty, wallet, staff/devices, settings); search is client-side over the bundle.
- Deep links: FAQ entries link into the relevant screen (e.g. "Withdrawal failed" → wallet) and to support tickets where escalation applies.
- Offline behavior: bundle ships with the app; ticket actions require network and show offline banners.

## Screen states and rules

- Academy/tips/FAQ: loading skeleton → empty (content not yet shipped) → error + retry → content list; article detail with local-time and locale rendering.
- Contact info comes from the environment/account payload — no hardcoded phones, emails, or URLs anywhere.
- MSW parity: ticket lifecycle (statuses, priorities, messages, `TICKET_UNAUTHORIZED`) must match the contract.

## Enterprise onboarding (planned services — not contract features)

- Training programs, implementation consulting, dedicated account manager, and SLA tiers for enterprise accounts are planned services for enterprise chain accounts (`merchant_groups` tier `enterprise`, `slaLevel`, `accountManager` — MULTI-STORE.md). They are services, not contract endpoints:
- Until they ship, the academy and help surfaces are the same for all accounts; no UI sells or promises SLA tiers, and the account manager card renders only from account payload data that actually exists.
