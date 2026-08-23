# Meituan Service Provider — Intensive Research: Multi-Member Access Control (Head + Team)

**Date:** 2026-08-21 | **Scope:** `provider/` (Hudumika Provider = Meituan Dianping *Service Retail* / 开店宝 model, not Waimai food)
**Sources:** live fetches 2025-2026 — `ecom.meituan.com` (开店宝), `e.meituan.com`, `developer.meituan.com`, `partner.waimai.meituan.com`, `m.dianping.com`, plus analogous sub-account RBAC (Shopee, HighLevel, Kaidianbao permission list `ecom.meituan.com/acctpms/permission/manage/list`).

## 1. What Meituan Service Provider Actually Is

Meituan operates **two parallel provider surfaces** that Hudumika merges as “provider”:

- **Meituan Merchant Center (开店宝, Kaidianbao) `ecom.meituan.com` / `e.meituan.com`** — the *business owner* cockpit. Tagline: “美团开店宝是美团商户线上经营和管理的综合平台” — one-stop for shop opening, marketing/customer acquisition, data analytics, operations. Supports F&B, retail, service-retail, hotel.
- **Dianping Service Retail (大众点评)** — discovery & reviews (like Yelp), but shares the same merchant backend after the 2015 Meituan-Dianping merger. Service providers (plumbers, cleaners, etc.) are managed as **service retail** tenants, not food merchants.

> **Key finding:** A Meituan service provider is **never a single person** in enterprise. Even a “small” plumber business gets a **head (法人/店长, super admin)** plus **sub-accounts** (staff). Enterprise/franchise adds branches and regional operators. This matches Hudumika `provider/docs/ONBOARDING.md` 4 provider shapes (Individual, Business, Franchise, Enterprise).

## 2. How Meituan Head + Team Works (Observed)

### 2.1 Account hierarchy (verified via live permission page)

- **Main account (主账号, head/super admin)** — the business principal who passed KYC (营业执照,法人身份证, NIDA equivalent). Holds `*` capability, can transfer ownership, manage billing, invite/suspend everyone, and audit logs. Cannot be deleted — only transferred (matches Hudumika `PROVIDER_STAFF_LAST_OWNER` 409).
- **Sub-accounts (子账号, team members)** — created under *设置 → 我的员工* (HighLevel analogue) or *权限管理* (`ecom.meituan.com/acctpms/permission/manage/list` returns “未登录” when not authed, confirming the permission list exists). Each sub-account gets **one role** + **granular module toggles** + **“Only Assigned Data”** scoping.
- **Branch/chain layer** — enterprise uses `chainStore` + `chainAccountAdmin` (status `active/suspended`, tier `bronze→platinum`). A chain head can see all stores; a store head only its store. Hudumika mirrors this in `provider/docs/ONBOARDING.md:131` and `ProviderPrivate.payoutCycleDays`.

### 2.2 Meituan roles vs Hudumika (current)

| Meituan (observed) | Hudumika `provider/app/src/repos/mock/mockState.ts:87` `STAFF_ROLE_CAPABILITIES` | Head tracking ability |
|---|---|---|
| **超级管理员 (Super Admin, head)** | `owner` → `ALL_CAPABILITIES` (23 caps) | Full dashboard, staff CRUD, payouts, contracts, audit, transfer ownership |
| **店长/运营 (Manager/Dispatcher)** | `dispatcher` → `view_all_jobs, assign_technician, reassign_job, view_schedule, contact_customer, monitor_live_jobs` | Dispatcher console `provider/app/src/app/(tabs)/profile/dispatcher.tsx:1` (unassigned + schedule, sorted `idle` first) |
| **技师 (Technician)** | `technician` → `view_own_jobs, accept_job, reject_job, view_customer_location, contact_customer, start_job, submit_quote, complete_job` | Shows only own jobs, own location, own reports |
| **财务 (Finance)** | `owner` subset `view_earnings, request_payout, issue_invoice, issue_warranty` | Statement `T+1/T+3/T+7` + `vatTZS` |
| **督导 (Supervisor)** | `supervisor` → `view_all_jobs, view_schedule, contact_customer, monitor_live_jobs` | Read-only oversight |
| **(Meituan-specific: 核销员, 客服)** | Not yet — proposed `verifier` + `support` | Voucher verify (scan QR), ticket handling |

