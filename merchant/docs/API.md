# HUDumika Merchant — API Usage

All endpoints, schemas, statuses, and error codes come from `backend/API-CONTRACT.yaml`. Base path `/api/v1`, base URL from environment. Money fields are TZS integer minor units. Cursor pagination: `?limit=20&cursor=<opaque>`.

## Error envelope (all endpoints)

`ErrorResponse` = `code`, `message`, `requestId` (+ `retryAfterSeconds` on 429). `ValidationResponse` adds `errors[]` (`field`, `message`). HTTP statuses seen in UI: 401 (session expired → refresh then retry, else re-login), 403 (permission denied), 404 (not found/not visible), 409 (illegal state transition — show conflict banner), 422 (validation — map `errors[].field` to form fields), 429 (rate limited, honor `Retry-After`).

## Auth

| Method | Path | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| POST | `/auth/request-otp` | Send OTP (`channel`: phone/email; `purpose`: login/signup/password_reset/verify_role) | `OtpDelivery` (requestId, expiresInSeconds, resendInSeconds) | 429 on rate limit |
| POST | `/auth/verify-otp` | Verify code, issue role-scoped `Session` | `requestId`, `code` | `Session` (accessToken, refreshToken, user) / 401 |
| POST | `/auth/refresh` | Rotate access token | `refreshToken` | `Session` / 401 |
| POST | `/auth/logout` | Revoke session server-side | — | 204 |

UI statuses: OTP screen loading/error/retry, resend countdown from `resendInSeconds`, session-expired banner on any 401.

## Users

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/users/me` | Own profile incl. `activeRole` and `roles[]` | `User` |
| PATCH | `/users/me` | Update `fullName`, `email`, `avatarUrl`, `locale` | `User` |
| GET | `/users/me/roles` | Roles available for switching (`customer`, `merchant`, `provider`, `rider`) | `RoleSummary[]` |

## Merchants

| Method | Path | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| POST | `/merchants` | Submit application (`businessName`, `contactPhone`, `city`, `businessType`) | `MerchantApplication` | `LeadCreated` (status `submitted`/`under_review`) / 422 |
| GET | `/merchants/me` | Own profile: `verification` + `commercial` (`commissionRateBps`, `payoutCycleDays`, `payoutAccount` masked) | — | `MerchantPrivate` |
| PATCH | `/merchants/me` | Update `businessName`, `logoUrl`, `description`, `serviceAreas`, `isOpen` | `MerchantUpdate` | `MerchantPrivate` |

UI statuses: `VerificationState` (pending, documents_review, approved, rejected, suspended, changes_requested) drives the onboarding surface: the verification screen renders each state with its action, and while not `approved` the dashboard shows an under-review banner linking to it (soft gate — tabs are not hard-locked; see ROADMAP P1).

## Catalogues

| Method | Path | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/catalogues/me` | Own catalogue with items and `publishedAt` | — | `Catalogue` |
| PUT | `/catalogues/me` | Full catalogue replace (draft publish) | `Catalogue` | `Catalogue` |
| POST | `/catalogue-items` | Add item (`name`, `priceTZS`, `category`, `options`) | `CatalogueItem` | `CatalogueItem` / 201 / 422 |
| PATCH | `/catalogue-items/{itemId}` | Update price, availability, options | `CatalogueItemUpdate` | `CatalogueItem` |
| DELETE | `/catalogue-items/{itemId}` | Soft-delete item | — | 204 |

UI statuses: draft vs published (`publishedAt` null = never published); `available` boolean toggle per item; `ORDER_PRICE_CHANGED` error on publish (see MENU-CATALOGUE.md).

## Orders

