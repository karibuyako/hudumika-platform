# Consumer Mobile (Team 1)

Consumer mobile app — home feed, ordering, dine-in, group buy, membership, wallet & coupons, chat, reviews.

The app lives in [`app/`](app/README.md) — Expo SDK 57, mirrored from the rider-mobile house pattern
(repository interfaces, factories, seeded mock state, contract tests). It is buildable and testable
today against mocks; the live API is a one-file factory flip per surface.

## Build & verify

```bash
cd app
npm ci
npm run typecheck && npm run lint && npm test   # CI gate (consumer.yml)
npm start                                        # dev server, mocks ON
```

## Deliverables (built)

1. Auth: OTP login (mock, debug-code demo) + session persistence (SecureStore)
2. Home feed (`GET /home`) with location-based merchants/providers + city picker
3. Ordering flow: browse → catalogue → cart (per-merchant groups) → checkout → payment intent → order → tracking (incl. rider tips)
4. Wallet & coupons (claim/wallet/checkout row) + wallet withdrawals + invoices/receipts (list/detail/download)
5. Membership + chat (v2), support tickets, reviews (eligibility-gated), favorites, notifications
6. Super-app verticals: hotels (search/detail/book), travel (intercity bus/ferry/flight), entertainment events + tickets
7. AI assistant + voice/image search
8. Rewards: referral + birthday rewards; live deals zone

Super-app surfaces (dine-in, group-buy, reservations, vouchers, red packets) ship as repositories + contract tests;
screens follow ROADMAP P6b–P6e. Intercity/warehouse tracking fixtures + tracking-phases/route/waybill
rendering land with P8.

See `docs/ROADMAP.md` for the full sequence and `app/README.md` for run/test/mock-switch details.