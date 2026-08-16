# HUDumika Provider — Security

Security rules for the provider surfaces. Server enforces RBAC on every route (AUTH.md); the client's job is safe storage, role isolation, masking, and privacy.

## Token storage

| Surface | Storage | Notes |
| --- | --- | --- |
| Mobile (Expo) | `expo-secure-store` | Access + refresh tokens; never AsyncStorage. Keychain/Keystore-backed |
| Web (Vite) | `sessionStorage` | Per-tab session; no tokens in `localStorage` (survives XSS windows and persists too long). Clearing sessionStorage logs out |

Session handling:

- Access token: JWT, 15 min; refresh token: opaque, 30 days, rotated on every refresh (`POST /auth/refresh`).
- Refresh interceptor: on `401 UNAUTHORIZED` / `SESSION_EXPIRED` → single refresh attempt → retry once → else force logout.
- Logout calls `POST /auth/logout` (revokes server-side) then wipes local tokens in both surfaces.
- Never log tokens or authorization headers; `requestId` is the trace link in support.

## Role switching

- One person may hold multiple roles (`GET /users/me/roles`); sessions are role-scoped and must never mix permissions or data views (SHARED-FLOWS.md).
- Role switch = new `verify-otp` call with `purpose: verify_role`; the returned session is scoped to the target role (AUTH.md step 6).
- Implementation rule: one session per role in storage — a `provider` session and a `customer` session never share query keys, state, or UI trees. On switch, clear role-scoped caches; server enforces data scope anyway (`403 FORBIDDEN` if a wrong-role call slips through — show role-switch prompt, never downgrade).

## Capability-based access control (provider team)

Team members (`/providers/me/staff`) hold roles with explicit capability lists; the server enforces capabilities on every provider route — the client renders only what the session allows (`GET /providers/me/capabilities`). Capabilities are never inherited across roles.

| Role | Capabilities (server-enforced default) |
| --- | --- |
| `technician` | `view_assigned_jobs`, `accept_job`, `reject_job`, `view_customer_location`, `contact_customer`, `start_job`, `upload_before_photos`, `upload_after_photos`, `submit_quote`, `complete_job` |
| `dispatcher` | `view_all_jobs`, `assign_technician`, `reassign_job`, `view_schedule`, `contact_customer`, `monitor_live_jobs` |
| `owner` | Full catalog (incl. staff management, payouts, settings) |
| `supervisor` | Business-configured oversight subset (no fixed default in the contract) |

Rules:

- Server-enforced: every provider API call is checked against the session's capabilities; missing capability → `403` `CAPABILITY_FORBIDDEN`. The UI never pretends an action exists it cannot perform — buttons and modules render from the session's capability catalog only.
- Technician and dispatcher never inherit each other's capabilities; position in the team grants nothing by itself.
- A technician session gets customer contact only through `contact_customer`-scoped masked relay access; job photos and customer location follow the same per-capability gate.
- Staff lifecycle: `invited` → OTP sign-in → `active`; `suspended` kills the member's sessions server-side. Removing the last `owner` is blocked (`PROVIDER_STAFF_LAST_OWNER`).
- Capability changes take effect on the member's next fetch; the client refetches `/providers/me/capabilities` on app foreground and role switch.
- Never persist capabilities in local storage; fetch per session, and treat `403` `CAPABILITY_FORBIDDEN` as refetch-then-logout decision, never a silent fallback.

## Masked fields

- Customer contact is masked in provider views (PRODUCT.md: masked customer contact). `AddressSnapshot.contactPhone` renders as masked (e.g. `+255 ••• ••• •89`); messaging goes through the platform relay, never raw numbers.
- Payout account and document numbers are masked in API responses by default (AUTH.md security invariants); settings shows them masked with a "contact support" path for changes.
- No off-platform payment prompts, ever (PRODUCT.md): blocked by policy and by not exposing unmasked contact.

## Location privacy

- Provider location is used only for on-demand matching (distance ranking) and is server-side; the app does not expose the provider's live location to customers beyond what the contract allows.
- Request location permission only after explaining why it is needed (SHARED-FLOWS.md address flow); deny path still works — manual address entry and landmarks remain.
- No location is stored client-side beyond the current booking context.

## UI security invariants

| Item | Rule |
| --- | --- |
| Errors | Show `message` + `requestId`; never raw stack traces |
| Destructive actions | Confirm dialogs for cancel; idempotency keys on all mutations (retries never double-apply) |
| Deep links | `Notification.deepLink` and booking links validate the `bookingId` against the active role before rendering |
| Storage | No sensitive data in logs, analytics, or error reporters |

## Logout checklist

1. `POST /auth/logout` (ignore network failure — proceed).
2. Clear tokens (secure-store / sessionStorage) and all role-scoped caches.
3. Reset navigation to the auth screen; clear any in-memory session context.
4. On web: also clear sessionStorage on tab close (beforeunload) where supported.

## Provider rest and fatigue (planned)

Extended-shift rest alerts for providers follow the rider pattern (`REST_ENFORCED` blocks new offers after `maxHoursPerDay`) — planned, consent-based.

## Two-factor authentication and age restrictions (planned)

Staff two-factor authentication (TOTP/SMS) for provider accounts and age verification for platform use are planned hardening items per the platform compliance checklist.

## Action-permission catalog

Permissions are named `domain.action`: `job.read/accept/reject/assign/reassign/schedule/start/pause/complete`, `quote.create/modify/approve`, `customer.read/contact`, `location.read`, `location.live.read`, `payment.read/refund`, `provider.read/verify/suspend`, `staff.invite/remove/permission.manage`, `inventory.read/adjust`, `payout.read/request`. Roles are bundles of these capabilities.