| Method | Path | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/orders/me` | Own orders, `status` filter + cursor | — | `Order[]` |
| GET | `/orders/{orderId}` | Detail: `items`, `deliveryAddress`, `events[]` | — | `OrderDetail` / 403 / 404 |
| POST | `/orders/{orderId}/accept` | Merchant accepts | — | `Order` / 409 if not accept-able |
| POST | `/orders/{orderId}/status` | Advance status (merchant scoped transitions) | `status`, `note` | `Order` |
| POST | `/orders/{orderId}/cancel` | Cancel with `reason` (maxLength 500) | — | `Order` |
| GET | `/orders/{orderId}/track` | Live tracking, `estimateMinutes`, rider lat/lon | — | `TrackingEvent` |

UI statuses seen: `paid`, `merchant_accepted`, `preparing`, `rider_assigned`, `picked_up`, `delivering`, `delivered`, `completed`, `cancelled`, `refunded`, `failed`, `disputed`. Details in ORDER-FLOW.md.

## Reviews

| Method | Path | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| POST | `/reviews` | Create a review (merchant reviews a customer where policy permits) | `ReviewCreate` (targetType, targetId, rating 1–5, body) | `Review` / 201 |
| POST | `/reviews/{reviewId}/report` | Report a received review for moderation | `reason` (maxLength 300) | `ReviewReport` (state open/resolved/dismissed) / 201 |

Reviews received by own merchant: `GET /reviews/me` returns `ReviewDetail[]` (rating, body, state, replies); `POST /reviews/{reviewId}/reply` posts a `ReviewReply` (max 1000 chars, one reply per review — `REVIEW_REPLY_EXISTS` on repeat, `REVIEW_NOT_REPLIABLE` when the review is hidden/deleted, `REVIEW_REPLY_MODERATED` when hidden).

## Payouts

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/payouts/me` | Payout history + balance | `PayoutSummary[]` (status pending/processing/paid/failed/exception) |
| GET | `/payouts/me/statement` | Ledger statement for date range `from`/`to` | `LedgerStatement` (openingBalanceTZS, closingBalanceTZS, entries[]) |

## Notifications

| Method | Path | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/notifications/me` | List, `unreadOnly`, cursor | — | `Notification[]` (type, title, body, deepLink, read) |
| GET | `/notifications/me/preferences` | Read per-channel toggles | — | `NotificationPreferences` |
| PUT | `/notifications/me/preferences` | Update toggles | `NotificationPreferences` | `NotificationPreferences` |
| POST | `/notifications/{notificationId}/read` | Mark one read | — | 204 |

## Support

| Method | Path | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| POST | `/support/tickets` | Open ticket (`subject`, `body`, optional `orderId`) | `TicketCreate` | `Ticket` / 201 |
| GET | `/support/tickets/me` | Own tickets | — | `Ticket[]` (status open/assigned/in_progress/resolved/closed) |
| GET | `/support/tickets/{ticketId}` | Detail with `messages[]` (`authorRole`: customer/merchant/provider/rider/agent) | — | `TicketDetail` |
| POST | `/support/tickets/{ticketId}/messages` | Reply | `body` (maxLength 4000) | `TicketDetail` / 201 |

## Conversations

| Method | Path | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/conversations` | My conversations, `status` filter (`open`/`archived`/`blocked`) + cursor | — | `Conversation[]` (subject, lastMessagePreview, unreadCount) |
| POST | `/conversations` | Open a conversation (customer; `orderId` optional links it to an order) | `ConversationCreate` (merchantId, subject ≤160, initialMessage ≤2000) | `Conversation` / 201 / 422 |
| GET | `/conversations/{conversationId}` | Detail with `participants[]` (`role` customer/merchant_staff/system, `displayName`, `maskedPhone`) | — | `ConversationDetail` / 403 / 404 |
| GET | `/conversations/{conversationId}/messages` | Message history, cursor | — | `ChatMessage[]` |
| POST | `/conversations/{conversationId}/messages` | Send (body 1–2000, `attachments` max 4) | `ChatMessageCreate` | `ChatMessage` / 201 / 409 |
| POST | `/conversations/{conversationId}/read` | Mark conversation read | — | 204 |
| POST | `/conversations/{conversationId}/archive` | Archive (either party) | — | 204 |
| POST | `/conversations/{conversationId}/block` | Block (moderation, staff only) | `reason` ≤500 | `Conversation` / 403 |
| GET | `/conversations/unread-count` | Unread badge count | — | `{count}` |

UI notes: `ConversationStatus` open/archived/blocked; `ChatMessage.authorRole` customer/merchant_staff/system — merchant replies carry the acting staff identity. Error codes: `CONVERSATION_NOT_FOUND`, `CONVERSATION_FORBIDDEN`, `CONVERSATION_BLOCKED`, `CONVERSATION_ARCHIVED`, `MESSAGE_EMPTY`, `MESSAGE_TOO_LONG`, `MESSAGE_RATE_LIMITED`, `MESSAGE_ATTACHMENT_INVALID`. Real-time via `message.received` (push + in-app). Details in MESSAGES.md.

## Store settings

