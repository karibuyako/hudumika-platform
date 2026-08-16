# HUDumika Data Model

PostgreSQL 16. Conventions: `BIGSERIAL`/`gen_random_uuid()` PKs, `TIMESTAMPTZ` (UTC), money as `BIGINT` TZS minor units, soft delete via `deleted_at` where noted, every table gets `created_at`/`updated_at`.

## Core identities

### users
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| phone | text unique | canonical `+255...` |
| email | text null unique | |
| full_name | text | |
| avatar_url | text null | |
| locale | text default 'en' | `en` / `sw` / `ar` |
| password_hash | text null | only if password login is added |
| created_at / updated_at | timestamptz | |

### roles
One person may hold several roles; switching never mixes data.
| column | type |
| --- | --- |
| user_id | uuid FK |
| role | enum(customer, merchant, provider, rider) |
| merchant_id | uuid null FK |
| provider_id | uuid null FK |
| rider_id | uuid null FK |
| active | bool |

### sessions
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| user_id | uuid FK | |
| role | text | role the token is scoped to |
| access_token_hash | text | SHA-256 of JWT |
| refresh_token_hash | text | |
| expires_at | timestamptz | |
| revoked_at | timestamptz null | |
| device_info | jsonb | |

### otp_requests
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| channel | enum(phone, email) | |
| destination | text | |
| purpose | enum(login, signup, password_reset, verify_role) | |
| code_hash | text | SHA-256, never plaintext |
| expires_at | timestamptz | 5 min |
| attempts | int default 0 | max 5 |
| verified_at | timestamptz null | |
| created_at | timestamptz | rate limit: 3 per 5 min |

## Marketplaces

### cities / service_areas
| cities | service_areas |
| --- | --- |
| id, name, country | id, city_id FK, name, polygon `GEOGRAPHY` |

### merchants
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| owner_user_id | uuid FK | |
| business_name | text | |
| description | text | |
| logo_url | text null | |
| city_id | uuid FK | |
| business_type | enum(restaurant, shop, grocery, pharmacy, retail, tickets, other) | |
| verification | enum(pending, documents_review, approved, rejected, suspended, changes_requested) | |
| commission_rate_bps | int | set on approval by admin |
| payout_cycle_days | int default 3 | |
| payout_account | text null | masked by default |
| is_open | bool default true | |
| rating / review_count | numeric(3,2) / int | computed from reviews |

### merchant_members
Staff of a merchant (owner, managers, cooks) with permissions per member.

### providers
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| owner_user_id | uuid FK | |
| name | text | |
| trade | enum(plumbing, electrical, cleaning, repairs, carpentry, painting, other) | |
| bio | text | |
| avatar_url | text null | |
| base_rate_tzs | bigint | |
| verification | enum(...) | same as merchants |
| reliability_score | int 0–100 | from cancellations/no-shows |
| rating / review_count | numeric(3,2) / int | computed |
| payout_cycle_days | int default 7 | |
| service_areas | jsonb | array of area ids |

### provider_staff
Provider team with capability-based roles: `(id, provider_id FK, name, phone, role enum(owner, dispatcher, technician, supervisor), capabilities jsonb, status enum(invited, active, suspended), created_at)` — capabilities are explicit per member (e.g. `view_assigned_jobs`, `accept_job`, `submit_quote`, `assign_technician`, `complete_job`, `view_all_jobs`, `view_schedule`, `contact_customer`, `monitor_live_jobs`); never inherited across roles. Removing the last owner is blocked (`PROVIDER_STAFF_LAST_OWNER`).

### provider_job_offers
Marketplace offers: `(id, booking_id FK, provider_id FK, kind enum(nearby, recommended, offer, quote_request), match_score null, reasons jsonb, expires_at, accepted_at null, created_at)` — feeds `GET /dispatch/provider-jobs`; acceptance window enforced (`JOB_OFFER_EXPIRED`).

### service_categories_config
Dynamic category engine: `(id, name, required_skills jsonb, required_certifications jsonb, pricing_model enum(fixed, hourly, quote, dynamic), default_duration_minutes, questionnaire_template jsonb, required_photos int, required_equipment jsonb, cancellation_rules, warranty_days int, commission_bps int)` — every new vertical is configuration, not code.

### provider_inventory
`(id, provider_id FK, name, category enum(part, consumable, equipment, tool), stock_on_hand, low_stock_threshold, unit_cost_tzs null, assigned_technician_id null, updated_at)` — parts used on a booking (`booking_parts`) deduct stock; tool/equipment assignment per technician.

### provider_service_plans
Recurring/subscription services: `(id, provider_id FK, name, service_id FK, frequency enum(weekly, biweekly, monthly, quarterly, annually), price_tzs, active, customer_count, created_at)` — bookings link `recurring_plan_id`; automatic recurring booking sweeper.

### service_contracts
B2B contracts with SLAs: `(id, provider_id FK, organization_name, locations jsonb, covered_services jsonb, sla_response_minutes, sla_resolution_minutes null, pricing jsonb, coverage_area jsonb, working_hours, escalation_rules, status enum(draft, active, expired, cancelled), created_at)` — bookings link `contract_id` + `sla_deadline_at`.

