/* Catalogue helpers — shared by the merchant screen, the product route and
 * the services tab (pure functions over contract DTOs only).
 *
 * The contract has no find-item-by-id endpoint (GET /catalogues/{merchantId}
 * is the only item surface), so every item lookup is scoped to a merchant
 * plus an already-loaded catalogue — never a fabricated global id. */
import type { Catalogue, CatalogueItem } from '@hudumika/contract';

/** Locate a catalogue item within a merchant's loaded catalogue. Returns null
 * when the merchant or the item does not exist (callers render "not found"). */
export function findCatalogueItem(
  merchantId: string,
  itemId: string,
  catalogue: Catalogue | null | undefined,
): CatalogueItem | null {
  if (!catalogue || catalogue.merchantId !== merchantId) return null;
  return catalogue.items.find((i) => i.id === itemId) ?? null;
}

/** Service category → provider trade query (MASTER-BLUEPRINT §9). The
 * contract wires provider services behind /providers/me/* (no public
 * trade→category mapping), so the app derives a trade query from the
 * category name by stripping common English suffixes ('plumbing' → 'plumb',
 * which matches the seeded trade 'Plumber'; 'electrical' → 'electric' →
 * 'Electrician'). Deterministic and honest: a category whose stem matches no
 * provider trade simply resolves to an empty provider list. */
export function tradeStem(name: string): string {
  return name.toLowerCase().replace(/(ing|er|ian|al)$/, '');
}