| Method | Path | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/merchants/me/settings` | Current settings (hours, announcement, cover, recommended items, acceptance, print) | — | `StoreSettings` |
| PUT | `/merchants/me/settings` | Full replace of store settings | `StoreSettingsUpdate` | `StoreSettings` |
| POST | `/merchants/me/closure-protection` | Apply/cancel closure protection (`active`, `reason` ≤500, `until` nullable) | — | `ClosureProtection` (penaltyExempt) |

UI notes: settings PUT is a full replace; business hours per `dayOfWeek` 0–6 with `closed` flag; `printSettings.copies` bounded 1–5. Details in STORE-MANAGEMENT.md and SETTINGS.md.

## Chain stores and product templates

| Method | Path | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/merchants/me/stores` | Chain store list (per-store verification, open state, closureProtection) | — | `ChainStore[]` |
| PATCH | `/merchants/me/stores/{storeId}` | Update one store's settings | `StoreSettingsUpdate` | `ChainStore` |
| GET | `/product-templates` | Template list | — | `ProductTemplate[]` |
| POST | `/product-templates` | Create template (`name` ≤160, `items`) | `ProductTemplate` | `ProductTemplate` / 201 |
| PATCH | `/product-templates/{templateId}` | Update template | `ProductTemplate` | `ProductTemplate` |
| DELETE | `/product-templates/{templateId}` | Delete template | — | 204 |
| POST | `/product-templates/{templateId}/apply` | Apply to stores (`storeIds` required, `overwritePrices` default false) | — | 204 |
| GET | `/catalogue-items/{itemId}/logs` | Product operation log (`at`, `actor`, `action`, `before`, `after`) | — | array |

## Dine-in and reservations

| Method | Path | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/dine-in/tables` | Own tables | — | `DineInTable[]` |
| POST | `/dine-in/tables` | Create table (`label` ≤40, `capacity` ≥1) | `DineInTable` | `DineInTable` / 201 |
| PATCH | `/dine-in/tables/{tableId}` | Update table | `DineInTable` | `DineInTable` |
| DELETE | `/dine-in/tables/{tableId}` | Delete table | — | 204 |
| GET | `/dine-in/tables/{tableId}/qr` | QR payload + `menuUrl` for a table | — | `{qrPayload, menuUrl}` |
| POST | `/dine-in/orders` | Open a bill at a table (customer, from QR) | `DineInOrderCreate` | `DineInOrder` / 201 / 422 |
| GET | `/dine-in/orders/me` | Own dine-in bills, `status` filter | — | `DineInOrder[]` |
| GET | `/dine-in/orders/{dineInOrderId}` | Bill detail (parties only) | — | `DineInOrder` |
| POST | `/dine-in/orders/{dineInOrderId}/confirm-payment` | Confirm discounted bill payment (merchant) | — | `DineInOrder` |
| POST | `/dine-in/orders/{dineInOrderId}/close` | Close bill after settlement | — | `DineInOrder` |
| POST | `/reservations` | Customer reserves a table/queue slot | `merchantId`, `partySize` 1–50, `scheduledFor`, `note` ≤300 | `Reservation` / 201 / 422 |
| GET | `/reservations/me` | Own reservations | — | `Reservation[]` |
| POST | `/reservations/{reservationId}/cancel` | Cancel a reservation | — | `Reservation` |

UI notes: `DineInOrderStatus` (open/billing/paid/closed/cancelled); `ReservationStatus` (pending/confirmed/seated/completed/cancelled/no_show); conflict codes `DINE_IN_TABLE_IN_USE`, `DINE_IN_ORDER_STATUS_CONFLICT`, `DINE_IN_BILL_NOT_PAYABLE`, `RESERVATION_TABLE_FULL`, `RESERVATION_TIME_IN_PAST`. Details in DINE-IN.md.

## Group buys and vouchers

| Method | Path | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/group-buys` | Public live deals | — | `GroupBuyDeal[]` |
| POST | `/group-buys` | Create a deal (merchant) | `GroupBuyDeal` | `GroupBuyDeal` / 201 |
| GET | `/group-buys/{groupId}` | Deal detail | — | `GroupBuyDeal` / 404 |
| PATCH | `/group-buys/{groupId}` | Self-edit own deal | `GroupBuyDeal` | `GroupBuyDeal` |
| POST | `/group-buys/{groupId}/extend` | Extend live deal (`newEndsAt`) | — | `GroupBuyDeal` |
| POST | `/group-buys/{groupId}/delist` | Delist own deal | — | `GroupBuyDeal` |
| POST | `/group-buys/{groupId}/relist` | Apply for re-listing | — | `GroupBuyDeal` |
| GET | `/group-buys/{groupId}/vouchers` | Sold vouchers, `status` filter + cursor | — | `Voucher[]` |
| POST | `/group-buys/{groupId}/purchase` | Customer purchase (`quantity` 1–20) | — | `Voucher[]` / 201 |
| POST | `/vouchers/{voucherCode}/verify` | Verify by code/QR, body `merchantId` | — | 200 `Voucher` / 409 |
| GET | `/vouchers/verify-history` | Verification log (`result`: redeemed/invalid/expired/already_used) | — | array |

