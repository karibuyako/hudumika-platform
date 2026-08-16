# Shared Flows and Business Rules

## Account and role flow

1. User enters phone number or email.
2. Backend sends OTP or verification link.
3. User verifies identity.
4. User selects or receives a role.
5. Backend returns a role-scoped session.
6. Client redirects to the correct application surface.

One person may have multiple roles. Role switching must never mix permissions or data views.

## Address and location flow

1. Request location permission only after explaining why it is needed.
2. Allow manual address entry and landmarks.
3. Geocode and store an address snapshot on an order or booking.
4. Do not silently change the delivery address after payment.
5. Let the customer select a saved address before checkout.

## Payment flow

1. Create an order or booking draft.
2. Calculate item/service price, delivery fee, platform fee, tax, discount, and total.
3. Create a payment intent on the backend.
4. Redirect or open the provider payment flow.
5. Confirm payment using a signed webhook, never only a client callback.
6. Move the order or booking to `paid`.
7. Create payout ledger entries only after completion rules are satisfied.

## Cancellation rules

- Before merchant/provider acceptance: full refund, subject to payment-provider timing.
- After merchant/provider acceptance: show the applicable cancellation fee before confirmation.
- Provider late cancellation: record a reliability event and notify operations.
- Customer dispute: hold payout until reviewed.

## Notifications

Events should be emitted for:

- OTP requested and verified.
- Order or booking created.
- Payment success or failure.
- Merchant/provider acceptance.
- Rider assignment.
- Pickup, arrival, completion, cancellation, refund, and payout.
- Support reply.

Channels: in-app, push, SMS, and email where configured.

## Review rules

- Customer can review after delivery or confirmed job completion.
- Merchant/provider can review the customer where policy permits.
- Reviews require moderation tools and abuse reporting.
- Rating averages must be calculated from stored reviews, not hardcoded marketing values.