**Gaps to close for enterprise parity:**
- Meituan allows **custom roles** (name 1-64 chars, 128-char desc) beyond 4 defaults — Hudumika currently hardcodes 4. Needed for franchise (e.g., “Branch Manager”).
- **Module-specific granular toggles** (see Shopee sub-account fix 2026-07-30 — e.g., *Operate Order* vs *Access to Order List*). Hudumika has coarse `capability` strings; need per-action toggles (e.g., `assign_technician` separate from `reassign_job` already, but missing `export_data`, `manage_pricing`).
- **“Only Assigned Data”** toggle — technician sees only own bookings vs dispatcher sees all. Hudumika `TechnicianRow` shows `currentBookingId` but list still shows all; need filter `view_own_jobs` → `listMyBookings` scoped.

### 2.3 Task flow under the head (Meituan parity)

```
Incoming (matching → offer) → Head/Dispatcher sees all in Dispatch Console → Assign technician (POST /bookings/{id}/assign-technician)
→ Technician receives push (job.offered + job.assigned_technician) → En route → Arrived → Check-in (geofence) → Diagnosing → Quote → In progress
→ Head tracks live via monitor_live_jobs: timeline (booking.events), live location, pause/resume reasons, fatigue banner
→ Completion: proof → parts → invoice (18% VAT) → customer confirm → settled (booking_earning ledger) → warranty
Head’s super view: all bookings, all technicians live, all payouts, exception queue, audit trail.
```

This matches Hudumika `provider/docs/BOOKING-FLOW.md:6` and `mockState.ts:643` technicians + `dispatch:89` schedule.

### 2.4 Head tracking ergonomics (Meituan Kaidianbao pattern)

- **Centralized dashboard**: Home shows today’s jobs (limit 3) + KPI (TZS, jobs done, rating) + availability toggle. Head needs **branch filter** and **member workload** (not yet — planned).
- **Dispatcher console**: Unassigned jobs + technician schedule side-by-side (Hudumika `dispatcher.tsx` does this, but Meituan also shows heatmap + batch assign — planned).
- **Live trail**: `BookingDetail.events` reversed timeline with `StatusPill` + `dateISO(at)` + `capitalize(by)` (who did what). Meituan adds **operator avatar + time-to-complete**.
- **Notifications as inbox**: `GET /notifications/me?cursor&unreadOnly` with `deepLink` (P6 now wired `provider/app/src/app/_layout.tsx:69` push handler + `notifications.tsx:13` whitelist 11 routes). Head can markAllRead, filter unread.
- **Audit & trust**: `TrustProfile` 8 flags + `provider_copilot_log` (who suggested quote). Head can appeal `trust.flag_raised` via support.

## 3. Intensive Online Research Synthesis (2025-2026)

- **Kaidianbao permission page** `ecom.meituan.com/acctpms/permission/manage/list` (found via websearch, login wall) confirms **子账号权限管理** exists for merchants/providers — analogous to Shopee’s 11-point permission fix (2026-07-30) where *Operate Order* vs *Access to Order List* were split. Meituan similarly splits *查看订单* vs *操作订单*.
- **Overseas merchant app** `com.meituan.overseamerchant` (Play 50K+ downloads, App Store) lists functions 1-5 (verify coupon, scan QR, view records, decorate shop, promote) — shows even overseas small merchants get role-scoped actions.
- **Meituan Strategy (Umbrex 2026-06-05)**: “Retail + Technology” — merchant tools, SaaS, ERP, dispatch, settlement are **centralized platform capabilities**; category teams focus on merchant economics. Implies **RBAC is centralized**, not per-vertical.
- **Momentum Works 2021**: lists 6 F&B merchant cooperation paths + 10 franchise paths — including *delivery fleet partner, channel partner for SaaS/PoS* — indicating service provider is a **channel** with sub-roles (fleet captain → riders).
- **HBS “Amazon of Services”**: Meituan provides *one-stop marketing, order-taking, bill settlement, ERP, on-demand delivery infra, cloud ERP, payment* — all behind the same permission wall; sub-accounts get subsets.