### provider_documents
Document service lifecycle: `(id, provider_id FK, type enum(identity, license, certificate, insurance, tax, registration, vehicle, background_check, training), url, status enum(uploaded, processing, verified, rejected, expiring, expired), expiry_date null, verified_at null)`.

### provider_trust
`(provider_id PK, trust_score int, risk_score int, flags jsonb, verified_badge bool, tier enum(bronze, silver, gold, platinum))` — fed by fraud_signals, cancellations, reviews, and off-platform-payment reports.

### provider_services
Provider service listings (the "Dianping Manager" catalog): `(id, provider_id FK, name, description, trade, duration_minutes, pricing jsonb {base_tzs, per_hour_tzs, trip_fee_tzs, parts_included}, active, created_at)` — separate from merchant catalogue items.

### provider_technicians
Contractor/fleet team: `(id, provider_id FK, name, phone, trade, skills jsonb, status enum(idle, on_job, offline), current_booking_id null, rating null, created_at)` — bookings may assign `technician_id`.

### provider_certifications
`(id, provider_id FK, type, number, issuer, issued_at, expiry_date, document_url, verified bool, status enum(pending, verified, rejected, expired))` — displayed on the public provider profile for trust.

### booking_quotes / booking_parts / service_invoices / service_warranties
- `booking_quotes`: `(id, booking_id FK, labor_tzs, trip_fee_tzs, parts jsonb, expires_at, status, created_at)`.
- `booking_parts`: `(id, booking_id FK, name, quantity, unit_cost_tzs, catalogue_item_id null)`.
- `service_invoices`: `(id, booking_id FK, labor_tzs, trip_fee_tzs, parts_tzs, discount_tzs, tax_tzs, total_tzs, status enum(draft, issued, paid), issued_at)`.
- `service_warranties`: `(id, booking_id FK, valid_days, coverage, follow_up_at null, status enum(active, expired, claimed), issued_at)`.

### provider_availability
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| provider_id | uuid FK | |
| day_of_week | int 0–6 | |
| start_time / end_time | time | |
| active | bool | |

### riders
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| owner_user_id | uuid FK | |
| name | text | |
| city_id | uuid FK | |
| vehicle | enum(motorcycle, bicycle, car) | |
| verification | enum(...) | |
| online | bool default false | live flag for dispatch |
| delivery_zone | text | |
| rating / review_count | numeric(3,2) / int | |

## Catalogue

### catalogue_items
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| merchant_id | uuid FK | |
| name | text | |
| description | text | |
| price_tzs | bigint | |
| category_id | uuid FK | links to product_categories |
| image_url | text null | |
| video_url | text null | product videos |
| available | bool default true | |
| options | jsonb null | list of {name, choices[{label, price_tzs}]} |
| deleted_at | timestamptz null | soft delete |

### product_categories
`(id, merchant_id FK, name, sort_order, image_url null, active bool default true)` — add/edit/sort; delete blocked while items exist (`CATEGORY_NOT_EMPTY`).

## Orders

### orders
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| customer_user_id | uuid FK | |
| merchant_id | uuid FK | |
| rider_id | uuid FK null | |
| status | enum(draft, pending_payment, paid, merchant_accepted, preparing, rider_assigned, picked_up, delivering, delivered, completed, cancelled, refunded, failed, disputed) | |
| subtotal_tzs / delivery_fee_tzs / platform_fee_tzs / tax_tzs / discount_tzs / total_tzs | bigint | |
| delivery_address | jsonb | AddressSnapshot |
| note | text | |
| idempotency_key | text | unique per customer |
| created_at / updated_at | timestamptz | |

### order_items
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| order_id | uuid FK | |
| catalogue_item_id | uuid FK | |
| name_snapshot | text | snapshot at order time |
| quantity | int | |
| unit_price_tzs | bigint | server-computed |

### order_events
Append-only. `(order_id, status, at, by, note)`.

## Bookings

### bookings
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| customer_user_id | uuid FK | |
| provider_id | uuid FK | |
| service_id | uuid FK | |
| status | enum(draft, pending_payment, paid, provider_requested, provider_accepted, scheduled, provider_arrived, in_progress, awaiting_customer_confirmation, completed, declined, cancelled, refunded, disputed, no_show) | |
| scheduled_for | timestamptz | |
| duration_minutes | int | |
| price_* | bigint | PriceBreakdown |
| address | jsonb | |
| description | text | |
| idempotency_key | text | |
| created_at / updated_at | timestamptz | |

### booking_events
Append-only. `(booking_id, status, at, by, note)`.

## Payments

### payment_intents
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| order_id | uuid FK null | |
| booking_id | uuid FK null | exactly one set |
| method | enum(mpesa, tigo_pesa, airtel_money, card, cod) | |
| amount_tzs | bigint | |
| status | enum(created, pending, paid, failed, refunded, partially_refunded) | |
| provider_reference | text null | |
| idempotency_key | text unique | |
| paid_at | timestamptz null | |
| refunds | jsonb | list of {amount, reason, at, by} |

### payment_transactions
Every provider call/response logged: `(intent_id, provider, action, status, payload, created_at)`.
Webhooks: store raw body + signature verification result (append-only).

