# HUDumika Authentication and Authorization

## Flow

1. Client calls `POST /auth/request-otp` with `channel` (phone/email) and `purpose`.
2. Backend rate-limits per destination (3 per 5 minutes, 60 s between resends), stores only the SHA-256 hash of the code, returns `requestId` + expiry. **Never** reveals whether the account exists.
3. Client calls `POST /auth/verify-otp` with `requestId` + `code` (rate-limited per IP: 20 per minute).
4. Backend verifies the code in constant time (max 5 attempts then the request locks), marks the OTP verified, creates or links the user, and issues a role-scoped session.
5. Session contains `user.roles`; client redirects to the correct application surface.
6. Role switching calls `verify-otp` again (re-verification) with the target role; the new session is scoped to that role and never mixes data.

All hot-path state (OTP, rate limits, sessions, idempotency keys) lives in Redis so any number of API instances share it. PostgreSQL keeps the durable record: `users`, `roles`, `sessions`, and `otp_requests` rows are written by the auth service and mirrored on rotation/revocation (migrations run as a deploy step, never at boot).

## Sessions

- Access token: JWT HS256, 15 min, claims `sub`, `role`, `mfa_verified` (staff), and merchant/provider/rider scoping when applicable.
- Refresh token: opaque, 32 random bytes returned to the client exactly once; only the SHA-256 hash is stored in Redis (`sess:{hash}`) and mirrored to the `sessions` table; 30 days, rotation on every refresh (atomic Lua in Redis; single guarded UPDATE in PostgreSQL); reuse of a rotated token is rejected.
- Logout revokes the session server-side (`revoked_at` in Redis and PostgreSQL).
- Token storage on devices: secure storage (Keychain / Android Keystore / SecureStore) — see each app's SECURITY.md.

## RBAC

Roles are checked **server-side on every route** (middleware in `internal/api/rbac.go`). Clients never decide permissions. Claims come from the session, never from request bodies.

| Role | Scope |
| --- | --- |
| customer | own orders, bookings, reviews, tickets |
| merchant | own profile, catalogue, orders, payouts |
| provider | own profile, availability, bookings, payouts |
| rider | own profile, online state, assigned orders, earnings |
| staff roles | admin routes only (`/admin/*`), defined in admin-web `ROLES-PERMISSIONS.md` |

Route policy is a prefix map (`routePolicy`): `/admin/*` → staff roles only, `/wallet/*` → merchant/provider/rider, `/riders/*` → rider/staff, `/providers/*` → provider/staff, `/merchants/*` → merchant/staff; everything else is any authenticated role. Mismatches answer `403 FORBIDDEN`.

### Staff authentication (admin-web)

- Staff login additionally requires **MFA** (TOTP or SMS second factor).
- Staff sessions carry an `mfa_verified` claim; admin routes reject sessions without it with `401 MFA_REQUIRED`.
- Session timeout: 20 minutes idle, enforced server-side.
- Optional IP/device allow-list policy per environment.

## OTP security rules

- Codes are 6 digits, expire in 5 minutes, max 5 verify attempts then locked (request consumed).
- Only the SHA-256 hash is stored; comparison is constant-time.
- Resend is allowed after 60 seconds; per-destination budget is 3 requests per 5 minutes.
- Verification is additionally rate-limited per IP (20 per minute, `429 RATE_LIMITED`).
- OTP is delivered via SMS gateway or transactional email through the outbox pattern (`notification_outbox`), payloads encrypted with `OTP_PAYLOAD_KEY`; the code is never logged and never stored in plaintext.

## Password change

- `POST /auth/change-password` replaces the session user's password. The platform is OTP-first: `users.password_hash` is NULL until the password-login milestone lands, so only accounts that already carry a hash can change a password (others answer `422 PASSWORD_CHANGE_INVALID`).
- Stored as `sha256$<salt-hex>$<hash-hex>` — SHA-256(salt ‖ password) with a fresh 16-byte random salt, stdlib crypto only, constant-time compare via `crypto/subtle`. Must be replaced by bcrypt/argon2 when the password-login milestone lands.
- Rules: 8–128 characters; the new password must differ from the current one; a wrong current password answers `401 PASSWORD_CHANGE_INVALID`; success is 204.

## Masked-call sessions

- `POST /orders/{orderId}/masked-call` creates a masked VoIP session between the order parties (customer ↔ assigned rider) with number privacy. Session ids live in Redis with an expiry; `VerifyMaskedCall` checks them in constant time and a wrong/expired id reports `MASKED_CALL_EXPIRED`.
- Only parties of the order may create/verify a session; outsiders get `NOT_FOUND` (no existence leak). The VoIP transport itself is a stub — the contract declares the session surface; the real call transport is a future subsystem.

## Admin IP allow-list

- `/admin/*` additionally honors `ADMIN_ALLOWED_IPS` (comma-separated exact IPs or CIDRs, parsed once per process, honors `X-Forwarded-For`). Unset/empty allows all (development); when set, the policy **fails closed** — non-matching clients are denied even with a valid staff session + MFA.

## Customer simulator (staging)

- ARCHITECTURE.md documents a staging-only internal key (`x-internal-key`) emulating the customer platform for E2E. TODO: not found in the backend code — no middleware reads that header; verify before relying on it.

## Compliance

- PCI-DSS scope: card data handled by the payment gateway; the platform never stores PANs (tokenized references only).
- Accessibility: client surfaces target WCAG 2.1 AA (contrast, focus, touch targets, screen-reader announcements).

## Security invariants

- Password-equivalent data is never stored in plaintext (OTP codes, refresh tokens).
- Role claims come from the session, never from request bodies.
- All admin mutations require staff session + MFA + permission check.
- Sensitive fields (payout account, documents, national IDs) are masked in API responses by default (`MaskPII` middleware).
- Audit rows are written for every money/status/moderation mutation (`audit_logs`), best-effort and never failing the request.
