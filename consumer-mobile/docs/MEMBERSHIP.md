# Customer App — Membership and Loyalty

Glossary terms: customer membership, loyalty member, membership tier, top-up reward. Two distinct
programs exist: a platform-wide customer membership (points + level) and merchant-operated loyalty
programs. The app keeps them separate and never mixes data.

## Platform customer membership

| Step | Screen | Calls | Notes |
| --- | --- | --- | --- |
| 1 | Account → Membership | `GET /memberships/me` | `CustomerMembership`: `points`, `level`, `memberSince`, `benefits[]` |
| 2 | Render | — | Level pill (`bronze`/`silver`/`gold`), points count, benefits list |

- Read-only for the customer — no membership mutations exist in the contract.
- Level values are rendered from the server; unknown values fall back to the neutral pill.
- `memberSince` renders as local date; only the current balance exists (no points history endpoint).

## Earning points (planned)

- Points accrual on completed orders/bookings is **planned**: no backend rule or event exists in
  the contract yet.
- Until defined, the membership screen shows the balance plus a "How to earn" card marked
  "Coming soon". The client never guesses rates or point values.

## Merchant loyalty programs

- Merchants operate their own programs: members registered by name + phone, tiers
  (`discountBps`, `thresholdTZS`, `perks[]`), and top-up rewards (bonus balance above a threshold).
- Every loyalty endpoint is merchant-scoped (`/members`, `/members/{memberId}/top-up`,
  `/membership-tiers`) — the customer app has no loyalty mutations and must not call them.
- The merchant page may show informational loyalty copy (tiers, top-up perks) when the merchant
  provides it; enrollment happens **in-store**: the merchant registers the customer with explicit
  consent.
- Top-up methods merchants may record: `mpesa`, `tigo_pesa`, `airtel_money`, `card`, `cash`
  (merchant-side schema; the app shows explainer copy only).

## Privacy note

- A merchant sees customer member data only with the customer's consent at registration; refusing
  a loyalty program never blocks ordering.
- Platform membership (`memberships/me`) is separate from merchant loyalty records and is never
  shared with merchants.
- Consent copy on the loyalty card states what is shared (name, phone, spend at this merchant)
  and what is not (platform points, activity at other merchants).

## Per-screen states

| Screen | Loading | Empty | Error | Retry | Success |
| --- | --- | --- | --- | --- | --- |
| Membership card | Skeleton | No membership yet (`memberSince` null) | Error + retry | Retry | Points + level + benefits |
| Merchant loyalty card | Skeleton | Merchant offers no program → hidden | Error + retry | Retry | Tier/perk copy + consent |

Error codes: globals only (`UNAUTHORIZED`; `NOT_FOUND` renders as "no membership yet").