### outbox
`(id, aggregate_type, aggregate_id, payload, topic, processed_at)` — outbox pattern for provider sends and notifications.

## Payouts (immutable ledger)

### ledger_entries
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| account_owner_id | uuid FK | user id of earner |
| account_type | enum(merchant, provider, rider) | |
| type | enum(order_earning, booking_earning, delivery_fee, commission, adjustment, payout, refund, bonus) | |
| amount_tzs | bigint signed | negative for debits |
| balance_tzs | bigint | running balance |
| reference_type / reference_id | text / uuid | order, booking, payout |
| idempotency_key | text unique | |
| created_at | timestamptz | |

Immutable: no UPDATE/DELETE. Corrections are new adjustment entries.

### payout_batches
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| cycle | date | |
| status | enum(draft, processing, settled, exception) | |
| total_tzs / count | bigint / int | |
| settled_at | timestamptz null | |

### payout_entries
`(id, batch_id FK, owner_id, amount_tzs, method, status enum(pending, processing, paid, failed, exception), gateway_reference, reason null, created_at, paid_at)`.

## Reviews and moderation

### reviews
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| target_type | enum(merchant, provider, rider, customer) | |
| target_id | uuid | |
| author_user_id | uuid FK | |
| order_id / booking_id | uuid null | one completion link |
| rating | int 1–5 | |
| body | text | |
| state | enum(pending, published, hidden, deleted) | |
| created_at | timestamptz | |

Unique constraint: one review per (author, target, order/booking). Rating averages are `AVG(rating)` over published reviews — never hardcoded.

### review_reports
`(id, review_id FK, reporter_user_id, reason, state enum(open, resolved, dismissed))`.

## Notifications

### notifications
`(id, user_id FK, type, title, body, deep_link, read bool, created_at)`.

### notification_preferences
`(user_id PK, push jsonb, sms jsonb, email jsonb, in_app jsonb)` — per-event toggles.

## Support

### support_tickets
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| requester_user_id | uuid FK | |
| role | enum(customer, merchant, provider, rider) | |
| subject | text | |
| status | enum(open, assigned, in_progress, resolved, closed) | |
| priority | enum(low, normal, high, critical) | |
| assigned_agent_id | uuid FK null | |
| order_id / booking_id | uuid null | |
| created_at / updated_at | timestamptz | |

### ticket_messages
`(id, ticket_id FK, author_user_id, author_role, body, created_at)`.

## Audit

### audit_logs
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| actor_user_id | uuid FK | system actor allowed |
| actor_role | text | |
| action | text | `merchant.approved`, `refund.created` |
| entity_type / entity_id | text / text | |
| details | jsonb | before/after for money, status, identity, moderation |
| ip_address | inet | |
| request_id | uuid | |
| created_at | timestamptz | |

Append-only; retention 7 years for money actions. Writes are async via outbox.

## Admin staff

### staff_members
`(id, user_id FK, role enum(super_admin, ops_manager, support_agent, merchant_ops, provider_ops, rider_ops, finance, content_manager, compliance_reviewer), mfa_enabled bool, status, created_at)`.
Permissions are derived from role in `ROLES-PERMISSIONS.md` (admin-web) — enforced server-side, never frontend-only.

## Dine-in

### dine_in_tables
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| merchant_id | uuid FK | |
| label | text | "Table 5" |
| capacity | int default 4 | |
| active | bool | |
| current_dine_in_order_id | uuid null | |

### dine_in_orders
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| merchant_id | uuid FK | |
| table_id | uuid FK | |
| customer_user_id | uuid null | anonymous scans allowed |
| status | enum(open, billing, paid, closed, cancelled) | |
| items | jsonb | snapshot of items, quantities, unit prices |
| totals_* | bigint | PriceBreakdown |
| paid_at | timestamptz null | |
| idempotency_key | text | |

### reservations
`(id, merchant_id FK, table_id null, customer_user_id FK, party_size, scheduled_for, status enum(pending, confirmed, seated, completed, cancelled, no_show), note)`.

## Group buy

### group_buy_deals
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| merchant_id | uuid FK | |
| title / description | text | |
| image_url | text null | |
| price_tzs / original_price_tzs / quantity / sold_count | bigint / int | |
| validity_days | int default 90 | |
| sales_start_at / sales_end_at | timestamptz | |
| status | enum(draft, pending_review, live, extended, delisted, ended, rejected) | |
| reject_reason | text null | |

### vouchers
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| code | text unique | `GB-XXXX-XXXX` |
| group_buy_id | uuid FK | |
| customer_user_id | uuid FK | |
| price_tzs | bigint | |
| status | enum(unused, redeemed, expired, refunded, void) | |
| purchased_at / redeemed_at / expires_at | timestamptz null | |
| redeemed_by_merchant_id | uuid null | |

### voucher_verifications
Append-only history: `(id, voucher_code, merchant_id FK, staff_user_id, result enum(redeemed, invalid, expired, already_used), created_at)`.

## Promotions and coupons

### promotions
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| merchant_id | uuid FK | |
| type | enum(discount, spend_based, instant_discount, bargain, coupon, traffic) | |
| title / description | text | |
| rules | jsonb | discount %, spend threshold, bargain floor, etc. |
| budget_tzs | bigint null | |
| status | enum(draft, pending_review, live, paused, rejected, ended) | |
| starts_at / ends_at | timestamptz | |
| redeem_count / spend_tzs | int / bigint | |
| reject_reason | text null | |
| performance_* | jsonb | impressions, clicks, attributed revenue (refresh job) |

