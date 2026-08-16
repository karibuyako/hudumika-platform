# Customer App — Reviews

Rules from `SHARED-FLOWS.md` (review rules) and the contract (`ReviewCreate`, `Review`,
`/reviews`, `/reviews/{reviewId}/report`). Ratings shown in UI always come from API reviews —
never hardcoded marketing values.

## Eligibility

| Target | Requirement |
| --- | --- |
| Merchant | Order `delivered` or `completed` |
| Provider | Booking `completed` (customer confirmed via `completeBooking`) |
| Rider | Order `delivered`/`completed` (optional, policy-driven) |

- Backend enforces eligibility: `REVIEW_NOT_ELIGIBLE` (422) → hide the prompt and refetch.
- One review per target per completed transaction: `REVIEW_ALREADY_EXISTS` → show existing review
  with edit CTA if policy allows.
- Prompt timing: after success screen of order/booking, and via `review.received`-style in-app
  nudges; can be dismissed (saved in notification center).

## Rating UI

- `ReviewCreate` fields: `targetType` (`merchant` | `provider` | `rider`), `targetId`,
  `rating` (integer 1–5), `body` (≤2000 chars).
- Star input: 1–5, half-star not selectable at creation (integer only per schema); filled stars
  `accent` gold, count text next to it (DESIGN-SYSTEM rating component).
- Body: optional, with character counter (2000 max); suggestions list ("Pole sana — sorry about
  that" style is not required; keep neutral).
- Submit: `POST /reviews`; loading spinner on button; success → thank-you toast
  ("Asante kwa maoni yako").
- Error mapping: `REVIEW_NOT_ELIGIBLE` → hide form; `REVIEW_ALREADY_EXISTS` → show existing;
  `VALIDATION_FAILED` → inline field errors; network → retry (idempotent mutation key per
  submission; duplicate submit safe).

## Review display

- Review state (`Review` schema): `pending` → published / hidden / deleted (moderation).
- UI shows only `published` reviews in lists (merchant/provider profile, order/booking detail).
- Author's own review: show `pending` chip ("Under review") until `review.moderated` event updates
  it; `hidden`/`deleted` → explanatory copy, no re-prompt spam.
- Rating averages: computed from stored reviews server-side; app renders `rating` +
  `reviewCount` from `MerchantPublic`/`ProviderPublic` only.

## Reporting abuse

- Entry points: "Report" on any published review (merchant/provider/rider profile, review list).
- Action: `POST /reviews/{reviewId}/report` with `reason` (≤300 chars) → `ReviewReport`
  (`state: open`).
- UI: report sheet with reason presets + free text; success → "Reported — tumekumbuka"
  (we have received it); never reveals reporter identity.
- `REVIEW_NOT_REPORTABLE` (422) → toast + hide action; moderation happens in admin-web.
- Abuse report does not hide the review client-side (moderation state comes from `review.moderated`).

## Per-screen states

| Screen | Loading | Empty | Error | Retry | Success |
| --- | --- | --- | --- | --- | --- |
| Review form | Skeleton | — | Inline field errors / eligibility | Retry submit | Thank-you + dismiss |
| Review list (profile) | Skeletons | "No reviews yet" | Error card | Retry | Published reviews + own pending chip |
| Report sheet | Spinner on button | — | `REVIEW_NOT_REPORTABLE` | Retry | Confirmation toast |

## Acceptance checks

- Review UI is reachable only for eligible transactions (no manual bypass).
- No hardcoded ratings anywhere; averages always from API.
- Report and review flows never log reviewer identity or `body` content to analytics.

## Double-blind reviews (planned)

Reviews are published only after both parties submit, so neither sees the other's rating first — planned enhancement to reduce retaliation bias. Multi-dimensional ratings (professionalism, punctuality, quality, communication, price transparency, cleanliness, would-recommend) are live via `ReviewCreate.dimensions`.
