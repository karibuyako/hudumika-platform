# HUDumika Merchant — AI and Automation

What exists today, what is phased, and what is planned — stated honestly. No UI surface pretends an AI capability exists before the backend milestone ships.

## What exists (contract-live or phased-but-contract-defined)

| Capability | Status | Details |
| --- | --- | --- |
| AI diagnostics (`GET /analytics/diagnostics`) | Contract-defined, phased backend M7e — not built yet | `[{severity: issue \| warning \| opportunity, topic, insight ≤2000, action}]`. The diagnostics card renders a "coming in a later release" gate until it ships; no mock fabricates insights (ANALYTICS.md). |
| Scheduled reports (`/reports`) | Live, backend M9c | Recurring reports (`reportType` revenue/orders/products/traffic/inventory/financial, `cadence` daily/weekly/monthly, `format` csv/xlsx/pdf, `recipients`, `storeIds`, `enabled`) delivered to email; `report.ready` notification to recipients (backend/NOTIFICATIONS.md). |
| Automated customer journeys (`/journeys`) | Live, backend M9c | Trigger → delayed actions (`push` / `sms` / `coupon` / `email` with `delayHours`) per CRM.md — automation built on the notification outbox, not a separate AI stack. |

### Scheduled reports (`/reports`) — the automated-delivery path

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/reports` | Scheduled report list | `ScheduledReport[]` |
| POST | `/reports` | Create a schedule | `ScheduledReport` / 201 |
| PATCH | `/reports/{reportId}` | Update a schedule | `ScheduledReport` |
| DELETE | `/reports/{reportId}` | Delete a schedule | 204 |

- Editor: name ≤160, report type, cadence, format, recipients (email), optional store filter + enabled toggle; errors `REPORT_SCHEDULE_INVALID`, `REPORT_RECIPIENT_INVALID`, `REPORT_NOT_FOUND`.
- List screen: loading skeleton → empty ("No scheduled reports") → error + retry → rows with cadence/format pills and `lastRunAt`.
- This is the automated reporting baseline; chain report export (`POST /chain/reports`) stays manual-on-demand (ENTERPRISE-FINANCE.md).

## Planned (contract additions — not built)

| Capability | Status | Note |
| --- | --- | --- |
| AI customer service auto-replies | Planned | Would tie into the chat auto-reply configuration surface (MESSAGES.md); no auto-reply endpoint exists — do not invent one. |
| Predictive analytics / forecasting | Planned | No forecast endpoints in the contract; the finance screens render no predictions (ENTERPRISE-FINANCE.md). |
| Automated marketing suggestions | Planned | Would build on segments/journeys (CRM.md); no suggestion engine exists today. |
| Generative copy/product descriptions | Planned | No assistant endpoint; the catalogue editor exposes no AI card (MENU-CATALOGUE.md). |

## Rules

- Every AI surface renders loading / empty / error / retry / success states like any other screen, but the "not shipped" state is an honest gate, not a mock result.
- MSW parity: diagnostics placeholder shape, scheduled report payloads, and error codes (`REPORT_SCHEDULE_INVALID`, `REPORT_RECIPIENT_INVALID`) must match the contract; no mock generates insight content.

## Screen states

- Scheduled reports: list (loading skeleton → empty "No scheduled reports" → error + retry → rows with cadence/format pills and `lastRunAt`) and editor (form → 422 field mapping → saving spinner → success toast).
- Diagnostics card (when M7e ships): loading → empty ("No insights yet") → error + retry → insight list with `severity` pills (issue/warning/opportunity) and `action` where present; until then the gate card renders only.
- Reporting status is never guessed: `report.ready` notifications and `lastRunAt` are the only signals that a report was delivered.