### coupon_campaigns / coupons
| coupon_campaigns | coupons |
| --- | --- |
| id, merchant_id, title, discount_tzs, minimum_spend_tzs, quantity, claimed_count, valid_until, status | id, campaign_id FK, code unique, customer_user_id null, status enum(available, claimed, used, expired, void), claimed_at, used_at, expires_at |

## Loyalty (merchant-operated)

### loyalty_members
`(id, merchant_id FK, customer_user_id null, name, phone, balance_tzs, tier_id null, total_spend_tzs, created_at)`.
### membership_tiers
`(id, merchant_id FK, name, discount_bps, threshold_tzs, perks jsonb)`.
### membership_top_up_rewards
`(id, merchant_id FK, threshold_tzs, bonus_tzs)`.
### loyalty_transactions
Append-only: `(id, member_id FK, type enum(top_up, bonus, redeem, spend), amount_tzs signed, balance_tzs, created_at)`.
### customer_memberships
Platform-wide points: `(user_id PK, points, level, member_since)`.

## Merchant staff and devices

### merchant_staff
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| merchant_id | uuid FK | |
| user_id | uuid FK null | linked staff login |
| name / phone | text | |
| role | enum(owner, manager, cashier, kitchen, waiter) | |
| permissions | jsonb | extra scopes, e.g. `orders.accept` |
| status | enum(invited, active, suspended) | |
| created_at | timestamptz | |

Staff actions reuse the audit log; cashier scope restricted to dine-in billing + voucher verification.

### devices
`(id, merchant_id FK, type enum(printer, pos, kitchen_display, cashier_terminal), label, status enum(online, offline, error), settings jsonb, last_seen_at)`.

## Chain stores and templates

### chain_stores
`(id, merchant_group_id FK, business_name, city_id, is_open, verification, closure_protection jsonb)`.
### product_templates
`(id, merchant_group_id FK, name, items jsonb, applied_store_ids jsonb, created_at)`.
### store_settings
`(merchant_id PK, business_hours jsonb, announcement, cover_image_url, recommended_item_ids jsonb, acceptance_method enum(manual, auto), phone_ordering_hours jsonb, order_notification_channels jsonb, print_settings jsonb)`.

## Wallets (merchant)

### merchant_wallets
`(merchant_id PK, withdrawable_tzs, pending_tzs, total_tzs, updated_at)` — derived from ledger entries, not a second source of truth.
### withdrawals
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| merchant_id | uuid FK | |
| amount_tzs | bigint | |
| status | enum(pending, processing, paid, failed, exception) | |
| method | text | payout account |
| reason | text null | on failure |
| created_at / paid_at | timestamptz null | |

Withdrawal creates signed ledger entries (`payout`) and wallet transactions; both immutable.

## Favorites

### favorites
`(customer_user_id PK, merchant_id PK, created_at)` — composite PK.

## Conversations (1:1 chat)

### conversations
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| merchant_id | uuid FK | |
| customer_user_id | uuid FK | |
| order_id | uuid null FK | optional context |
| subject | text | |
| status | enum(open, archived, blocked) | blocked = moderation |
| last_message_preview | text | |
| unread_count | int | per participant |
| created_at / updated_at | timestamptz | |

One conversation per (customer, merchant, order) where an order is linked; one general conversation per (customer, merchant).

### chat_messages
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| conversation_id | uuid FK | |
| author_role | enum(customer, merchant_staff, system) | |
| author_user_id | uuid null | system messages have no author |
| body | text | max 2000 chars |
| attachments | jsonb | max 4 URIs |
| read_at | timestamptz null | |
| created_at | timestamptz | |

Rules: append-only; abuse reports and blocks route to moderation (staff only);
chat data is never exposed to public endpoints. Merchant staff respond under
their own staff identity; the merchant must be the customer's conversation
partner — role checks enforce this.

## Chain and bulk operations

### merchant_groups
Enterprise identity owning one or more `chain_stores` (one account, many stores).
`(id, name, tier enum(standard, enterprise), sla_level, account_manager_user_id, monthly_volume_tzs, status)`.

### bulk_operations
`(id, merchant_group_id, type enum(price_update, availability, promotion_apply, catalogue_sync), store_ids jsonb, payload jsonb, status enum(queued, processing, completed, partial, failed), results jsonb, requires_approval bool, created_by, created_at)` — approval-gated when `requires_approval`.

## Inventory and procurement

### inventory_items
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | one per catalogue item (per store when chains) |
| catalogue_item_id | uuid FK | |
| store_id | uuid null FK | |
| stock_on_hand | int | |
| reserved | int default 0 | in-flight orders |
| low_stock_threshold | int default 10 | |
| unit_cost_tzs | bigint null | for COGS |
| last_restocked_at | timestamptz null | |

`available = stock_on_hand - reserved`; never negative (check on every mutation).

### inventory_adjustments
Append-only: `(id, item_id FK, delta signed, reason, store_id null, by, at)`.

