# HUDumika Merchant — Privacy & Account Management

Account security and data-rights surfaces for the merchant app and web.

## Change password (`POST /auth/change-password`)

- Only when password login is enabled; phone-first accounts keep OTP.
- Body: `currentPassword` + `newPassword` (8–128 chars).
- Errors: `PASSWORD_CHANGE_INVALID` (wrong current password). After change,
  all other sessions are revoked; this session stays active.

## Session management (`GET /sessions`, `POST /sessions/{token}/revoke`)

- List active sessions: device info, last active, `current` flag.
- Revoke any other session (`SESSION_NOT_FOUND` for unknown tokens).
- Used by the "Log out other devices" action and after a password change.

## Privacy export (`POST /privacy/export`)

- Requests personal data export per PDPA/GDPR portability (ties to
  `/data/exports`; this is the personal-data scope).
- Async job: `queued` → `processing` → `ready`/`failed`; download URL is
  short-lived and the job is audited.
- `PRIVACY_EXPORT_IN_PROGRESS` blocks a second concurrent request.

## Account deletion (`POST /privacy/delete`)

- Requires `confirmation: "DELETE"` (exact) + optional reason.
- Returns `requestId` + `estimatedDays` (30-day cooling-off per policy).
- `ACCOUNT_DELETION_INVALID_CONFIRMATION` on mismatch; a pending deletion
  blocks new orders/bookings and cancels open sessions after the period.
- Cancellation of a deletion request is a support-ticket flow (audited).

## Account recovery

- Forgotten password/merchant ID: OTP to the registered phone (`purpose: password_reset`)
  then re-verification; recovery events are audited.

## Relation to SECURITY.md

- Token storage, session expiry, masking, and staff MFA rules live in SECURITY.md — this doc covers the user-facing surfaces only.
