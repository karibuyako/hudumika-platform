# HUDumika Reviews and Moderation

## Rules (from SHARED-FLOWS.md)

- A customer can review only after delivery or confirmed job completion.
- Merchants/providers may review customers where policy permits.
- One review per author per target per order/booking (unique constraint).
- Rating averages are computed from published reviews — never hardcoded marketing values.
- Reviews require moderation tools and abuse reporting.

## Lifecycle

```text
created (pending) -> published -> [reported -> resolved]
                        \-> hidden (moderated) -> deleted
```

1. Review is created with `state=pending`.
2. If it passes automated checks (length, profanity filter, no PII patterns), it is published immediately; otherwise queued for moderation.
3. Anyone can report a published review; report opens a moderation case.
4. Compliance reviewer decides: keep (dismiss report), hide, or delete. All decisions are audited and reason is required.

## Rating calculation

- `rating = AVG(rating) OVER published reviews` per target (merchant/provider/rider/customer).
- Only `published` state counts; hidden/deleted never affect averages.
- Recalculated on publish/hide/delete; stored on the target row for fast reads.

## Moderation thresholds

- Review contains phone number, email, or payment references → auto-queue.
- 3+ reports on one review → auto-hide pending review.
- 2 hidden reviews by one author in 30 days → author reviews go to moderation queue.

## Admin surface

- Queue view: pending reviews, open reports, recent moderation decisions (from `/admin/reviews/moderate`).
- Moderation actions: `publish`, `hide`, `delete` — each requires a reason and creates an audit log entry.
- Only compliance reviewer and above may delete; hide is available to ops roles.

## Abuse handling

- Reported abuse on merchant/provider/rider profiles routes to the support ticket flow with context attached.
- Rating manipulation (review bombing patterns) is flagged by queries on author velocity (e.g. > 5 reviews in 1 hour).
