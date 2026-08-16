# HUDumika Merchant — Security

Token storage, staff permissions, role switching, masking, logout. Server enforces RBAC on every route (AUTH.md); the client never decides permissions.

## Token storage

| Surface | Store | Details |
| --- | --- | --- |
| Mobile (Expo) | expo-secure-store | `Session` (accessToken, refreshToken) persisted in Keychain/Keystore; never AsyncStorage, never in logs |
| Web (Vite) | sessionStorage | session-scoped to the tab; cleared on tab close; http-only cookies considered only if the backend supports them |

- Access token: JWT, 15 min — kept in memory; refresh token rotates on every `POST /auth/refresh` (30 days).
- On any 401 the client attempts one refresh, then re-routes to login — a failed refresh clears stored credentials.
- Tokens never appear in MSW logs, analytics, or crash reports; request `requestId` is the trace handle instead.

## Merchant staff and permissions (`merchant_members`)

- A merchant can have staff members; permissions restrict financial and account actions (PRODUCT.md: "Staff permissions restrict financial and account actions").
- Model note: staff/member management is not yet in `backend/API-CONTRACT.yaml` — before building the staff screen, propose contract endpoints (list/update members, permission matrix). Until then the UI renders no member data and no fake permissions.
- Client behavior regardless of contract state: render actions by what the server accepts; a 403 surfaces as "You don't have permission" with a support path, never as a hidden or disabled button by client logic alone.

## Role switching (customer ↔ merchant)

- One person may hold multiple roles; switching requires a fresh `POST /auth/verify-otp` (re-verification) which issues a role-scoped `Session` (AUTH.md).
- `user.activeRole` + `roles[]` from `GET /users/me` drive the surface the app lands on; `GET /users/me/roles` lists switchable roles.
- Invariant: sessions never mix data. The merchant app only ever calls merchant-scoped endpoints with the merchant session; customer data (customer orders, addresses, payment intents) is never fetched, cached, or rendered inside the merchant session. Separate caches per role; clearing cache on role switch is mandatory.

## Masked fields (policy)

| Field | Mask rule |
| --- | --- |
| `payoutAccount` | masked in API responses by default; UI renders as-is (masked) |
| `AddressSnapshot.contactPhone` | masked phone per policy — first/last digits only, never full number; copy-to-clipboard disabled |
| Documents | statuses only (`missing`/`pending`/`approved`/`rejected`), never content preview in merchant UI |
| `providerReference` (payment) | masked in merchant-visible views |
| Customer PII in CRM surfaces | `maskedPhone` only from conversation participants; segments/journeys never render raw customer contact data (CRM.md) |

The client never unmasks, logs, or stores these fields beyond what the API returns.

## Enterprise data export (`/data/exports`)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| POST | `/data/exports` | Request an export | `DataExportJob` / 202 |
| GET | `/data/exports` | Jobs and status | `DataExportJob[]` |

- Body: `scope` (`all` / `orders` / `customers` / `catalogue` / `financial`), `format` (`csv` / `xlsx` / `json`).
- Job `status`: `queued` → `processing` → `ready` / `failed`; `downloadUrl` + `expiresInSeconds` on completion, `data_export.ready` in-app notification to the requester.
- Exports are permissioned (owner/manager), audited (backend/AUDIT.md, retention 7 years for money scopes), and rate-limited: `DATA_EXPORT_IN_PROGRESS` (concurrent job), `DATA_EXPORT_SCOPE_INVALID`, `DATA_EXPORT_RATE_LIMITED` (retry with wait). Staff see the queue via `GET /admin/data-exports`.
- Screen states: submit → 202 spinner → job table (poll status) → success card with expiry countdown; empty "No export jobs yet" / error + retry.

## Compliance (GDPR / PDPA / local)

- Tanzania: the platform follows the Personal Data Protection Act 2022 (PDPA) — lawful basis, consent records, data-minimization, and breach-notification obligations; customer PII is masked by default in merchant surfaces.
- International: GDPR-aligned practices (data portability, right to erasure via support tickets) and CCPA-style disclosure apply where operated.
- Customers own their data; `POST /data/exports` with scope `customers`/`all` is the data-ownership and portability path — permissioned, audited, rate-limited (consent rules in CRM.md apply to marketing use).
- On-prem / private deployment is an enterprise option that is planned, not built — the platform currently runs cloud-only; nothing in the client assumes a private topology.

## Logout

- `POST /auth/logout` revokes the session server-side (revoked_at), then the client clears local credentials.
- Mobile: also clears push token registration for the revoked session; web: clears sessionStorage.
- Logout must never leave partial session state; both surfaces clear auth context and route to login.
- Session expiry (401 after failed refresh) routes to login with a "session expired" notice; never silent.

## App-level hardening

- No secrets in client bundles: API URLs and any public config come from env (`EXPO_PUBLIC_*`/`VITE_*`); nothing sensitive is committed.
- Certificate pinning not in scope for release 1; transport is TLS-only, base URL is environment-driven.
- Sensitive inputs (OTP codes) are `secureTextEntry` (mobile) / `type="password"` (web) and cleared on submit.
- Rate-limit responses (429) honored with `retryAfterSeconds`; OTP flows respect resend countdowns (`resendInSeconds`).
- Audit: all identity, money, and status actions are server-side audit-logged (`AuditLog`); the merchant UI shows no audit data.

## Rules

- MSW parity: mock auth flows, masked fields, 401/403/409/429 responses must match the contract so security-sensitive UI paths are testable offline.
- Any new secret, endpoint, or permission must be proposed in the contract/backend docs before implementation.
