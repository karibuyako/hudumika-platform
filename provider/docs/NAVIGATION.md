# HUDumika Provider — Navigation Blueprint

The provider app is a **distinct supply-side operating system** (the
"Dianping Manager" model) — not a variant of the merchant app. Its flow is
service-job driven: matching → offer → schedule → diagnose → quote → work →
confirm → settle → warranty. Every node maps to real contract endpoints.

## 1. Auth & onboarding

```
Splash → Login (OTP) → Provider onboarding (separate from merchant onboarding)
  ├── Identity & phone verification
  ├── Trade selection + professional certifications (GET/POST /providers/me/certifications)
  ├── Qualification documents (business license, trade licenses)
  └── Approval (pending/approved/rejected → fix issues)
```

- Capability check on login: `/providers/me/capabilities` drives the visible modules per role.
- Team members (owner/dispatcher/technician/supervisor) sign in under `/providers/me/staff` roles.

## 2. Main app (bottom tabs: Home | Jobs | Earnings | Profile)

```
Home ──┬─ Today's jobs (list by status: pending/accepted/scheduled/in progress/completed)
       ├─ Earnings today (pending/settled)
       ├─ Availability toggle + weekly schedule (AVAILABILITY.md)
       └─ Performance snapshot (rating, jobs done)
Jobs ──▶ Job Marketplace ──▶ My Jobs ──▶ Calendar
Earnings ──▶ Today / Pending / Settled ──▶ Withdraw
Profile ──▶ Certifications ──▶ Team (staff) ──▶ Settings ──▶ Help
```

## 3. Job Marketplace (`GET /dispatch/provider-jobs`)

```
Nearby jobs  ──▶ job card: summary, photos count, distance, estimate range,
Recommended ──▶ urgency, scheduledFor, matchScore + reasons (why recommended)
Offers       ──▶ acceptance window countdown (JOB_OFFER_EXPIRED)
Quote requests ──▶ "customer wants an estimate" → submit quote
Accept ──▶ booking → provider_accepted (technician assignment)
```

## 4. My Jobs (state-driven)

```
Pending → Accepted → Scheduled → In Progress → Completed → Cancelled
Job detail (all states):
  ├── Customer card (masked phone, address, job photos `BookingCreate.photos`)
  ├── Job timeline (booking events)
  ├── Navigation → customer location (en_route)
  ├── Contact customer (masked call / chat)
  ├── Diagnose → submit quote (quote_required) → customer decision (quote_accepted/declined)
  ├── Work (in_progress) → proof of service (photos/signature/notes + GPS)
  ├── Parts used (POST /bookings/{id}/parts) → final invoice (POST /bookings/{id}/invoice)
  ├── Complete → customer confirmation → settled
  └── Warranty (POST /bookings/{id}/warranty) + follow-up
```

## 5. Quotes

```
Create quote (labor + trip fee + parts) → quote_issued → awaiting approval
  ├── Approved → quote_accepted → proceed
  └── Declined → QUOTE_DECLINED → re-quote or cancellation policy
```

## 6. Calendar

- Weekly availability (`AvailabilityWindow`) + scheduled jobs by day; time-slot conflicts flagged.

## 7. Team & permissions (provider staff)

- `/providers/me/staff` — owner, dispatcher, technician, supervisor.
- Capability-based, never inherited: technician gets `view_assigned_jobs/accept_job/
  submit_quote/complete_job/upload_photos`; dispatcher gets `view_all_jobs/
  assign_technician/reassign_job/view_schedule/contact_customer/monitor_live_jobs`.
- UI renders only what the session's capabilities allow (`/providers/me/capabilities`).

## 8. Core flows (compact)

**Marketplace job** — browse nearby → accept offer (window) → scheduled → en_route →
arrived → diagnose → quote → approved → work → proof of service → parts → invoice →
customer confirms → settled → warranty issued.
**Quote request** — customer asks estimate → provider submits quote → approval → schedule.

## Screen states

Every screen: loading skeleton → empty ("No jobs in your area yet") → error + retry →
success; offers show countdown; mutations show in-flight spinner with rollback.
