/* Flash-sale zone selector (Meituan 神抢手-lite).
 *
 * Contract reality: the contract DOES carry a FlashSale resource — model
 * FlashSale {itemIds, discountBps, quantityLimit, soldCount, startsAt, endsAt,
 * status: draft|scheduled|live|ended|cancelled} and endpoint
 * GET /marketing/flash-sales (listFlashSales) — and PromotionType includes a
 * `flash` value. But the consumer repo layer (src/repos — the read-only seam
 * screens must import from) exposes neither, so this zone is driven by the
 * only contract resource the app can read that carries a sale clock: live
 * group-buy deals (GroupBuyDeal.salesEndAt/status). Production should switch
 * this selector's input over to listFlashSales once a MarketingRepository
 * surfaces it. */
import { GroupBuyStatus } from '@hudumika/contract';
import type { GroupBuyDeal } from '@hudumika/contract';

/** Default "ends soon" window. The demo seed (src/repos/mock/mockState.ts,
 * READ-ONLY) runs its group-buy sales 21–30 days out, so a strict 72h window
 * would hide the section entirely; the default is widened to a window the
 * seed satisfies and callers may pass a tighter window (e.g. 72h) in
 * production where sale lengths are server-controlled. */
export const FLASH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Deals whose sale ends within `(now, now + withinMs]` and whose status is
 * live (GroupBuyStatus.live), soonest-ending first. Exactly-`now` is excluded
 * (the countdown is already null → "Ended"); exactly `now + withinMs` is kept
 * (inclusive upper bound). */
export function selectFlashDeals(
  deals: GroupBuyDeal[],
  now = Date.now(),
  withinMs = FLASH_WINDOW_MS,
): GroupBuyDeal[] {
  return deals
    .filter((d) => d.status === GroupBuyStatus.live)
    .filter((d) => {
      const end = Date.parse(d.salesEndAt);
      if (Number.isNaN(end)) return false;
      return end > now && end <= now + withinMs;
    })
    .sort((a, b) => Date.parse(a.salesEndAt) - Date.parse(b.salesEndAt));
}
