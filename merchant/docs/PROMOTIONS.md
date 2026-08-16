# HUDumika Merchant — Promotions

Campaigns that drive order volume: discount, spend-based, instant discount, bargain, and coupon campaigns; traffic campaigns (paid advertising) are contract-defined but phased (backend M7c) and not yet built — the UI does not expose them until they ship. Status strings are the exact `Promotion` statuses from the contract.

## Campaign types (`PromotionType`)

| Type | Rules shape (server-defined in `rules`) | Typical use |
| --- | --- | --- |
| `discount` | percentage off order/items | broad "10% off" |
| `spend_based` | spend threshold → reward | "spend TZS 50,000 get a discount" |
| `instant_discount` | immediate line-item reduction | checkout-time discount |
| `bargain` | customer haggle with merchant-set floor price | engagement play |
| `coupon` | coupon campaign distribution (below) | targeted entitlement |
| `traffic` | paid exposure; **phased M7c — not built** | advertising |

`rules` is an opaque object: the client renders type-specific form fields from the schema served by the API, never from hardcoded rule keys beyond the contract.

## Lifecycle

```text
draft -> pending_review -> live -> paused (toggle) -> live again
                            \-> rejected / ended
```

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/promotions?merchantId=` | Public active promotions (customer) | `Promotion[]` |
| POST | `/promotions` | Create campaign (merchant) | `Promotion` / 201 |
| PATCH | `/promotions/{promotionId}` | Update own campaign | `Promotion` |
| POST | `/promotions/{promotionId}/pause` | Pause or resume; body `{paused}` | `Promotion` |
| GET | `/promotions/{promotionId}/performance` | Campaign performance | `PromotionPerformance` |

`Promotion` fields: `type`, `title` ≤160, `description` ≤2000, `status`, `rules`, `budgetTZS` (nullable), `startsAt` / `endsAt`, `redeemCount`, `spendTZS`, `rejectReason`.

- Moderation: `pending_review` → ops decision (`adminPromotionDecision`: approved / rejected / paused) with `promotion.moderated` notification and `rejectReason`.
- Budget: server-enforced; spend past budget → `PROMOTION_BUDGET_EXCEEDED` and the campaign ends/pauses server-side.
- Conflicts: `PROMOTION_CONFLICT_ACTIVE` (overlapping active campaigns — see below), `PROMOTION_STATUS_CONFLICT` (pause/resume on wrong state), `PROMOTION_RULE_INVALID` (422-grade rule rejection), `PROMOTION_NOT_FOUND`.

Campaign editor + list screen: campaign status pills per DESIGN-SYSTEM (`draft`/`pending_review`/`live`/`paused`/`ended`/`rejected`), budget card, pause/resume toggle (optimistic with 409 rollback), moderation banner with `rejectReason`.

## Promotion conflicts

- Only one active campaign may target the same discount dimension: creating or pausing-resuming a conflicting campaign returns `PROMOTION_CONFLICT_ACTIVE`.
- UI: conflict banner lists the conflicting campaign and its window; the merchant picks "edit mine" or "keep theirs" — no silent stacking.

## Performance

`GET /promotions/{promotionId}/performance` → `PromotionPerformance`: `impressions`, `clicks`, `redeemCount`, `spendTZS`, `attributedRevenueTZS`, `roiPercent`.

| Metric | UI |
| --- | --- |
| `impressions` / `clicks` | exposure and interest counters |
| `redeemCount` / `spendTZS` | redemptions and campaign cost |
| `attributedRevenueTZS` / `roiPercent` | attributed revenue vs spend (glossary: promotion ROI) |

Performance screen: range card, metric tiles, bar chart per DESIGN-SYSTEM analytics chart rules (TZS axes, brand palette). States: loading skeleton → empty ("No redemptions yet") → error + retry → chart. `roiPercent` renders server-side only; the client never recomputes.

## Coupon campaigns

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| POST | `/coupons` | Create and distribute a coupon campaign | `CouponCampaign` / 201 |
| GET | `/coupons/me` | Customer wallet coupons (`status` filter) | `Coupon[]` |
| POST | `/coupons/{couponId}/claim` | Customer claims a coupon | `Coupon` / 201 |

`CouponCampaign`: `title`, `discountTZS`, `minimumSpendTZS`, `quantity`, `claimedCount`, `validUntil`, `status` (`draft` / `live` / `ended`).

- Distribution is server-side; the merchant sees `claimedCount` vs `quantity` on the campaign card. When all coupons are claimed: `COUPON_CAMPAIGN_SOLD_OUT` on further claims.
- Coupon lifecycle: `available → claimed → used`; terminal `expired` / `void`. Merchant-visible events: `coupon.claimed` daily digest.
- Coupon cost on the merchant wallet appears as `coupon_cost` wallet transactions (EARNINGS.md).
- Errors the UI maps: `COUPON_CAMPAIGN_NOT_FOUND`, `COUPON_ALREADY_CLAIMED`, `COUPON_EXPIRED`, `COUPON_ALREADY_USED`, `COUPON_MINIMUM_SPEND_NOT_MET`.

Coupon campaign form (web full, mobile summary): quantity + discount + minimum spend + validity; validation 422 mapping; claimed/remaining progress bar. Screen states: loading → empty ("No coupon campaigns") → error + retry → cards (DESIGN-SYSTEM voucher/coupon card).

## Screen states and rules

- Every campaign screen implements loading / empty / error+retry / success; mutations show in-flight spinner + optimistic update with server rollback.
- MSW parity: promotion statuses, `PROMOTION_CONFLICT_ACTIVE` payload, performance shape, coupon statuses, and budget errors must match the contract.

## Platform events (`GET /marketing/platform-events`, `POST .../{eventId}/enroll`)

- Platform-run traffic campaigns: statuses `open` → `enrolling` → `active` → `ended`, with `enrolled` flag.
- Enroll → `PLATFORM_EVENT_NOT_FOUND` / `PLATFORM_EVENT_CLOSED` when the window closed; enrollment records an activity submission (TASKS-RISK.md).
- Row shows dates, expected reach, and the merchant's live status; enrolled events appear under Marketing hub "Platform events".

## Flash sales (`/marketing/flash-sales`)

- Dedicated time-limited deals: `itemIds[]`, `discountBps`, `startsAt`, `endsAt`; lifecycle `draft` → `scheduled` → `live` → `ended` / `cancelled` (PATCH updates).
- Notifications: `flash_sale.live` / `flash_sale.ended`; a live flash sale blocks conflicting instant discounts on the same items (promotion conflict rule).
- List filters by status; live deals surface on the customer side with a countdown badge (DESIGN-SYSTEM group buy card variant).

## Coupon verification and stats

- Merchant-side verification: `POST /marketing/coupons/verify` with `code` → returns the `Coupon` or `409` (already used / expired / sold out).
- Stats: `GET /marketing/coupons/{couponId}/stats` → `{claimed, used, conversionRate}` — the analytics card for each coupon campaign (PROMOTION performance stays on the campaign level).

## Precision marketing (`/marketing/precision`, `POST .../{campaignId}/send`)

- Target a `CustomerSegment` with an offer: `coupon`, `discount`, or `message`; lifecycle `draft` → `sent` → `active` → `ended`.
- `POST /marketing/precision/{campaignId}/send` delivers to the segment (needs non-empty segment — `PRECISION_SEGMENT_EMPTY`).
- Results: `sentCount`; delivery uses the customer's preferred channels (push/SMS/in-app per NOTIFICATIONS preferences).

## DianJin (PPC) (`/marketing/dianjin`, `PATCH .../{campaignId}/toggle`)

- Pay-per-click ads: `budgetTZS`, `bidBps` (bid per click in basis points), live `spendTZS`/`clicks`.
- Toggle pause/resume with `active`; `DIANJIN_BUDGET_EXCEEDED` stops delivery until budget is raised.
- Phased capability: UI exists in M7c scope, ads inventory depends on backend serving — documented, not assumed live.

## Brand display (`/marketing/brand-display`)

- Paid brand awareness: `budgetTZS`, window, `impressions`; `BRAND_DISPLAY_ALREADY_ACTIVE` when one campaign is already running.
- Shows impression pacing vs budget; stops at budget or end date.

## Self-service promotion (`/marketing/self-service`)

- Merchant-controlled promo with optional `designUrl` and `homepageExposure`; toggle via `active`.
- Exposure slots are limited (homepage rotation); the toggle may return a pending state when a review is required.

## Screen states and rules

- Every campaign screen implements loading / empty / error+retry / success; mutations show in-flight spinner + optimistic update with server rollback.
- MSW parity: promotion statuses, `PROMOTION_CONFLICT_ACTIVE` payload, performance shape, coupon statuses, budget errors, platform-event statuses, flash-sale lifecycle, precision/dianjin/brand/self-service payloads — all matching the contract.

# Round-2 additions (deep survey — `docs/REFERENCE-SURVEY.md`)

## Full campaign-type table (`PromotionType` — all 15)

| Type | Rules shape | Typical use |
| --- | --- | --- |
| `discount` | percentage off order/items | broad "10% off" |
| `spend_based` | spend threshold → reward | "spend TZS 50,000 get a discount" |
| `full_reduction` | threshold coupon amount (`thresholdTZS` + `couponAmountTZS`) | "spend TZS 30,000, save TZS 5,000" |
| `new_customer` | `target: new_customers` first-order offer | acquisition play |
| `free_delivery` | waives `deliveryFeeTZS` (`freeDelivery` on orders) | conversion play |
| `instant_discount` | immediate line-item reduction | checkout-time discount |
| `bargain` | customer haggle with merchant-set floor; `haggleEnabled` | engagement play |
| `haggle` | haggle variant (floor via `rules`) | engagement play |
| `coupon` | coupon campaign distribution (`CouponCampaign`) | targeted entitlement |
| `flash` | time-limited deal (`/marketing/flash-sales`) | urgency deals |
| `featured` | placement visibility on the platform | exposure |
| `traffic` | paid exposure | advertising |
| `ppc` | pay-per-click (`cpcTZS` bid) | advertising |
| `brand` | brand display campaign (`/marketing/brand-display`) | brand awareness |
| `group_buy` | tiered group discounts (`groupBuyTargets`) | volume deals |

## Builder fields (typed, first-class)

| Field | Type | Notes |
| --- | --- | --- |
| `couponAmountTZS` | integer, nullable | Coupon amount (full_reduction / coupon) |
| `thresholdTZS` | integer, nullable | Spend threshold |
| `discountRateBps` | integer, nullable | Percentage-off in basis points |
| `target` | enum `all` / `new_customers` / `returning_customers` / `segment` | default `all` |
| `productIds` | uuid[] | Item-scoped campaigns |
| `groupBuyTargets` | array | Tiers: `buyers` (integer) + `discountRateBps` per tier |
| `haggleEnabled` | boolean | default false; bargain/haggle floor negotiation |
| `cpcTZS` | integer, nullable | Pay-per-click bid (ppc type) |

The builder wizard walks type picker → per-type form from these fields → review → `POST /promotions`; `rules` remains the opaque server-defined bag on top.

## Coupon kinds (`CouponCampaign.kind`)

| Kind | Fields | Effect |
| --- | --- | --- |
| `percentage` | `discountRateBps` + optional `maxDiscountTZS` cap | Percentage off up to the cap |
| `fixed` | `discountTZS` | Fixed TZS off (default) |
| `shipping` | — | Waives delivery (free-delivery coupon) |

`maxDiscountTZS` (nullable) caps percentage-kind discounts; minimum spend, quantity, `claimedCount`, `validUntil`, and statuses (`draft` / `live` / `ended`) are unchanged.

## Flash sales and instant discounts

- Flash: countdown renders from `startsAt` / `endsAt` (statuses `draft` → `scheduled` → `live` → `ended` / `cancelled`); a per-item quantity limit on flash deals is a reference-app field not in the contract (contract gap).
- Instant discount: immediate line-item reduction; `maxUses` per campaign is not in the contract (contract gap) — usage tracks server-side via `redeemCount` / `spendTZS`.

## Bargain settings

- `haggleEnabled` (default false) switches on customer counter-offers against the merchant-set floor in `rules`. Auto-accept threshold and explicit counter-offer rules are reference-app settings not exposed as typed contract fields (contract gap — negotiate via `rules` only).

## Traffic, ROI, platform events, self-service packages

- Traffic/ppc/brand campaigns use `cpcTZS` + `budgetTZS`; the ROI calculator is a client-side tool over server values (`impressions`, `clicks`, `spendTZS`, `attributedRevenueTZS`, `roiPercent`) — the client never fabricates attribution and never recomputes ROI.
- Platform events: enroll via `POST /marketing/platform-events/{eventId}/enroll` (statuses `open` → `enrolling` → `active` → `ended`, `enrolled` flag); the reference-app terms-acceptance checkbox is client UI before enroll — no contract field.
- Self-service packages (Basic / Premium / Enterprise + feature comparison): reference-app packaging; the contract has a single `/marketing/self-service` toggle (`active`, `designUrl`, `homepageExposure`) — contract gap for packages.

## Campaign performance

- `Promotion` now carries `impressions`, `clicks`, `attributedOrders`, `attributedRevenueTZS` (defaults 0) alongside `redeemCount` / `spendTZS`.
- `GET /promotions/{promotionId}/performance` → `{promotionId, impressions, clicks, redeemCount, spendTZS, attributedRevenueTZS, roiPercent}`; `GET /analytics/marketing?from&to` → `{totalSpendTZS, attributedRevenueTZS, roiPercent, activeCampaigns}`.
- Performance screen: range card, metric tiles (impressions, clicks, attributed orders, attributed revenue `TZS 1,234`, ROAS = `roiPercent` rendered server-side), states loading skeleton → empty ("No redemptions yet") → error + retry → chart.

# Round-3 additions — campaign attribution, ticks, validation (reference contract tests)

Behaviors verified against the reference contract suite (`tests/contract.test.ts`) and the server sweeper (`src/mock/sweeper.ts`).

## Order attribution

- Attribution picks the active campaign with the highest spend; an attributed order increments `orders` by 1 and `revenue` by the order total.
- ROAS rule: `roas = revenue / spend` rounded to 2 decimals when spend > 0; `roas = 0` when spend is 0.
- Rollup: `GET /analytics/promotions` (`perCampaign[]`, `totalSpend`, `attributedRevenue`) covers the attributed order (`attributedRevenue >= order total`).

## Sweeper spend ticks

- Every sweep, active campaigns (status `active`, `spent < budget`) gain `impressions` (200–900) and `clicks` (3–5% of impressions, always ≤ impressions).
- Spend bumps probabilistically (1–4% of budget per tick); when `spent` reaches `budget` the campaign flips to `expired`.

## Validation (exact codes, reference suite)

| Campaign | Rule | Code |
| --- | --- | --- |
| `group_buy` | tiers `[{buyers, discountRate}]` round-trip; below-minimum `buyers` rejected | `INVALID_GROUP_BUY` (400) |
| `ppc` | `cpc` round-trips; too-small bid rejected | `INVALID_CPC` (400) |
| `instant_discount` | `discountRate` round-trips; invalid rate rejected | `INVALID_DISCOUNT` (400) |
| `haggle` / `featured` / `brand` | creation round-trips; `haggleEnabled` persists | — |

## Platform campaigns and segments

- Platform campaign signup flips the campaign status to `signed` and notifies.
- Creating a coupon against a customer segment creates the campaign server-side (`sent` > 0).
- Stopping a campaign refunds the unused budget (stop → status `expired`, unused budget refunded).
