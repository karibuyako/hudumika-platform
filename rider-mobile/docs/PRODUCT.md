# Rider Mobile App Specification

## Purpose

The rider app is mobile-only. It handles delivery jobs for products and eligible parcels. It does not manage home-service jobs; those are completed by providers.

## Rider onboarding

1. Submit phone, identity, city, vehicle, availability, and emergency contact.
2. Upload required documents.
3. Complete safety training and knowledge checks.
4. Operations approves the rider.
5. Rider receives equipment and payout setup instructions.

## Rider modes

- Dedicated: assigned area, scheduled shifts, stable delivery volume.
- Flex: rider chooses when to go online and accepts available jobs.

## Delivery flow

1. Rider goes online.
2. Dispatch sends an eligible job based on location, capacity, vehicle, and service rules.
3. Rider accepts or rejects within the configured time.
4. Rider navigates to merchant pickup.
5. Rider confirms pickup with merchant code or scan.
6. Rider navigates to customer.
7. Rider confirms delivery with PIN, signature, photo, or customer confirmation.
8. Job becomes completed and earnings enter the ledger.

## Rider app modules

- Online/offline status.
- Job offer and acceptance.
- Navigation handoff.
- Pickup and delivery verification.
- Earnings today, week, and month.
- Payout status.
- Schedule for dedicated riders.
- Safety centre and emergency contact.
- Support chat and incident report.
- Ratings and reliability metrics.

## Dispatch rules

- Never expose customer phone numbers directly.
- Do not assign a rider outside their service area without consent.
- Prevent duplicate assignment with server-side locking.
- Reassign after timeout, cancellation, or rider failure.
- Account for weather, vehicle type, order size, and delivery distance.

## Rider acceptance criteria

- Rider cannot receive jobs before approval.
- Every accepted job has a clear pickup and drop-off state.
- Earnings are calculated server-side.
- A rider can report unsafe conditions without losing the job automatically.
- Payout failures are visible and actionable.
