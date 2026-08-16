# HUDumika Provider — Trust and Safety

How the platform verifies providers, scores trust and risk, and keeps home-entry work safe. Trust data lives in `provider_trust`, documents in `provider_documents` (DATA-MODEL.md). This doc covers the trust profile, risk flags, the document service, the verification engine, home-entry safety, and the quality signals that feed matching.

## Trust profile (`TrustProfile`)

`GET /providers/me/trust` → `TrustProfile`:

| Field | Meaning |
| --- | --- |
| `trustScore` | 0–100, read-only |
| `riskScore` | 0–100, read-only |
| `flags` | Active risk flags (below) |
| `verifiedBadge` | Boolean; shown on profile and job cards when true |
| `tier` | `bronze` \| `silver` \| `gold` \| `platinum`, default `bronze` |

`TRUST_PROFILE_UNAVAILABLE` when the profile is not computed yet (e.g. pre-approval). The client renders scores read-only, never computes or predicts them.

## Risk flags

Flags are server-assigned (`flags[]` enum); each raised flag notifies the provider owner and ops (`trust.flag_raised`):

| Flag | Meaning |
| --- | --- |
| `off_platform_payment` | Payment asked for or taken outside the platform |
| `price_manipulation` | Quoted/priced to game commission or estimates |
| `false_completion` | Completion claimed without the work being done |
| `fake_reviews` | Review manipulation signals |
| `location_spoofing` | Check-in/location spoofing signals |
| `repeated_cancellation` | Pattern of late or repeated cancellations |
| `account_sharing` | Session or identity shared across accounts |
| `identity_mismatch` | Verified identity does not match the working identity |

UI rules: a flagged provider sees each flag with a plain-language explanation and the appeal path (support ticket referencing the flag — flag IDs are not exposed in the contract yet, so reference the notification `requestId` in the ticket body). Flags never render counts or scores the API does not provide.

## Document service (`ProviderDocument`)

`GET/POST /providers/me/documents` lists/uploads; `PATCH /providers/me/documents/{documentId}` updates (renewal, re-upload). Data in `provider_documents`.

| Field | Meaning |
| --- | --- |
| `type` | `identity` \| `license` \| `certificate` \| `insurance` \| `tax` \| `registration` \| `vehicle` \| `background_check` \| `training` |
| `url` | Secure upload URI |
| `status` | `uploaded` → `processing` → `verified` \| `rejected`; `expiring` (near expiry) \| `expired` |
| `expiryDate` (nullable) | Drives `expiring`/`expired` transitions |
| `verifiedAt` | UTC when verified |

Rules:

- Upload requires `type` + `url` (`expiryDate` optional). `DOCUMENT_EXPIRED` blocks re-submitting an already-expired document as if fresh — upload a renewal (`PATCH` with new `url`/`expiryDate` re-enters `processing`).
- `document.expiring` / `document.expired` in-app notifications prompt renewal; expired documents show a danger pill and, where a document gates a capability (e.g. an insurance requirement), block the related action until renewed.
- `DOCUMENT_NOT_FOUND` on unknown IDs (no existence leaks).

## Provider verification engine

| Stage | Status |
| --- | --- |
| Identity verification | Government ID documents via the document service; selfie/liveness capture — planned |
| Professional qualification | Certifications (`provider_certifications`, ONBOARDING.md) and trade documents; `CERTIFICATION_EXPIRED` gates listings |
| Operational qualification | Business registration/tax documents; operational readiness checks |
| Platform verification | Background check, references, probation period — planned; `verifiedBadge` reflects the completed state |

The engine is server-side; the app renders per-stage states (pending/verified/rejected) and never simulates verification.

## Safety for home entry (existing)

- Verified badge: `verifiedBadge` shows on the profile and job cards.
- Live location during job: location sharing during active jobs (per `en_route`/`in_progress`); see ARCHITECTURE.md location privacy.
- Masked contact: customer contact goes through masked relay (SECURITY.md, PRODUCT.md) — never direct numbers.
- SOS: safety events route to ops (backend DISPATCH.md safety escalation patterns); incidents report through support tickets with booking reference.
- Off-platform payment and identity-mismatch behaviour: see Risk flags above; never prompt off-platform payment.

## Multi-dimensional ratings → quality signals → matching

Reviews now carry dimensions (`ReviewCreate.dimensions`, all 1–5 except `wouldRecommend` boolean): `professionalism`, `punctuality`, `quality`, `communication`, `priceTransparency`, `cleanliness`, `wouldRecommend`. The provider sees dimension averages where surfaced by the API — never client-computed.

Dimensions and operational data feed server-side quality signals:

| Signal | Source |
| --- | --- |
| Completion rate | Completed vs cancelled jobs |
| On-time rate | Check-in and completion timing vs `scheduledFor` / `slaDeadlineAt` |
| Cancellation rate | Provider cancellations and no-shows |
| Repeat rate | Return customers and recurring plan retention |
| Response time | Offer/request response latency |

Signals feed matching (`ProviderJobOffer.matchScore` + `reasons[]` transparency in DISPATCH.md), the trust/risk profile, and tier progression. The client renders signals and scores read-only from the API.

## Screen states

| Screen | Loading | Empty | Error / retry | Success |
| --- | --- | --- | --- | --- |
| Trust profile | Skeleton cards | — | `TRUST_PROFILE_UNAVAILABLE` → explain not computed yet | Score cards, badge, tier, flags list |
| Documents list | Skeleton rows | "No documents yet — upload your first document" CTA | Retry button | Cards: type, status pill, expiry date |
| Document upload | Submitting state | — | `VALIDATION_FAILED`; `DOCUMENT_EXPIRED` → renew instead; upload failure → retry | `201` → `uploaded` pill, list refetch |
| Renewal | Renewing state | — | `DOCUMENT_NOT_FOUND` → refetch | `processing` → `verified` pill |
| Ratings summary | Skeleton | "No ratings yet" | Retry | Dimension averages + quality signals read-only |

## Cross-cutting

- Timestamps are UTC from the API; render local time.
- Every screen implements loading, empty, error, retry, and success states; nothing is hardcoded (scores, tiers, flags all from the API).
- MSW handlers mirror these endpoints 1:1 with `backend/API-CONTRACT.yaml` (MSW parity); error codes from `backend/ERROR-CODES.md`.

## Additional signals (planned)

- **Collusion** detection (coordinated fake jobs/reviews) and **promo abuse** join the trust flags.
- **Location freshness** (stale pings = suspicious) is tracked alongside GPS-spoof detection.

## License and certification tracking

Expiration and renewal dates are tracked per document/certification; `document.expiring`/`document.expired` notifications drive renewals, and expired licenses gate matching for affected services.
