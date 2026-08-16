# HUDumika Merchant — Group Buy

Discounted deal bundles sold in advance; customers redeem via vouchers verified at the store. Status strings are the exact `GroupBuyStatus` / `VoucherStatus` enums from the contract.

## Deal lifecycle

```text
draft -> pending_review -> live -> extended (same deal) / delisted / ended
                          \-> rejected
delisted -> pending_review (relist applies)
```

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/group-buys` | Public live deals (customer discovery) | `GroupBuyDeal[]` |
| POST | `/group-buys` | Create a deal (merchant) | `GroupBuyDeal` / 201 |
| GET | `/group-buys/{groupId}` | Deal detail (own or public) | `GroupBuyDeal` / 404 |
| PATCH | `/group-buys/{groupId}` | Self-edit own deal | `GroupBuyDeal` |
| POST | `/group-buys/{groupId}/extend` | Extend a live deal (`newEndsAt`) | `GroupBuyDeal` |
| POST | `/group-buys/{groupId}/delist` | Take the deal offline | `GroupBuyDeal` |
| POST | `/group-buys/{groupId}/relist` | Apply to bring a delisted deal back | `GroupBuyDeal` |

`GroupBuyDeal` fields: `title` ≤160, `description` ≤2000, `imageUrl`, `priceTZS` / `originalPriceTZS`, `quantity`, `soldCount`, `validityDays` (default 90), `salesStartAt` / `salesEndAt`, `status`, `rejectReason`.

Rules:

- Moderation: new deals enter `pending_review`; ops approve/reject/delist via the admin queue (`adminGroupBuyDecision`). The merchant is notified by `group_buy.moderated` and sees `rejectReason` on the deal.
- Extension is only valid on a live deal (`GROUP_BUY_EXTEND_INVALID`); extending records status `extended`.
- Delist is immediate and merchant-initiated; unsold capacity is not re-sold while delisted.
- Relist re-submits for review (`pending_review`); it does not go live directly.
- Conflict codes: `GROUP_BUY_NOT_FOUND`, `GROUP_BUY_STATUS_CONFLICT`, `GROUP_BUY_ENDED`, `GROUP_BUY_QUANTITY_EXCEEDED`.

Deal editor screen: form (loading → validation errors → saving → success) with a live preview card per DESIGN-SYSTEM "group buy card" (discount badge, struck-through `originalPriceTZS`, Buy CTA). Deal list shows campaign pills per `GroupBuyStatus` (`draft`/`pending_review`/`live`/`delisted`/`ended`/`rejected`).

## Vouchers

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/group-buys/{groupId}/vouchers` | Sold vouchers for own deal, `status` filter + cursor | `Voucher[]` |
| POST | `/group-buys/{groupId}/purchase` | Customer purchase (`quantity` 1–20, issues vouchers) | `Voucher[]` / 201 |

`Voucher`: `code` (`GB-XXXX-XXXX`), `groupBuyId`, `title`, `priceTZS`, `status`, `purchasedAt`, `redeemedAt`, `expiresAt`, `redeemedByMerchantId`.

| VoucherStatus | UI meaning |
| --- | --- |
| `unused` | Sold, not yet redeemed; redeemable until `expiresAt` |
| `redeemed` | Used at a store; shows `redeemedAt` and redeeming merchant |
| `expired` | Past `expiresAt` unredeemed; customer refunded (PAYMENTS.md settlement) |
| `refunded` | Refunded (threshold rules + reason apply) |
| `void` | Invalidated, never redeemable |

Voucher list screen: status filter chips, cursor pagination, voucher card per DESIGN-SYSTEM (dashed accent border, value + validity line, code). States: loading skeleton → empty ("No vouchers sold yet") → error + retry → list.

## Verification (manual code + QR)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| POST | `/vouchers/{voucherCode}/verify` | Verify by code or QR payload, body `merchantId` | 200 `Voucher` (redeemed) |
| GET | `/vouchers/verify-history` | Verification log for own store | `{voucherCode, verifiedAt, verifiedBy, result}[]` |

- Input: type the `GB-XXXX-XXXX` code or scan the QR payload; both resolve to `voucherCode`.
- 200: voucher flipped `unused → redeemed`, `redeemedAt` set, `voucher.redeemed` in-app notification; success card.
- 409 handling: the attempt failed — result code decides the copy:
  - `VOUCHER_INVALID_CODE` → "code not recognized",
  - `VOUCHER_ALREADY_USED` → "already redeemed" (`already_used`),
  - `VOUCHER_EXPIRED` → "expired",
  - `VOUCHER_NOT_REDEEMABLE_AT_MERCHANT` → deal not valid at this store,
  - `VOUCHER_REFUND_PENDING` → refund in progress, retry later.
- Every attempt (success and failure) is logged in `verify-history` with `result` enum `redeemed` / `invalid` / `expired` / `already_used` — the screen doubles as the dispute audit trail.
- Cashier scope: verification is available to `cashier` and above (STAFF-AND-DEVICES.md); attempts are attributed via `verifiedBy`.
- Screen states: scanner/input (loading camera → error + retry) → result card (success or 409 reason) → history list (loading / empty / error + retry).

## Settlement note

Group buy sales settle to the merchant wallet on redemption, not on purchase; unused vouchers expire and reverse the receivable (backend/PAYMENTS.md, EARNINGS.md `group_buy_settlement`).

## MSW parity

Deal state machine, moderation statuses, voucher status transitions, verify 409 codes, and history results must match the contract.
