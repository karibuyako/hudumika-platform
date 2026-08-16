# HUDumika Notifications

## Event catalog

Emit for every event below; per-event channel defaults in parentheses.

| Event | Roles notified | Channels |
| --- | --- | --- |
| `otp.requested` / `otp.verified` | actor | SMS/email, in-app |
| `order.created` | customer | in-app, push |
| `payment.success` / `payment.failed` | customer | in-app, push, SMS (failed) |
| `order.accepted` | customer | push, in-app |
| `order.preparing` | customer | push |
| `order.rider_assigned` | customer | push |
| `order.picked_up` | customer | push |
| `order.delivered` | customer, merchant | push, in-app |
| `order.completed` | customer, merchant, rider | in-app |
| `order.cancelled` | all parties | push, in-app |
| `order.rejected` | customer | push, in-app |
| `order.rush_requested` | merchant | push, in-app |
| `order.scheduled_reminder` (30 min before advance order) | merchant, customer | push, SMS |
| `refund.processed` | customer | SMS, in-app |
| `payout.paid` / `payout.failed` / `payout.exception` | earner | in-app, push (failed) |
| `withdrawal.paid` / `withdrawal.failed` | merchant | in-app, SMS (failed) |
| `dine_in.order_opened` | merchant | in-app |
| `dine_in.bill_requested` | merchant | push, in-app |
| `dine_in.paid` | merchant | in-app |
| `reservation.requested` / `reservation.confirmed` / `reservation.reminder` | merchant, customer | push, in-app |
| `group_buy.created` | merchant | in-app |
| `group_buy.moderated` (approved/rejected) | merchant | in-app |
| `group_buy.sold` (first sale / milestone) | merchant | in-app |
| `voucher.redeemed` | merchant | in-app |
| `promotion.moderated` (approved/rejected/paused) | merchant | in-app |
| `coupon.claimed` (daily digest) | merchant | in-app |
| `member.top_up` | merchant | in-app |
| `staff.invited` / `staff.suspended` | staff user | in-app |
| `analytics.diagnostic` (weekly AI report ready) | merchant | in-app |
| `inventory.low_stock` | merchant staff (manager+) | in-app, push |
| `inventory.out_of_stock` | merchant staff (manager+) | in-app |
| `purchase_order.received` | merchant | in-app |
| `approval.requested` | approver (manager/owner) | in-app, push |
| `approval.decided` | requester | in-app |
| `report.ready` (scheduled report) | recipients | email |
| `webhook.delivery_failed` | merchant (owner) | in-app |
| `integration.disconnected` | merchant (owner) | in-app |
| `data_export.ready` | requester | in-app |
| `print.job_failed` | merchant staff | in-app |
| `payout_account.verified` | merchant owner | in-app |
| `order.rush_requested` (see above) | merchant | push, in-app |
| `rush.replied` | customer | push |
| `refund.request_received` | merchant | in-app |
| `refund.decision` | customer | push, in-app |
| `task.new` (anomaly/violation) | merchant staff (manager+) | in-app, push |
| `risk.event_detected` | merchant owner | in-app |
| `invoice.issued` | merchant | in-app |
| `settlement.paid` | merchant | in-app |
| `platform_event.opened` / `platform_event.closing` | merchant | in-app |
| `flash_sale.live` / `flash_sale.ended` | merchant | in-app |
| `kitchen_camera.offline` | merchant | in-app |
| `compliance.recheck_completed` | merchant | in-app |
| `order.rider_arrived_pickup` | merchant, customer | in-app |
| `order.failed_delivery` / `order.returning` | customer, merchant | push, in-app |
| `order.rescheduled` | customer, merchant | push, in-app |
| `order.transfer_requested` | dispatch/ops | in-app |
| `pod.submitted` | merchant | in-app |
| `rider.mission_completed` | rider | push, in-app |
| `sos.created` | dispatch + safety ops (staff) | push, in-app (critical) |
| `sos.acknowledged` | rider | in-app |
| `tip.received` | rider | push, in-app |
| `shift.reminder` (15 min before) | rider | push |
| `shift.started` / `shift.ended` | rider | in-app |
| `shift.swap_requested` | target rider | in-app, push |
| `shift.swap_decided` | requester | in-app |
| `shift.break_started` / `shift.break_ended` | rider | in-app |
| `order.held` / `order.unheld` | rider, dispatch | in-app |
| `order.add_items_approved` / `order.add_items_declined` | rider | in-app |
| `trip.shared` | rider | in-app |
| `surge.active` (zone boost started) | riders in zone | push, in-app |
| `leaderboard.updated` (weekly digest) | rider | in-app |
| `rest.reminder` (extended driving) | rider | push |
| `trip.completed` (batch summary with earnings) | rider | in-app |
| `forecast.surge_incoming` (15-min-ahead zone alert) | riders in zone | push, in-app |
| `safety.fatigue_detected` / `safety.crash_detected` | rider + dispatch | push (critical) |
| `safety.rest_enforced` (mandatory break started) | rider | push |
| `safety.crash_acknowledged` | dispatch + emergency contacts | push (critical) |
| `sync.completed` (offline backlog flushed) | rider | in-app |
| `booking.requested` | provider | push |
| `job.offered` (marketplace offer) | provider | push, in-app |
| `quote.requested` (customer wants an estimate) | provider | push, in-app |
| `job.quote_required` (diagnosis needs quote) | provider | in-app |
| `job.assigned_technician` | technician | push, in-app |
| `job.reminder` (before scheduled slot) | provider, customer | push, SMS |
| `job.check_in` | customer | in-app |
| `job.paused` / `job.resumed` | customer | in-app |
| `job.escalated` / `job.provider_late` | ops, customer | push, in-app |
| `job.warranty_claimed` | provider, ops | in-app |
| `recurring.booking_created` | provider, customer | in-app |
| `sla.deadline_approaching` | dispatcher, provider owner | push, in-app |
| `document.expiring` / `document.expired` | provider | in-app |
| `trust.flag_raised` (risk flag) | provider owner, ops | in-app |
| `leg.started` / `leg.completed` | customer | push, in-app |
| `handoff.required` | next-leg rider/carrier | push, in-app |
| `handoff.completed` | customer | in-app |
| `consignment.departed` / `consignment.arrived` | hub staff, customers on board | in-app |
| `consignment.exception` (scan mismatch/missing) | ops, carrier | push (critical) |
| `waybill.updated` | customer (tracking timeline) | in-app |
| `intercity.eta_updated` | customer | push, in-app |
| `shipment.created` | merchant | in-app |
| `package.scanned` | next handler | in-app |
| `container.sealed` | driver | in-app |
| `trip.departed` / `trip.arrived` | driver, hubs | push, in-app |
| `reconciliation.failed` | ops, driver | push (critical) |
| `plan.replanned` (alternate trip/vehicle) | driver, hubs | push, in-app |
| `logistics.anomaly` (scan/GPS mismatch) | ops, trust & safety | push (critical) |
| `exception.created` / `exception.resolved` | ops, affected parties | push, in-app |
| `exception.escalated` (security/incident) | ops manager | push (critical) |
| `plan.optimized` (global re-optimization) | dispatchers, drivers | in-app |
| `facility.whitelist_granted` / `facility.whitelist_revoked` | rider | in-app |
| `warehouse.stock_low` | merchant, ops | in-app |
| `carrier.handoff_required` (line-haul to carrier) | carrier, ops | push, in-app |
| `warehouse.fulfilled` (order ships from warehouse) | customer | push, in-app |
| `admin.broadcast` (platform push campaign) | targeted audience | push, in-app |
| `admin.sla_breach` | ops manager | push (critical) |
| `admin.compliance_expiring` (license/insurance/certificate) | compliance | in-app |
| `shipment.frozen` / `shipment.unfrozen` | carrier, hub, affected parties | push (critical) |
| `plan.disruption_detected` (breakdown/late auto-detected) | ops, dispatchers | push (critical) |
| `quote.issued` | customer | push, in-app |
| `quote.decision` | provider | in-app |
| `proof_of_service.submitted` | customer | in-app |
| `invoice.issued` (service) | customer | push, in-app |
| `warranty.issued` | customer | in-app |
| `warranty.claim_opened` | provider, ops | in-app |
| `booking.followup_due` (warranty follow-up) | provider | in-app |
| `booking.accepted` | customer | push, in-app |
| `booking.declined` | customer | push |
| `booking.reminder` (1 h before) | both parties | push, SMS |
| `booking.arrived` | customer | push |
| `booking.completed` | customer, provider | in-app, push |
| `booking.no_show` | provider, customer | in-app |
| `dispute.opened` / `dispute.resolved` | parties | in-app |
| `review.received` | target | in-app |
| `review.moderated` | author | in-app |
| `ticket.reply` | requester | push, in-app |
| `ticket.assigned` | agent | in-app |
| `message.received` | conversation partner (customer or merchant staff) | push, in-app |
| `platform.announcement` | all users (broadcast) | in-app, email for policy |
| `platform.campaign` | targeted merchants/customers | in-app, push |
| `conversation.blocked` | both parties | in-app |
| `lead.reviewed` (approval changes) | merchant/provider/rider applicant | SMS, in-app |

## Delivery model

- **In-app**: `notifications` table; pull on app open + realtime via WebSocket for active session.
- **Push**: Expo Push Service (FCM/APNs behind it); device tokens stored per user, refreshed on login.
- **SMS**: transactional gateway; used for OTP, failed payments, payout failures, approval decisions.
- **Email**: transactional email for documents and legal notices.
- **Real-time**: server event stream (`/events` long-poll + `/api/ws`) pushes
  `order.updated`, `chat.message`, `campaign.updated`, `task.updated` etc. so
  badges and lists update without polling (see ARCHITECTURE.md).

All outbound sends go through the outbox worker (at-least-once) with retries and dead-letter review.

## Preferences

`notification_preferences` stores per-event toggles per channel. Example key:
`order.status:push`. High-priority system events (OTP, security, payout failures)
cannot be disabled.

## Client rules

- Apps request push permission only after explaining why (OS copy) and always keep a settings screen.
- Deep links (`deepLink`) navigate: order detail, booking detail, ticket, payout statement.
- Clients render notification time as local time; payload timestamps are UTC.
