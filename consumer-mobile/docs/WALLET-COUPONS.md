# Customer App — Coupon Wallet and Promotions

Glossary terms: promotion, coupon, coupon wallet, red packet. Coupons are claimed from live
merchant campaigns and applied to orders as server-computed discounts.

## Coupon discovery on merchant pages

| Step | Screen | Calls | Notes |
| --- | --- | --- | --- |
| 1 | Merchant detail | `GET /promotions?merchantId=` | Active promotions only (`listMerchantPromotions`); campaign status pill (`live`/`paused`/`ended`) |
| 2 | Coupon section | — | Claimable coupons: title, `discountTZS`, `minimumSpendTZS`, `validUntil` local time, claim button |
| 3 | Merchant cards | — | Campaign pill badge on the merchant card when a live coupon campaign exists; badge copy from the campaign |

`PromotionType`: `discount`, `spend_based`, `instant_discount`, `bargain`, `coupon`, `traffic` —
only `coupon` campaigns expose claimable coupons; the others are informational.

## Claiming

| Step | Screen | Calls | Notes |
| --- | --- | --- | --- |
| 1 | Claim | `POST /coupons/{couponId}/claim` | 201 → `Coupon` (`claimed`); success toast; card moves to wallet |
| 2 | Errors | — | `COUPON_ALREADY_CLAIMED` → disabled "Already claimed"; `COUPON_CAMPAIGN_SOLD_OUT` → "All claimed" badge; `COUPON_EXPIRED` → removed from claimable list |

## Coupon wallet

`GET /coupons/me` with `?status`; `CouponCard` (DESIGN-SYSTEM voucher/coupon card: value line +
validity line).

| Status | Rendering |
| --- | --- |
| `available` | Claimable list on merchant pages |
| `claimed` | Active in wallet; "Apply to order" |
| `used` | Used state + `usedAt` |
| `expired` | Greyed + "Expired" pill |
| `void` | "Voided" pill + support CTA |

## Applying coupons at checkout

- "Apply coupon" selector lists the customer's `claimed` coupons for this merchant
  (`GET /coupons/me?status=claimed`, filtered by merchant).
- Client pre-check: `subtotalTZS ≥ minimumSpendTZS` (advisory only). The server is the authority:
  `COUPON_MINIMUM_SPEND_NOT_MET` renders inline under the coupon row.
- Applied discount flows into `PriceBreakdown.discountTZS`; `totalTZS` stays server-computed
  (see `PAYMENTS.md`). `COUPON_ALREADY_USED`/`COUPON_EXPIRED` → remove from selector.
- Phased note: attaching the selected coupon to `OrderCreate` (a `couponId` field) is **planned**
  — a contract addition; the selector stays hidden behind a feature flag until it ships.

## Red packets (mock-first, P6c)

- Red packet = platform subsidy wallet credit distributed during campaigns (Meituan 红包 parity).
- **Promotional funding model**: packets are marketing-funded; claiming credits
  the wallet balance and never debits the recipient's wallet.
- No contract schema exists yet — the consumer app ships a mock-first
  `RedPacketRepository` (received list, claim, promotional share) behind
  mock-only-until-adopted paths; see docs/CONTRACT-ADDITIONS.md #12 for the
  exact endpoints and current behavior.

## Per-screen states

| Screen | Loading | Empty | Error | Retry | Success |
| --- | --- | --- | --- | --- | --- |
| Merchant promotions | Skeleton | "No promotions right now" | Error + retry | Retry | Promotion cards + badges |
| Coupon wallet | Skeleton | "No coupons yet" | Error + retry | Retry | Coupon cards by status |
| Claim | Button spinner | — | `COUPON_ALREADY_CLAIMED` inline | Retry | "Claimed" toast |
| Checkout coupon row | Skeleton | "No coupons for this order" | `COUPON_MINIMUM_SPEND_NOT_MET` inline | Retry | Discount in breakdown |

Error codes: `PROMOTION_NOT_FOUND`, `COUPON_CAMPAIGN_NOT_FOUND`, `COUPON_CAMPAIGN_SOLD_OUT`,
`COUPON_ALREADY_CLAIMED`, `COUPON_EXPIRED`, `COUPON_ALREADY_USED`, `COUPON_MINIMUM_SPEND_NOT_MET`.