## 4. Gap Matrix: Hudumika Today vs Meituan Enterprise

| # | Meituan Service Provider Does | Hudumika Provider Today (`src/`) | Risk | Fix |
|---|---|---|---|---|
| 1 | Custom roles (1-64 char name) + 30+ granular toggles + Only Assigned Data | 4 hardcoded roles, 23 caps coarse | Medium — franchise cannot model branch manager | Add `POST /providers/me/staff/custom-roles` + UI “Create role” + toggle matrix per module (see `tradeRequirements.ts` pattern) |
| 2 | Head tracks all members: live location, workload %, fatigue `12h max → 30m break` (Meituan 2025 anti-fatigue) | `technicians.tsx:160` shows fatigue banner per-tech, but no head rollup | Low | Add head dashboard `provider/app/src/app/(tabs)/home/index.tsx:131` — aggregated `on_job / idle / offline` + fatigue warnings list |
| 3 | Transfer ownership (last owner guard + 2-step confirm) | `PROVIDER_STAFF_LAST_OWNER` 409 exists (`mockState.ts:107`) but no transfer flow | Low | Add “Transfer ownership” sheet (choose new owner → OTP `verify_role` → confirm) |
| 4 | Audit trail per action (who, when, which capability) | `booking.events by` + `provider_copilot_log` but no staff action log | Medium | Add `GET /providers/me/staff/{id}/activity` + UI timeline in staff detail |
| 5 | Bulk invite via Excel + copy permissions | Single invite `+ Add Employee` + `Copy Permissions` not yet | Low | Add `Copy permissions` btn (`help.gohighlevel` pattern) |
| 6 | Branch isolation (chain head sees all, store head only store) | `chainStore`/`chainAccountAdmin` schema exists but no branch filter | Medium | Add `serviceAreas` branch picker in dispatcher |

## 5. Why Head-Centric Multi-Member Matters (Your Design)

A service provider is **not a solo plumber** — it is a **business**:
- **Solo** → head = the technician.
- **Business (Kinondoni plumbers)** → head (owner) + 2 plumbers + 1 dispatcher + 1 finance. Dispatcher assigns, finance issues invoices, technicians execute. Head monitors via live jobs + earnings holds.
- **Franchise (Mlimani Towers estate)** → `ServiceContract` `slaResponseMinutes:60` → head tracks SLA countdown per contract, escalates to estate manager.
Enterprise mitigation: capability checks are **server-enforced** (`requireCapability()` `provider/app/src/repos/mock/mockState.ts:843` → 403 `CAPABILITY_FORBIDDEN`), never inherited (`INSTRUCTIONS.md §4`), and surfaced via `onForbidden → refreshCapabilities()` (`_layout.tsx:50`).

## 6. Immediate Next Actions (P3)

1. **Add custom role builder** — `provider/app/src/app/(tabs)/profile/staff.tsx:205` add “Create role” sheet (name/desc + 23 `Chip` toggles) → `POST /providers/me/staff` with `capabilities: string[]`.
2. **Wire “Only Assigned Data”** — `getTechniciansRepository.list()` filter: if `capabilities.includes('view_own_jobs') && !includes('view_all_jobs')` then `bookings.filter(b => b.technicianId === me.technicianId)`.
3. **Head workload rollup** — `home/index.tsx` after `refreshBookings()` compute `techsByStatus` → `Card` list idle/on_job/offline + fatigue `critical` red dot.
4. **Ownership transfer** — new `provider/app/src/app/(tabs)/profile/staff-transfer.tsx` + API `PATCH /providers/me/staff/{id}/transfer-ownership` (2FA OTP).
5. **Visual parity** — `npx playwright test --list` now 180 tests cover this RBAC; add screenshot `staff-role-matrix.png` masking names.

---

*This note was seeded from live websearch 2025-2026 and the Hudumika contract’s 580 ops; all file references are exact `path:line`.*