UI notes: `GroupBuyStatus` (draft/pending_review/live/extended/delisted/ended/rejected); `VoucherStatus` (unused/redeemed/expired/refunded/void); verify 409 codes `VOUCHER_INVALID_CODE`, `VOUCHER_ALREADY_USED`, `VOUCHER_EXPIRED`, `VOUCHER_NOT_REDEEMABLE_AT_MERCHANT`, `VOUCHER_REFUND_PENDING`; extension invalid on non-live deals (`GROUP_BUY_EXTEND_INVALID`). Details in GROUP-BUY.md.

## Promotions and coupons

| Method | Path | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/promotions?merchantId=` | Public active promotions | — | `Promotion[]` |
| POST | `/promotions` | Create campaign (merchant) | `Promotion` | `Promotion` / 201 |
| PATCH | `/promotions/{promotionId}` | Update own campaign | `Promotion` | `Promotion` |
| POST | `/promotions/{promotionId}/pause` | Pause/resume (`paused`) | — | `Promotion` |
| GET | `/promotions/{promotionId}/performance` | Performance (impressions, clicks, redeemCount, spendTZS, attributedRevenueTZS, roiPercent) | — | `PromotionPerformance` |
| POST | `/coupons` | Create + distribute coupon campaign | `CouponCampaign` | `CouponCampaign` / 201 |
| GET | `/coupons/me` | Customer wallet coupons, `status` filter | — | `Coupon[]` |
| POST | `/coupons/{couponId}/claim` | Customer claims a coupon | — | `Coupon` / 201 |

UI notes: `PromotionType` (discount/spend_based/instant_discount/bargain/coupon/traffic); status draft/pending_review/live/paused/rejected/ended; `PromotionPerformance` ROI is server-computed. Coupon codes: `PROMOTION_CONFLICT_ACTIVE`, `PROMOTION_BUDGET_EXCEEDED`, `COUPON_CAMPAIGN_SOLD_OUT`, `COUPON_ALREADY_CLAIMED`, `COUPON_MINIMUM_SPEND_NOT_MET`. Traffic campaigns (advertising) phased M7c — not built. Details in PROMOTIONS.md.

## Loyalty members and tiers

| Method | Path | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/members` | Loyalty members for own store | — | `LoyaltyMember[]` |
| POST | `/members` | Register (`name` ≤120, `phone`) | — | `LoyaltyMember` / 201 |
| PATCH | `/members/{memberId}` | Update a member | `LoyaltyMember` | `LoyaltyMember` |
| POST | `/members/{memberId}/top-up` | Record top-up (`amountTZS`, `paymentMethod` enum mpesa/tigo_pesa/airtel_money/card/cash) | — | `LoyaltyMember` |
| GET | `/membership-tiers` | Tier config for own store | — | `MemberTier[]` |
| PUT | `/membership-tiers` | Configure tiers + `topUpRewards` (`thresholdTZS` → `bonusTZS`) | `{tiers, topUpRewards}` | `MemberTier[]` |

UI notes: `MemberTier.discountBps` rendered as percent from API value; errors `MEMBER_PHONE_EXISTS`, `TOP_UP_BELOW_THRESHOLD`, `MEMBER_INSUFFICIENT_BALANCE`, `TIER_NOT_FOUND`. Details in MEMBERSHIP-LOYALTY.md.

## Staff and devices