### inventory_sync_config
`(merchant_group_id PK, enabled, master_source enum(platform, pos, erp), channels jsonb, last_synced_at)`.

### suppliers
`(id, merchant_group_id FK, name, contact_phone, contact_email, categories jsonb, payment_terms, status enum(active, suspended), created_at)`.

### purchase_orders
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| supplier_id | uuid FK | |
| store_id | uuid null | |
| status | enum(draft, sent, partially_received, received, closed, cancelled) | |
| items | jsonb | {catalogue_item_id, name, quantity, received_quantity, unit_cost_tzs} |
| expected_arrival_at | timestamptz null | |
| total_cost_tzs | bigint | |
| note | text | |
| received_at | timestamptz null | |

Receiving creates `inventory_adjustments` (stock_in) and updates `unit_cost_tzs`.

### supplier_returns
`(id, supplier_id FK, items jsonb, reason, status enum(pending, processed, rejected), created_at)`.

## Approvals

### approval_requests
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| merchant_id FK / merchant_group_id | | scope |
| type | enum(price_change, promotion, refund_above_threshold, inventory_adjustment, staff_role_change, bulk_operation) | |
| ref_type / ref_id | text / text | |
| summary | text | |
| amount_tzs | bigint null | for threshold rules |
| status | enum(pending, approved, rejected, cancelled) | |
| requested_by / decision_by | uuid / uuid null | |
| decision_comment | text null | |
| created_at / decided_at | timestamptz null | |

Decisions are audited; refund-above-threshold approvals bind to the refund workflow.

## Staff operations

### staff_shifts
`(id, merchant_id FK, staff_id FK, role, start_at, end_at, status enum(scheduled, active, completed, cancelled), store_id null)` — overlap check on create.

### attendance_records
`(id, merchant_id FK, staff_id FK, shift_id null, clocked_in_at, clocked_out_at null, duration_minutes null, source enum(app, pos))` — one open record per staff.

### commission_rules
`(id, merchant_id FK, staff_id null, type enum(per_order, per_service, per_revenue), rate_bps, active)`.

### staff_performance
Derived view (not a table): orders processed, avg handle time, cancellations, rating average, attendance rate, commission earned — computed by analytics job.

## Integrations and webhooks

### integrations
`(id, merchant_group_id FK, provider enum(pos, erp, accounting, payroll, delivery_partner, mini_program), label, status enum(connected, disconnected, error), scopes jsonb, last_synced_at, credentials_encrypted)`.

### webhook_subscriptions
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| merchant_id FK | | |
| url | text | verified on create |
| events | jsonb | event name list |
| secret_hash | text | signing secret, write-only |
| status | enum(active, disabled, failing) | failing after 5 consecutive errors |
| last_delivery_at | timestamptz null | |

### webhook_deliveries
Append-only attempts: `(id, webhook_id FK, event, status enum(success, failed, retrying), attempts, status_code, next_retry_at, delivered_at)` — retry with backoff, max 8 attempts.

## Reporting, CRM, data export

### scheduled_reports
`(id, merchant_group_id FK, name, report_type, cadence enum(daily, weekly, monthly), format enum(csv, xlsx, pdf), recipients jsonb, filters jsonb, store_ids jsonb, enabled, last_run_at)`.

### customer_segments / customer_journeys
- `customer_segments`: `(id, merchant_group_id FK, name, rules jsonb, member_count)`.
- `customer_journeys`: `(id, merchant_group_id FK, name, trigger, actions jsonb, status enum(draft, active, paused))`.
- Backed by the unified customer profile view (orders, spend, visits across stores) — CRM layer phased (M8c).

### data_export_jobs
`(id, merchant_id FK, requester_user_id, scope, format, status enum(queued, processing, ready, failed), download_url null, expires_in_seconds, created_at, completed_at)` — exports are permissioned and audited.

## Print jobs and payout accounts

### print_jobs
`(id, merchant_id FK, job_type enum(receipt, kitchen_ticket, label, voucher), order_ids jsonb, table_id null, device_id null, copies int default 1, label, status enum(queued, printing, done, failed), error null, created_at, completed_at)` — batch receipts share one job with `order_ids`.

### payout_accounts
`(merchant_id PK, type enum(mobile_money, bank), provider, account_number_encrypted, account_holder_name, verified bool, updated_at)` — masked in every response; changes require verification and are audited.

### payment_qrs
`(id, merchant_id FK, provider, amount_tzs null (variable), merchant_ref, qr_payload, expires_at)` — fixed vs variable amount collection codes.

### bank_cards
`(id, merchant_id FK, bank_name, last4, account_number_encrypted, account_holder_name, is_default bool, created_at)` — multiple cards, one default; withdrawal target selection.

### invoices
`(id, merchant_id FK, number unique, amount_tzs, status enum(draft, requested, issued, paid), buyer_details jsonb, period_from/to, issued_at, created_at)` — finance-facing billing records.

### daily_settlements
`(id, merchant_id FK, date unique, revenue_tzs, fees_tzs, payout_tzs, order_count, status enum(open, settled, paid), paid_at)` — daily settlement records; manual run/payout actions are audited (finance role).

### reconciliations
Derived view from orders + payment_intents per day: matched count, exceptions — computed, not stored.

