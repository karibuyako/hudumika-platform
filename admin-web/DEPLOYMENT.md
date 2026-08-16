# HUDumika Admin Web — Deployment

## Environments

| Environment | Hostname | API | Purpose |
| --- | --- | --- | --- |
| dev | localhost | MSW / dev-api | Feature work, MSW parity |
| staging | staging-ops.hudumika.co.tz | staging-admin-api | Integration, seeded data, E2E |
| production | ops.hudumika.co.tz | prod-admin-api | Live operations only |

Production hostname is **never** linked from public surfaces and is protected by network policy (allow-listed IPs/VPN) plus staff MFA.

## Build and release

- Build: `vite build` with `VITE_ADMIN_API_URL` injected per environment.
- Static output deployed to the platform's hosting (same pattern as public web).
- CI gate: `vitest` → MSW parity suite → Playwright (staging) → deploy.
- Versioned releases; rollback = redeploy previous build (immutable artifacts).

## Headers and hardening

- CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `noindex`.
- Strict transport security at the edge.
- No third-party scripts or analytics on the admin surface.

## Configuration

| Var | Purpose |
| --- | --- |
| `VITE_ADMIN_API_URL` | Admin API base URL per environment |
| Staff MFA issuer | TOTP issuer label for authenticator apps |
| Session policy | Timeout (20 min), re-auth rules — server-side |

## Release checklist

1. E2E suite green on staging with seeded data.
2. Contract parity suite green against staging API.
3. Security review: no public links to the admin hostname, headers verified.
4. Super admin smoke test: login + MFA + approve + refund + audit query.
5. Rollback plan confirmed (previous build artifact retained).
