# HUDumika Merchant — Onboarding

Application → verification → live. Until `verification.status` is `approved`, the verification screen (profile → Store verification) and the dashboard under-review banner are the gate surfaces; the tabs themselves are not hard-locked (soft gate — the hard tab-lock is a tracked ROADMAP P1 follow-up).

## Flow

1. Select `businessType` (restaurant, shop, grocery, pharmacy, retail, tickets, other — from `MerchantApplication`).
2. Submit `businessName`, `contactPhone`, `contactEmail`, `city`, `description`.
3. Upload documents: registration, licence, tax, bank/mobile-money details, category-specific documents (PRODUCT.md).
4. `POST /merchants` → `LeadCreated` (`status`: submitted/under_review).
5. Merchant record is created server-side; app reads `GET /merchants/me`.
6. Operations reviews (admin flow); decision lands in `MerchantPrivate.verification`.
7. On approval, commercial terms appear; merchant publishes the store via the catalogue.

## Store claiming (existing listing)

Merchants who are already listed (e.g. seeded by operations or discovered on the platform) claim the existing store instead of applying fresh:

1. Phone signup with `purpose: verify_role`/`signup` (`/auth/request-otp`, `/auth/verify-otp`).
2. Search the listing by name/city (`GET /merchants`, public approved only) or receive the store link from support.
3. Claim it: `POST /merchants/claim` with `MerchantClaim` — `merchantId` (the existing listing), `contactPhone`, optional `documentsNote` ≤500 → `LeadCreated` / 409.
4. Conflicts (409): `CLAIM_ALREADY_PENDING` (claim in review), `CLAIM_LISTING_NOT_FOUND` (listing does not exist), `CLAIM_LISTING_OWNED` (already linked to an account) — each maps to its own banner with the right next step.
5. Claim leads into the standard verification flow: submit qualification documents plus proof of control (registration in the same business name, licence, operator identity); operations reviews and the account links to the store on approval (same `VerificationState` gate as a fresh application).

## Verification states (VerificationState)

| State | UI behavior |
| --- | --- |
| `pending` | Application received. Status screen: expected review time, document list, contact support. Poll `GET /merchants/me`. |
| `documents_review` | Operations is checking documents. Status screen with checklist; allow uploading/retaking documents. |
| `approved` | Unlock dashboard. First-run banner shows commercial terms (see below). |
| `rejected` | Show rejection reason (from decision). Re-application only where operations permits; otherwise support contact. |
| `suspended` | Store paused by operations. Orders frozen; earnings locked; show reason and support path. No self-resume. |
| `changes_requested` | Operations requested edits. Show the request, allow re-submission (see Re-submission). |

Every transition also arrives as `lead.reviewed` notification (SMS + in-app) per `backend/NOTIFICATIONS.md`.

The profile tab renders the qualification status at all times: `VerificationState` badge (from `GET /merchants/me`), per-document status (`missing`/`pending`/`approved`/`rejected`), and commercial terms once approved (see `(tabs)/profile/verification.tsx`). While not approved, the dashboard shows an under-review banner that links to this screen; register-submit redirects to it directly. Locked modules are not hard-blocked.

## Document upload requirements

| Document | Required for | Notes |
| --- | --- | --- |
| Business registration / BRELA | all | image/PDF upload, clear scan |
| Trading licence | all | category-specific variant |
| Tax (TIN) certificate | all | |
| Bank account or mobile-money details | payout setup | shown masked after save (`payoutAccount`) |
| Category-specific | pharmacy, food, retail, travel | list driven by `businessType` |

Upload rules: client validates size and type; document status (`missing`/`pending`/`approved`/`rejected`) is server-owned — the UI renders status, never decides it. Retake replaces the document; re-upload returns state to `pending`.

## Commercial terms (visible once approved)

From `MerchantPrivate.commercial`:

| Field | Display |
| --- | --- |
| `commissionRateBps` | Commission as percentage: basis points / 100 (e.g. 850 bps → 8.50%). Explained as the platform's share of each completed order, deducted at settlement, not per-sale in the UI. |
| `payoutCycleDays` | Payout cycle in days (default 3): how often the ledger balance is batched to the payout account. |
| `payoutAccount` | Masked payout account (bank or mobile money). |

Display rules: shown prominently on first approval; a "Commission" card in earnings re-states the rate; terms are backend-configured (PRODUCT.md — never frontend constants).

## Onboarding wizard (`/onboarding/*`)

- `GET /onboarding/status` → steps + `currentStep` + `completed`/`submittedAt` (mirrors the setup guide, TASKS-RISK.md).
- Steps: profile (`POST /onboarding/profile`: businessName, category, city, address) → documents (`POST /onboarding/docs`: type + pre-signed url) → submit (`POST /onboarding/submit`).
- `ONBOARDING_ALREADY_SUBMITTED` blocks re-submit; after submission the store moves to `pending` verification (below).
- Staging helper `POST /onboarding/demo-approve` simulates the approval for demos — never available in production builds.

## Re-submission

| State | Allowed action | Endpoint |
| --- | --- | --- |
| `changes_requested` | Edit profile + re-upload documents, then submit again | `PATCH /merchants/me`, document re-upload |
| `documents_review` | Replace missing/rejected documents | document upload |
| `rejected` | Contact support; re-apply only if operations permits | `POST /support/tickets` |

Re-submission returns the merchant to `pending`/`documents_review`; the app shows the updated state on the next poll.

## Screen states (required everywhere)

- Loading: skeleton/indicator while `GET /merchants/me` and document list load.
- Empty: no documents yet — upload CTA.
- Error: network/session failure with retry.
- Retry: explicit retry button; honors `Retry-After` on 429.
- Success: approval banner, terms card, "Go to dashboard" CTA.

## Business rules (SHARED-FLOWS)

- One person may hold multiple roles; onboarding is per merchant role and never mixes customer data.
- A merchant cannot publish a catalogue without `approved` verification (PRODUCT.md acceptance criteria).
- Documents and payout details are masked in API responses by default (AUTH.md).