### store_payment_accounts
`(id, merchant_id FK, type enum(mobile_money, bank), provider, account_number_encrypted, account_holder_name, is_default, verified, created_at)` — multiple collection accounts per store (distinct from payout_accounts).

### receipt_templates
`(id, merchant_id FK, name, header_text, footer_text, show_logo, is_active, created_at)` — CRUD + activate one active default.

### store_qr_codes
`(id, merchant_id FK, kind enum(ordering, collection, download, review), qr_payload, created_by, created_at)`.

### qualifications
`(id, merchant_id FK, type, url, status enum(pending, approved, rejected), created_at)` — business licenses/permits.

### kitchen_camera
`(merchant_id PK, enabled, stream_url null, public_access bool, last_checked_at)` — live kitchen feed config.

### self_pickup_config
`(merchant_id PK, enabled, pickup_ready_minutes, pickup_hours jsonb)`.

## Tasks, risk and onboarding

### tasks
| column | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| merchant_id | uuid FK | |
| kind | enum(anomaly, violation, activity, setup) | |
| title / description | text | |
| ref_type / ref_id | text null | |
| severity | enum(info, warning, critical) | |
| status | enum(open, in_progress, done, dismissed) | |
| due_at | timestamptz null | |
| created_at | timestamptz | |

### activity_submissions
`(id, merchant_id FK, platform_event_id FK, status enum(submitted, approved, rejected), submitted_at)`.

### setup_guide_steps
`(id, merchant_id FK, title, sort_order, completed bool, deep_link null)` — onboarding wizard + store setup checklist shared model.

### risk_events
`(id, merchant_id FK, type, status enum(open, reviewed, resolved), severity enum(low, medium, high), description, review_reason null, created_at)` — anomaly detection feed (refunds, velocity, chargebacks); review audited.

### onboarding_progress
`(merchant_id PK, current_step int, completed bool, submitted_at null)` — wizard state.

## Barcode, combo, menu, video

### item_barcodes
`(id, merchant_id FK, catalogue_item_id FK, code unique, format enum(ean13, upca, qr), created_at)` + `barcode_events` (append-only: generated/scanned/printed/updated).

### combos
`(id, merchant_id FK, name, description, items jsonb [{catalogue_item_id, quantity}], price_tzs, image_url null, available, created_at)`.

### menus
`(id, merchant_id FK, name, store_ids jsonb, sections jsonb [{name, item_ids}], active, created_at)` — multi-store menu resource.

### product_videos
`(id, merchant_id FK, title, url, thumbnail_url null, catalogue_item_id null, created_at)`.

## Real-time and background jobs

### server_events
Append-only event stream consumed by long-poll (`GET /events?after=<seq>`) and WebSocket (`/api/ws`):
`(id bigserial, type, payload jsonb, at)` — types: `order.updated`, `order.created`,
`payment.captured`, `notification.created`, `chat.message`, `campaign.updated`,
`ledger.updated`, `settlement.created`, `merchant.updated`, `task.updated`.

### sweeper jobs (server-side, no client endpoints)
1. Rush auto-flag — unaccepted orders > 4.5 min get `rushRequestedAt` + deadline extension (cooldown 10 min).
2. Auto-accept — per store `acceptanceMethod=auto` + `autoAcceptWithinSeconds`.
3. Pre-order reminder — ≤ 15 min before slot (once).
4. Auto-cancel — `new` orders past `deadlineAt` → cancelled with reason code `AUTO_CANCEL` + idempotent refund.
5. Campaign ticks — impressions/clicks/spend increments until budget; expires at budget.
6. Boost notices — periodic exposure notices for enrolled traffic campaigns.
7. Onboarding auto-approval (staging) — pending → active.
8. Risk engine — refund ratio > 15%/week, refund velocity ≥ 3/h, large refund > threshold, withdrawal > 80% of balance, new-device login → `risk_events`.
9. Closure protection expiry — active → expired + notification.
10. Scheduled reopen — honored only when no closure protection is active.

## Rider operations (POD, location, missions, SOS)

### proof_of_delivery
`(id, order_id FK, type enum(photo, signature, otp), value, gps_stamp jsonb, verified bool, submitted_by, submitted_at)` — one per order; duplicates rejected (`POD_ALREADY_SUBMITTED`).

### rider_locations
Latest + history: `(rider_id FK, lat, lon, accuracy_m null, activity null, reported_at)` — throttled by backend; latest feeds dispatch ETA + customer tracking.

### rider_missions
`(id, rider_id FK, title, description, target_deliveries, completed_deliveries, reward_tzs, status enum(active, completed, expired), starts_at, ends_at)` — progress derived from completed deliveries in window.

### sos_alerts
`(id, rider_id FK, type enum(safety, medical, mechanical, other), status enum(open, acknowledged, resolved), note, lat/lon null, created_at)` — rate-limited; acknowledged/resolved by ops with audit.

### order_exceptions
Failed-delivery/RTO and transfer requests: `(id, order_id FK, kind enum(failed_delivery, reschedule, transfer), reason, note, photo_url null, new_scheduled_at null, status, created_at)`.

