# Customer App — Group Buy and Vouchers

Glossary terms: group buy, group buy deal, voucher, voucher verification. Deals are merchant
offerings that pass staff moderation; customers only ever see `live` deals, plus terminal states
on detail.

## Discovery

| Step | Screen | Calls | Notes |
| --- | --- | --- | --- |
| 1 | Deals feed | `GET /group-buys` (`?cityId&limit&cursor`) | Live deals only; `GroupBuyCard` (DESIGN-SYSTEM: discount badge, struck-through original, "Buy" CTA) |
| 2 | Deal detail | `GET /group-buys/{groupId}` | 404 → `GROUP_BUY_NOT_FOUND` → removed state |

Detail renders: `title`, `description`, image, `priceTZS` vs `originalPriceTZS` (savings badge,
e.g. −30%), `soldCount`/`quantity`, `validityDays` (default 90), `salesStartAt`/`salesEndAt`
(local time), deal `status`. Purchasable only when `live`; `ended`/`delisted`/`rejected` → banner
"Deal no longer available". `draft`/`pending_review` are never visible.

## Purchase

| Step | Screen | Calls | Notes |
| --- | --- | --- | --- |
| 1 | Quantity | Deal detail stepper | 1–20 (contract bound) |
| 2 | Pay | Purchase payment | `Idempotency-Key` (shared rule); charged at purchase per backend `PAYMENTS.md` |
| 3 | Issue vouchers | `POST /group-buys/{groupId}/purchase` (`{quantity}`) | 201 → `Voucher[]`, one per unit |
| 4 | Wallet | `GET /vouchers/me` | Vouchers appear `unused` |

Errors: `GROUP_BUY_ENDED` (deal ended while viewing → refetch), `GROUP_BUY_QUANTITY_EXCEEDED`
(quantity bound), `GROUP_BUY_STATUS_CONFLICT`, `GROUP_BUY_NOT_FOUND`.

## Voucher wallet

`GET /vouchers/me` with `?status`; `VoucherCard` (DESIGN-SYSTEM: dashed accent border, big value,
validity line, redeem QR). Card: `code` (`GB-XXXX-XXXX`), `title`, `priceTZS`, `expiresAt`, status.

| Status | Rendering |
| --- | --- |
| `unused` | Green "Use" CTA; active until `expiresAt` |
| `redeemed` | Checked state; `redeemedAt` + `redeemedByMerchantId` |
| `expired` | Greyed, "Expired" pill |
| `refunded` | "Refunded" pill |
| `void` | "Voided" pill + support CTA |

## Redemption at the merchant

- Customer presents the voucher: big `code` + QR payload the merchant scans.
- Verification is merchant-side (`POST /vouchers/{voucherCode}/verify` with `merchantId`); the
  app never calls it. Outcomes: `redeemed`, `invalid`, `expired`, `already_used`.
- After in-store redemption the wallet flips to `redeemed` on refetch; `voucher.redeemed` is a
  merchant notification, not a customer one.

## Expiry and refunds

- `expiresAt` derives from `validityDays`; the card shows "Valid until <local time>".
- Expiry handling is server-driven (backend `PAYMENTS.md`): unused vouchers past validity expire,
  the customer is refunded, and the merchant receivable is reversed. The app renders the resulting
  `expired`/`refunded` status only — refunds are never initiated in-app.
- `VOUCHER_REFUND_PENDING` → info banner; refund eligibility = `unused` within `validityDays`
  (server-enforced).

## Settlement note

- The customer is charged at purchase; the merchant is **settled on redemption**
  (`group_buy_settlement` wallet entry), not on purchase (backend `PAYMENTS.md`).
- Settlement is invisible in the customer app; the customer sees only their purchase charge.

## Per-screen states

| Screen | Loading | Empty | Error | Retry | Success |
| --- | --- | --- | --- | --- | --- |
| Deals feed | Skeleton cards | "No deals right now" | Error + retry | Retry | Deal cards |
| Deal detail | Skeleton | — | `GROUP_BUY_NOT_FOUND` | Retry | Deal + quantity + Buy |
| Purchase | Processing overlay | — | `GROUP_BUY_ENDED` inline | Refetch + retry | "Vouchers issued" toast |
| Voucher wallet | Skeleton cards | "No vouchers yet" | Error + retry | Retry | Voucher cards by status |

Error codes: `GROUP_BUY_NOT_FOUND`, `GROUP_BUY_STATUS_CONFLICT`, `GROUP_BUY_ENDED`,
`GROUP_BUY_QUANTITY_EXCEEDED`, `VOUCHER_INVALID_CODE`, `VOUCHER_ALREADY_USED`, `VOUCHER_EXPIRED`,
`VOUCHER_NOT_REDEEMABLE_AT_MERCHANT`, `VOUCHER_REFUND_PENDING`.
