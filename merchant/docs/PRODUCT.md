# Merchant Application Specification

## Supported merchant types

- Restaurants and food vendors.
- Grocery and convenience shops.
- Pharmacies and wellness retailers.
- Florists, bakeries, and gift shops.
- Fashion and electronics retailers.
- Event and catering businesses.
- Hotels and travel businesses where approved.
- Any future product-selling category approved by operations.

## Surfaces

- Merchant web portal for full management.
- Merchant mobile app for live orders, notifications, and quick actions.

## Onboarding flow

1. Select business type.
2. Submit business name, owner, phone, email, city, address, and service area.
3. Upload registration, licence, tax, bank/mobile-money, and category-specific documents.
4. Add locations and staff.
5. Add catalogue, menu, prices, tax, modifiers, images, and availability.
6. Accept merchant agreement and commission terms.
7. Operations reviews the application.
8. Merchant receives approval, rejection reasons, or requested changes.
9. Merchant publishes the store.

## Merchant web modules

- Overview and business health.
- Orders and preparation workflow.
- Menu/catalogue manager.
- Store availability and hours.
- Customers and reviews.
- Promotions and campaigns.
- Insights and reports.
- Integrations and POS.
- Transactions and payouts.
- Staff and permissions.
- Support.

## Order handling

1. New order notification.
2. Merchant accepts or declines with a reason.
3. Merchant sets preparation estimate.
4. Merchant marks items out of stock or suggests substitutions.
5. Merchant marks order ready.
6. Rider pickup confirmation.
7. Refund, cancellation, and dispute tools.

## Merchant mobile app

- Push notifications for new orders.
- Accept/decline order.
- Adjust preparation time.
- Pause ordering.
- Mark item unavailable.
- View live order queue.
- View daily sales and payout summary.
- Contact support.

## Merchant financial rules

- Commission is configured by backend, not frontend constants.
- Promotional commission overrides have start/end dates.
- Payouts have states: pending, scheduled, paid, failed, reversed.
- Every adjustment creates an immutable ledger entry.

## Merchant acceptance criteria

- A merchant cannot publish without required verification.
- Menu changes are versioned and auditable.
- Staff permissions restrict financial and account actions.
- Merchant sees exact fees before accepting the commercial agreement.
- Merchant can export orders and payout statements.