### rider_shifts
`(id, rider_id FK, starts_at, ends_at null, status enum(scheduled, active, completed, cancelled), deliveries_completed int, earnings_tzs, cash_collected_tzs, cash_reconciled bool, clocked_in_at null, clocked_out_at null)` — clock-out requires COD cash reconciliation (`SHIFT_CASH_MISMATCH` when unreconciled).

### tips
Customer gratuity per completed order: `(id, order_id FK, rider_id FK, amount_tzs, method, note null, created_at)` — credited to the rider ledger as `tip` entries (PAYOUTS-LEDGER.md); order carries `tip_tzs`.

### shipments / packages / containers
- `shipments`: `(id, shipment_number unique, order_id FK, container_id null, status enum(planned, picked_up, at_hub, in_transit, out_for_delivery, delivered, exception), current_leg_id null, declared_value_tzs null, created_at)` — the physical object, separate from the commercial order.
- `packages`: `(id, package_id, shipment_id FK, container_id null, attributes jsonb {temperature, fragile, hazardous, high_value, max_transit_hours, allowed_modes}, status, scanned_in, scanned_out)` — GS1-style logistic units with compatibility attributes.
- `containers`: `(id, container_id, kind enum(bag, cage, pallet, lockbox, refrigerated_unit), section enum(standard, fragile, cold_chain, documents, high_value), package_ids jsonb, sealed bool, seal_code null, sealed_at null, current_trip_id null, created_at)` — groups many packages for efficient transport.

### vehicles
Generalized transport entity: `(id, vehicle_type enum(motorcycle, e_bike, bicycle, car, van, linehaul_bus, linehaul_truck, refrigerated_truck), registration, operator_id null, capacity jsonb {total_units, compartments[{name, capacity, used}]}, temperature_capable bool, security_capability enum(none, lockbox, cage, armored), permitted_routes jsonb, status enum(active, on_trip, maintenance, retired), current_location jsonb null, current_trip_id null)`.

### routes / trips
- `routes`: `(id, name, from_hub_id FK, to_hub_id FK, estimated_hours, scheduled_departures jsonb, permitted_vehicles jsonb, active)` — corridors.
- `trips`: `(id, trip_number unique, route_id FK, vehicle_id FK, consignment_ids jsonb, status enum(planned, loading, in_transit, unloading, completed, cancelled), manifest_summary jsonb, scheduled_departure null, departed_at null, arrived_at null, driver_id null, created_by, created_at)` — one vehicle departure; the driver sees a trip + manifest summary, never 327 individual orders.

### custody_entries
Append-only custody ledger: `(id, shipment_id FK, package_id null, event_type enum(picked_up, hub_in, sorted, container_loaded, vehicle_loaded, departed, arrived, unloaded, handoff, out_for_delivery, delivered), actor_id, actor_type enum(rider, driver, hub_worker, carrier, system), location_id null, vehicle_id null, hub_id null, lat/lon null, device_id null, previous_state, new_state, evidence null, at)` — answers "where was the package at 15:00?".

### warehouses / warehouse_stock
Regional/shared warehouses for pre-positioned inventory: `(id, name, city_id FK, address, lat/lon null, serving_cities jsonb, status enum(active, full, maintenance), created_at)`; `warehouse_stock`: `(warehouse_id FK, catalogue_item_id FK, quantity, updated_at)` — nearest-warehouse fulfillment (`fulfillmentSource=warehouse`) deducts stock; bulk inbound via `PUT /warehouses/{id}/stock`.

### carriers
Third-party line-haul registry: `(id, name, modes jsonb, regions jsonb, api_integration null, status enum(active, paused, suspended), created_at)` — line-haul legs can be handed to a carrier (`Consignment.carrierId`); carrier pickup/dropoff via webhooks or manual scans.

### facilities / facility_whitelist
Secure access: `(id, name, address, geofence jsonb, access_policy enum(whitelist_only, whitelist_or_otp, open), created_at)` + `facility_whitelist`: `(facility_id FK, rider_id FK)` — fixed-rider credential access for gated communities/business parks; `NOT_WHITELISTED` blocks entry scans.

### fleet_accounts
`(id, name, owner_user_id, driver_sub_account_ids jsonb, vehicles jsonb, regions jsonb, permissions jsonb, status enum(active, suspended), created_at)` — master account + sub-account model for delivery companies; `RiderPrivate.fleetAccountId` links each driver.

### delivery_exceptions
18-kind exception catalog: `(id, kind enum(missing_package, wrong_package, wrong_hub, wrong_vehicle, scan_failure, damaged_package, late_vehicle, vehicle_breakdown, rider_unavailable, bus_cancellation, hub_congestion, weather_disruption, road_closure, customer_unavailable, package_refused, route_deviation, security_incident, reconciliation_failure), shipment_id null, order_id null, trip_id null, description, reported_by, status enum(open, resolving, resolved, escalated), outcome null, auto_replanned bool, created_at, resolved_at null)` — auto-replanning moves manifests on disruption.

### logistics_anomalies
Fraud/trust signals: `(id, shipment_id FK, type enum(scan_gps_mismatch, scan_vehicle_static, wrong_hub_scan, scan_before_pickup), severity, resolved bool, created_at)` — e.g. package scanned at Hub B while the actor's GPS is 70 km away.

