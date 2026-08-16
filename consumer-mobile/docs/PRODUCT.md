# Customer Mobile App Specification

## Purpose

The customer application is mobile-only. It supports two transaction types: ordering products and booking services.

## Primary navigation

- Home
- Explore
- Orders
- Bookings
- Saved
- Account

## Home

- Current city and delivery address.
- Search across restaurants, shops, and service providers.
- Service groups: Food, Groceries, Pharmacy, Home Services, Beauty, Laundry, Repairs, Logistics, Rides, Events, Retail, Travel.
- Active order or booking status card.
- Personalised recommendations only after consent and sufficient history.

## Product order flow

1. Select city and address.
2. Choose a product category.
3. Filter by distance, rating, price, availability, delivery time, and verified status.
4. Open merchant profile.
5. Browse menu or catalogue.
6. Add products to cart.
7. Select substitutions or item notes where supported.
8. Select delivery address and instructions.
9. Select payment method.
10. Review item total, fees, taxes, discounts, and final amount.
11. Confirm payment.
12. Track merchant preparation and rider delivery.
13. Confirm delivery, report issue, and review.

## Service booking flow

1. Choose a service category.
2. Select a service type, such as plumbing or electrical.
3. Enter the problem description and upload optional photos.
4. Select address and preferred time.
5. Browse provider profiles, qualifications, ratings, price range, and availability.
6. Select provider or request the next available provider.
7. Review booking terms, estimated price, service fee, and cancellation policy.
8. Authorise payment.
9. Receive provider confirmation.
10. Chat or call through masked contact details.
11. Track provider arrival status.
12. Confirm job completion.
13. Release payment, review provider, or open a dispute.

## Customer account

- Profile and verified phone/email.
- Saved addresses and landmarks.
- Payment methods.
- Orders and bookings.
- Refunds and wallet balance.
- Favourite merchants and providers.
- Coupons and memberships.
- Notification preferences.
- Privacy, data export, and account deletion.

## Customer error and empty states

- No service available in selected city.
- No providers available for requested time.
- Merchant closed.
- Payment failed.
- Address outside service area.
- No orders or bookings yet.
- Provider cancelled.
- Network unavailable with retry.

## Customer acceptance criteria

- A customer cannot pay without a valid address and total.
- A customer can distinguish an order from a booking at every step.
- Every status change is visible in history.
- A customer can request support from a specific order or booking.
- Sensitive payment and identity data never appears in logs or analytics events.
