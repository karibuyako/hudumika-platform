# HUDumika Merchant — Membership and Loyalty

Merchant-operated loyalty program: member registry, top-up rewards, tiers, and the member balance ledger. Distinct from platform customer membership (`GET /memberships/me`), which is customer-side only.

## Loyalty members

| Method | Path | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/members` | Loyalty members for own store | — | `LoyaltyMember[]` |
| POST | `/members` | Register a member | `name` ≤120, `phone` | `LoyaltyMember` / 201 |
| PATCH | `/members/{memberId}` | Update a member | `LoyaltyMember` | `LoyaltyMember` |

`LoyaltyMember`: `id`, `name`, `phone`, `balanceTZS`, `tierId` (nullable), `totalSpendTZS`, `createdAt`.

- Phone lookup: the contract has no dedicated lookup endpoint — the member list is fetched once and searched client-side by `phone` (exact match on the canonical `+255…` form). A server-side lookup endpoint is a proposed gap.
- Registration errors: `MEMBER_PHONE_EXISTS` (duplicate phone — show "already registered" with link to the existing member), `MEMBER_NOT_FOUND` on stale references.
- Member detail: balance card (`balanceTZS`), tier chip, `totalSpendTZS`, top-up action (cashier scope). Transaction history is append-only in `loyalty_transactions` (`top_up` / `bonus` / `redeem` / `spend`, per DATA-MODEL.md); a transactions list endpoint is a proposed gap.
- Screen states: list (loading skeleton → empty "No members yet — register your first member" → error + retry → rows) and form (validation → saving → success toast).

## Top-up rewards

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/members/{memberId}/top-up` | Record a top-up; body `amountTZS`, `paymentMethod` |

`paymentMethod` enum: `mpesa`, `tigo_pesa`, `airtel_money`, `card`, `cash`.

- Rewards are configured server-side via `PUT /membership-tiers` (`topUpRewards`: `thresholdTZS` → `bonusTZS`). The cashier screen shows the next threshold ("TZS 100,000 top-up earns TZS 10,000 bonus") from that config.
- A top-up below the configured threshold is rejected with `TOP_UP_BELOW_THRESHOLD` — the UI pre-validates against the served thresholds and shows the gap.
- On success the member balance is credited with the reward (`bonus` transaction) and `member.top_up` notifies the merchant.
- Cash top-ups follow the COD/cash evidence rules (backend/PAYMENTS.md); mobile-money top-ups are webhook-confirmed.

## Member tiers

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/membership-tiers` | Tier configuration for own store |
| PUT | `/membership-tiers` | Configure tiers + top-up rewards (body `{tiers, topUpRewards}`) |

`MemberTier`: `name` ≤40, `discountBps` (discount in basis points, e.g. 500 = 5%), `thresholdTZS` (spend to reach tier), `perks[]` (free strings, e.g. "Free delivery").

| Field | UI |
| --- | --- |
| `discountBps` | shown as "5%" — rendered from the API value, never client-computed |
| `thresholdTZS` | progress bar on member detail: spend vs next tier |
| `perks` | chips on the tier card |

- Tiers apply at order time server-side via `tierId`; the merchant app never computes discount amounts.
- Error: `TIER_NOT_FOUND` when a member references a deleted tier — the UI offers re-assignment.
- Tier editor (web): tier cards with drag-free explicit ordering (server order), validation 422 mapping; mobile shows read-only summary with a link to web.

## Member balance rules

- `balanceTZS` is a projection of the append-only `loyalty_transactions` ledger — the UI never edits it.
- Spending/redeeming against a member balance uses the same ledger; insufficient balance → `MEMBER_INSUFFICIENT_BALANCE` (banner on the cashier screen).
- Corrections arrive as new ledger entries, never as edits.

## Screen states and rules

- Register/update/top-up forms: loading → validation errors (422) → saving spinner → success toast → error + retry.
- `phone` is PII: rendered masked after registration; full values only at the cashier moment with role checks.
- MSW parity: member shapes, `MEMBER_PHONE_EXISTS`, thresholds/bonus config, and tier payloads must match the contract.