| Method | Path | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/merchants/me/staff` | Staff accounts | — | `MerchantStaff[]` |
| POST | `/merchants/me/staff` | Invite/create (`name`, `phone`, `role`) | `MerchantStaff` | `MerchantStaff` / 201 |
| PATCH | `/merchants/me/staff/{staffId}` | Update role/permissions | `MerchantStaff` | `MerchantStaff` |
| DELETE | `/merchants/me/staff/{staffId}` | Remove staff | — | 204 |
| GET | `/devices` | Registered devices | — | `MerchantDevice[]` |
| POST | `/devices` | Register (`type`, `label` ≤80) | `MerchantDevice` | `MerchantDevice` / 201 |
| PATCH | `/devices/{deviceId}` | Update device settings | `MerchantDevice` | `MerchantDevice` |
| DELETE | `/devices/{deviceId}` | Unregister | — | 204 |

UI notes: `MerchantStaffRole` (owner/manager/cashier/kitchen/waiter), status invited/active/suspended; device types printer/pos/kitchen_display/cashier_terminal, status online/offline/error. Errors `STAFF_LAST_OWNER`, `STAFF_ROLE_FORBIDDEN`, `DEVICE_OFFLINE`, `PRINT_QUEUE_FULL`. Details in STAFF-AND-DEVICES.md.

## Wallet and withdrawals

| Method | Path | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/wallet` | Balance projection (withdrawableTZS, pendingTZS, totalTZS) | — | `Wallet` |
| GET | `/wallet/transactions` | Transaction history, cursor | — | `WalletTransaction[]` |
| POST | `/wallet/withdrawals` | Request withdrawal (`amountTZS` ≥1) | — | `Withdrawal` / 201 / 409 |
| GET | `/wallet/withdrawals` | Withdrawal history | — | `Withdrawal[]` |

UI notes: `WalletTransaction.type` settlement/withdrawal/refund/adjustment/coupon_cost/promotion_spend/group_buy_settlement (signed `amountTZS`); `WithdrawalStatus` pending/processing/paid/failed/exception. Errors `WALLET_INSUFFICIENT_BALANCE`, `WITHDRAWAL_BELOW_MINIMUM`, `WITHDRAWAL_ACCOUNT_MISSING`, `WITHDRAWAL_ALREADY_PROCESSED`, `WITHDRAWAL_RATE_LIMITED`. Details in EARNINGS.md.

## Analytics

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/analytics/dashboard` | Today's real-time overview (`today`: orderCount, dineInCount, groupBuyCount, revenueTZS, newCustomers, averageOrderValueTZS; `live`: activeOrders, activeDineInTables, openAlerts) | `AnalyticsDashboard` |
| GET | `/analytics/traffic?from&to` | Traffic by channel (search/category/promotion/group_buy/dine_in_qr/direct/referral) | `TrafficAnalysis` |
| GET | `/analytics/products?from&to` | Product performance (unitsSold, revenueTZS, ordersCount, availabilityRate) | `ProductPerformance[]` |
| GET | `/analytics/revenue?from&to` | Revenue composition (delivery/dine_in/group_buy/pickup) | `RevenueAnalysis` |
| GET | `/analytics/benchmarks` | Store score 0–100, percentile, metric comparisons | `BenchmarkSummary` |
| GET | `/analytics/diagnostics` | AI diagnostics (severity issue/warning/opportunity) — phased M7e, not built | array |
| POST | `/analytics/reports/export` | Permissioned, logged export (`reportType` revenue/products/traffic/orders, `from`, `to`) | `{downloadUrl, expiresInSeconds}` |

UI notes: errors `ANALYTICS_RANGE_INVALID`, `ANALYTICS_REPORT_EXCEEDS_LIMIT`, `ANALYTICS_EXPORT_NOT_READY`. Details in ANALYTICS.md.

## Order operations

| Method | Path | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| POST | `/orders/{orderId}/reject` | Reject with `reason` ≤500 (merchant) | — | `Order` / 409 |
| POST | `/orders/{orderId}/rush` | Customer hurry-up request | — | 204 |
| GET | `/orders/me/advance?date=` | Scheduled advance orders for the merchant day | — | `Order[]` |
| GET | `/orders/me?status=` | Own orders with status filter + cursor | — | `Order[]` |

UI notes: reject codes `ORDER_ALREADY_REJECTED`, `ORDER_REJECT_AFTER_ACCEPTANCE`; rush recorded as `rushRequestedAt` on `Order` and `order.rush_requested` event; advance orders carry `scheduledAt`, reminder 30 min prior (`order.scheduled_reminder`); `ORDER_SCHEDULED_IN_PAST` on invalid scheduling. Details in ORDER-FLOW.md.

## Order alert settings

| Method | Path | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/notifications/me/order-settings` | Acceptance method, voiceAlerts, channels, quietHours, autoAcceptWithinSeconds (30–300) | — | `OrderAlertSettings` |
| PUT | `/notifications/me/order-settings` | Update settings | `OrderAlertSettings` | `OrderAlertSettings` |

## Conventions the app relies on

- Idempotency keys are client-supplied on order/payment creation (customer side); merchant mutations retry on network failure only after confirming the response, never blindly.
- Sensitive fields (`payoutAccount`, documents, customer phone in `AddressSnapshot.contactPhone`) arrive masked; the UI never unmasks or logs them.
- `deepLink` on notifications routes to order detail, ticket, or payout statement.
