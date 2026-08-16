# HUDumika RIDER — Academy (Planned)

The Rider Academy is the in-app training program for delivery partners: road safety, vehicle maintenance, delivery etiquette, city navigation, operations tips, and a direct line to the business manager.

Status: the training center core is LIVE in `backend/API-CONTRACT.yaml` — `GET /riders/me/training` + `POST /riders/me/training/{moduleId}/complete` deliver modules, progress, certificates, and `rewardTZS` completion bonuses (VEHICLE-TOOLS.md); module categories `safety | onboarding | skills | platform` cover the academy tracks below. Course video content, the onboarding completion gate, and the certification benefits remain planned (ROADMAP.md); every server-tracked capability not in the training center is marked `contract addition needed`.

## Course catalogue

| Course | Content summary | Certification |
| --- | --- | --- |
| Road safety | Defensive riding, helmet and visibility, speed limits, weather handling | Safety Certificate |
| Vehicle maintenance | Daily checks (brakes, tires, lights), fuel, scheduled service, breakdown basics | Maintenance Certificate |
| Delivery etiquette | Customer greeting, food handling, COD handling, review awareness | Service Certificate |
| City navigation | Service areas, landmarks, merchant pickup points, low-speed zones | Navigation Certificate |

## Onboarding courses

- Road safety is required before going online for new riders (planned gate; today the rider can go online once `verification: approved`, per ONBOARDING.md).
- The gate needs server-tracked completion: `contract addition needed` (course/progress endpoints).

## Certification milestones

| Milestone | Earns | Benefit (planned) |
| --- | --- | --- |
| Pass Road safety | Safety Certificate | Unlock online toggle (planned gate) |
| Pass all four courses | Rider Academy badge | Badge on profile (contract addition needed) |
| Recertification every 12 months | Renewed certificate | Maintains eligibility |

## Operations tips

- Stay online only when available: offers must be answered within the 120 s acceptance window (DISPATCH-FLOW.md).
- Declines are free, but repeated declines within one hour affect the reliability score (PENALTIES-APPEALS.md).
- Confirm pickup promptly; the 15 min pickup timeout triggers ops escalation (DISPATCH.md).
- Keep the delivery bag closed and upright; contact the customer only via masked numbers.

## City navigation guide

- Route timing from `GET /orders/{orderId}/track` (`estimateMinutes`); never compute ETAs locally.
- Deliver within the selected `deliveryZone` service areas from `GET /cities` (ONBOARDING.md step 6).
- Offline maps are device-side; map tiles never come from HUDumika servers.

## Business manager contact

- Each rider has a business manager (phone + email) shown in Academy and Settings.
- No hardcoded numbers: env-driven config today; `RiderPrivate.businessManager` is `contract addition needed` for account-specific contact.

## Feedback and help

| Need | Path |
| --- | --- |
| Course feedback | Support ticket (`POST /support/tickets`, subject prefilled with the course name) |
| Vehicle/zone questions | Support ticket (`TicketCreate` without order reference) |
| Incident or safety concern | Ticket with priority `high`; escalation per SUPPORT.md SLAs |

## Screen state checklist

| State | Behavior |
| --- | --- |
| Loading | Course card skeletons |
| Empty | No courses listed for an approved rider — empty state + support link |
| Error | `ErrorResponse.message` + retry |
| Retry | Refetch course list and progress |
| Success | Course list, progress bars, certificate cards |

## Contract additions needed

- Course catalogue + progress endpoints (list, start, complete) — LIVE via the training center (`GET /riders/me/training`, `POST /riders/me/training/{moduleId}/complete`: `progressPct`, `status` `not_started | in_progress | completed | certified`, `certificateUrl`, `rewardTZS`); remaining additions: course video/quiz content delivery and the `course.certified` notification event (backend NOTIFICATIONS.md catalog).
- Certificate/badge fields on `RiderPrivate`.
- `RiderPrivate.businessManager` contact object.