### hubs
City consolidation/sorting centers: `(id, name, city_id FK, address, capacity null, active)`.

### route_segments
Per-order multi-leg journey: `(id, order_id FK, sequence, type enum(first_mile, linehaul, hub_transfer, last_mile, return), mode enum(motorcycle, car, van, linehaul_bus, linehaul_truck), from_hub_id null, to_hub_id null, handled_by, status enum(pending, in_progress, completed, skipped), eta_at null, started_at null, completed_at null, custody jsonb)`.

### handoffs
Custody transfers between legs: `(id, order_id FK, from_leg_id, to_leg_id, scan_code, seal_intact bool, condition_photo_url null, lat/lon, from, to, at)` — seal-broken or scan-mismatch handoffs raise exceptions and block the leg advance.

### linehaul_consignments / linehaul_manifest
- `linehaul_consignments`: `(id, consignment_number unique, from_hub_id FK, to_hub_id FK, transport_mode enum(van, linehaul_bus, linehaul_truck), carrier_id null, order_count, status enum(manifesting, in_transit, at_hub, delivered, cancelled), scheduled_departure null, departed_at null, arrived_at null, created_by, created_at)`.
- `linehaul_manifest`: `(id, consignment_id FK, order_id FK, waybill_number, section enum(standard, fragile, cold_chain, documents, high_value), scanned_in bool, scanned_out bool)` — per-order barcode + segregation section prevents mixing errors.

### waybill_events
Append-only scan/event trail per order: `(id, order_id FK, at, type enum(scanned, handoff, loaded, departed, arrived, sorted, exception, delivered), location, actor, note null)`.

### order_holds
`(id, order_id FK, rider_id FK, reason, until null, held_at, released_at null)` — rider task hold; one active hold per order (`HOLD_ALREADY_ACTIVE`).

### order_add_item_requests
Rider-initiated additions mid-delivery: `(id, order_id FK, rider_id FK, items jsonb, reason, status enum(pending_merchant_approval, approved, declined, cancelled), decided_by null, created_at)` — approval by merchant updates order items + totals.

### trip_shares
`(id, order_id FK, rider_id FK, share_token unique, recipients jsonb, include_route bool, expires_at, created_at)` — live trip sharing with trusted contacts.

### shift_swap_requests
`(id, shift_id FK, requester_rider_id, target_rider_id, status enum(pending, approved, declined, cancelled), decided_by null, created_at)`.

### rider_performance / leaderboards
Derived views (sweeper-computed): acceptance rate, on-time %, rating, safety score, trends; leaderboards ranked by deliveries/rating/earnings/on-time per period.

### safety_events
Device/AI-detected events: `(id, rider_id FK, type enum(fatigue_detected, crash_detected, fall_detected, threat_detected, rest_enforced), source enum(camera, accelerometer, gyroscope, gps, system, manual), severity, lat/lon null, details jsonb, acknowledged bool, created_at)` — rate-limited; crash/fall escalate per DISPATCH.md and trigger SOS automation.

### rider_sync_state
Offline sync bookkeeping: `(rider_id PK, high_water_mark int, last_synced_at)` — client sends monotonic `seq` per event; server acknowledges and tracks gaps for `GET /riders/me/sync/status`.

### push_outbox
Outbound push delivery queue: `(id, driver_id FK, title, body, payload jsonb, status enum(pending, sent, failed), created_at)` — worker retries failed sends with backoff; alerts on persistent failures.

### fraud_signals
Typed fraud signals: `(id, driver_id FK, signal_type enum(gps_spoof, rapid_decline, impossible_speed, multi_device, payment_abuse), severity, details, resolved bool, created_at)` — feeds the security score (`GET /riders/me/security`) and admin risk review.

### predictive_demand_zones
Model output cache: `(zone_id FK, predicted_demand, predicted_surge_multiplier, confidence, window_from, window_to, generated_at)` — refreshed every few minutes by the forecasting job; served by `GET /dispatch/forecast`.

### manual_assignments
Dispatcher override log: `(id, order_id FK, rider_id FK, assigned_by, reason, created_at)` — every manual override is audited and appended as an order event.

### trips
Batch/multi-stop trips: `(id, rider_id FK, order_ids jsonb, status enum(active, completed, cancelled), stops jsonb [{order_id, sequence, stop_type, status}], route_optimized bool, earnings_tzs, started_at, completed_at null)` — completed trip emits `trip.completed` with the batch summary; manual reorder writes a new `stops` sequence (audited).

## Indexes (essential)

- `orders(customer_user_id, created_at DESC)`, `orders(status)`, `orders(merchant_id, status)`, `orders(rider_id, status)`
- `bookings(provider_id, scheduled_for)`, `bookings(status)`, `bookings(customer_user_id, created_at DESC)`
- `catalogue_items(merchant_id, available)`
- `ledger_entries(account_owner_id, created_at DESC)`, unique `(account_owner_id, idempotency_key)`
- `payment_intents(order_id)`, `payment_intents(booking_id)`
- `riders(online, city_id)` for dispatch scans
- `audit_logs(entity_type, entity_id)`, `audit_logs(actor_user_id, created_at DESC)`
- `otp_requests(destination, created_at DESC)` for rate limiting
