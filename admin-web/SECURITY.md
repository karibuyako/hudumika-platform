# HUDumika Admin Web — Security

## Deployment

- Runs on a **separate protected hostname** (e.g. `ops.hudumika.co.tz`), never linked from the public web, footer, sitemap, or navigation.
- Hostname access restricted by network policy (allow-listed IPs/VPN) where required.
- No public search engine indexing: `noindex`, no robots allowance for staff paths.

## Authentication

- Staff login: phone/email + OTP, then **MFA** (TOTP or SMS second factor) — mandatory for every staff role.
- Sessions carry an `mfa_verified` claim; admin API rejects sessions without it.
- Session timeout: 20 minutes of inactivity, server-enforced; re-authentication required after.
- Refresh tokens rotate; logout revokes server-side.

## Authorization

- Frontend role checks only control rendering; **every mutation is permission-checked server-side** (`ROLES-PERMISSIONS.md`).
- No client-side-only authorization anywhere.
- Sensitive fields are masked by default; unmask is permissioned and audited.

## Data rules

| Rule | Detail |
| --- | --- |
| Financial changes | Reason required + audit record + threshold-based role check |
| Exports | Permissioned, logged, and capped (row limits) |
| Documents | Served via pre-signed URLs with expiry, never static links |
| Search | Customer search returns masked contact info by default |

## Audit

- Every login, MFA, role change, approval, refund, payout action, moderation decision, export, and unmask writes an audit log entry (see `AUDIT.md`).
- Staff actions link to request ID + IP; traceable to application logs.

## Session and device policy

- Optional IP/device policy per environment (allow-list for ops staff).
- Suspicious behavior (new device, new IP, failed MFA) triggers re-verification.
- Staff can be suspended by super admin; suspension revokes all sessions immediately.

## Frontend hygiene

- No secrets, tokens, or payment keys in the bundle; API base URL from `VITE_ADMIN_API_URL`.
- CSP headers on the hosting platform; no third-party scripts.
- No admin routes or URLs in the public web codebase.
