# HUDumika RIDER — Vehicle Tools, Goals, Exports, Training

Professional tools from the blueprint pass, all live in `backend/API-CONTRACT.yaml`: vehicle maintenance, rider expenses, schedule & goals, export reports, and the training center. Money is TZS integer minor units rendered `TZS x,xxx` (never floats); timestamps are UTC ISO 8601 rendered in local time. Every screen follows the shared state checklist (loading / empty / error / retry / success).

## Vehicle maintenance (`GET` / `POST /riders/me/vehicle/maintenance`)

`VehicleMaintenance`: required `type`, `performedAt`; also `id`, `riderId`, `mileageKm` (nullable), `costTZS` (nullable), `notes` (max 500), `nextDueAt` (nullable, predictive-maintenance suggestion). `type` ∈ `oil_change | tire_pressure | battery_health | brake_service | general_service`. GET → array; POST → 201.

- Screen: Vehicle & Maintenance (NAVIGATION.md) — service history list + Add record form (type chips, `performedAt` date/time, optional `mileageKm`, `costTZS`, `notes`); POST returns the created record and the list refetches, sorted by `performedAt`.
- Predictive `nextDueAt`: server-computed from the predictive-maintenance model (usage patterns + vehicle type, `backend/AI-LAYER.md`). The contract field is live; model quality is backend-tracked. The card shows "Due {local date}" and, when `nextDueAt` falls inside the configured window, a due-soon reminder banner (client compares local time only — never predicts client-side). A record whose type matches a due service clears the banner on refetch.
- `MAINTENANCE_INVALID` → inline field error, draft kept.
- States: loading (history skeletons) / empty ("No maintenance records yet" + Add CTA) / error + retry / success (records with `costTZS` `TZS x,xxx`, due badges).

## Rider expenses (`GET` / `POST /riders/me/expenses`)

`RiderExpense`: required `category`, `amountTZS`, `incurredAt`; also `id`, `receiptUrl` (nullable URI), `deductible` (default false), `note` (max 500). `category` ∈ `fuel | maintenance | insurance | equipment | tax_deduction | other`. GET accepts optional `from` / `to` date filters; POST → 201.

- Screen: Expenses — list with period filter (`from`/`to`), category chips, Add expense form (amount `TZS x,xxx`, `deductible` toggle, optional receipt capture → `receiptUrl`, `note`).
- Deductible tracking: `deductible: true` flags the expense for tax season; the Expenses summary shows deductible vs non-deductible totals (display-only sums of returned rows — no client-side money logic beyond rendering).
- Tax tie-in: `POST /riders/me/exports` with `reportType: tax` (Export Center below) produces the tax report covering the window, including deductible expenses; the Export Center deep-links to the period Expenses view.
- `EXPENSE_INVALID` → inline field error.
- States: loading / empty ("No expenses in this period" + period picker) / error + retry / success (category rows, `TZS x,xxx`).

## Schedule & goals (`GET` / `PUT /riders/me/goals`)

`RiderGoals`: required `hoursGoalPerWeek` (1–100), `earningsGoalTZS`; `weeklyAvailability` `[{dayOfWeek (0–6), startTime ("09:00"), endTime ("18:00")}]`; `peakHourAlerts` (default true). PUT replaces the object; GET returns stored goals.

- Screen: Goals & Schedule — week-hour + earnings sliders, per-day availability rows, `peakHourAlerts` switch; PUT → 200 `RiderGoals` (server-validated).
- Goals progress on the Performance scorecard: `earningsGoalTZS` progress bar (PERFORMANCE.md) renders from the goals + performance views; the app only renders the display ratio, never computes earnings itself.
- `GOALS_INVALID` → inline field errors.
- States: loading (slider skeletons) / server defaults when no goals stored / error + retry / success (sliders, availability grid, alerts switch).

## Export reports (`POST /riders/me/exports`)

Request `{reportType, format, from?, to?}` — `reportType` ∈ `tax | earnings | trips`, `format` ∈ `csv | pdf | json`. Response 202 `{jobId (uuid), status: queued | processing | ready | failed}` — asynchronous, server-side.

- Screen: Export Center — report type × format picker + date window; submit → 202 accepted card with `jobId` and a status pill (`queued` / `processing`). No job-status endpoint exists in the contract: the app shows the accepted state and resolves on `data_export.ready` (in-app, when the backend emits it); the job outcome is server-side, never guessed.
- `EXPORT_IN_PROGRESS` → "An export is already running" — the existing job card is shown and new submissions are blocked until it completes.
- Tax report (`reportType: tax`) ties into deductible expenses and earnings for the window (Expenses section above; EARNINGS.md).
- States: loading (picker skeleton) / empty (no date window selected) / error + retry / success (accepted card with `jobId`, `status` pill, pending-until-ready copy).

## Training center (`GET /riders/me/training`, `POST /riders/me/training/{moduleId}/complete`)

`TrainingModule`: required `id`, `title`, `status`; `category` ∈ `safety | onboarding | skills | platform`, `durationMinutes`, `progressPct` (default 0), `status` ∈ `not_started | in_progress | completed | certified`, `certificateUrl` (nullable), `rewardTZS` (nullable completion bonus), `completedAt` (nullable). Complete → 200 `TrainingModule` with `status: certified` and `certificateUrl` set.

- Screen: Training Center — module cards grouped by category with `progressPct` bars; opening a module starts it (server-tracked progress); Complete → POST → certified card with certificate link + reward line.
- Reward credit: `rewardTZS` lands server-side as a `bonus` ledger entry (sign +) with the module reference (EARNINGS.md); the app renders `rewardTZS` on the certificate card and the statement entry — it never credits or estimates.
- `TRAINING_MODULE_NOT_FOUND` (404) → stale card removed + list refetch.
- This is the live core of the academy (EDUCATION.md): module categories map to the academy tracks (safety / onboarding / skills / platform); course video content and the onboarding completion gate remain planned.
- States: loading (module skeletons) / empty ("No modules available" + support link) / error + retry / success (progress bars, certified badges, reward `TZS x,xxx`).

## Per-screen states

| State | Behavior |
| --- | --- |
| Loading | skeletons per screen (history rows, sliders, module cards) |
| Empty | per-screen copy with the right CTA (Add record, Add expense, Pick window, Browse modules) |
| Error | `ErrorResponse.message` + retry; code-specific variants (`TRAINING_MODULE_NOT_FOUND` → refetch; `EXPORT_IN_PROGRESS` → show the running job) |
| Retry | refetch with the same filters; forms keep drafts |
| Success | server-shaped data; money `TZS x,xxx`; contract enums verbatim |
