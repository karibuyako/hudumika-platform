# HUDumika Provider — Monetization & Business Model

How the service-provider platform earns, and how providers and customers are
charged. All values TZS; commission and fee structures are platform
configuration, not hardcoded.

## Revenue streams (platform)

| Stream | Model | Status |
| --- | --- | --- |
| Commission on jobs | Percentage of each completed job (per-category `commissionBps` from `ServiceCategoryConfig`) | LIVE (config) |
| Subscription plans | Monthly/yearly provider plans with feature tiers | PLANNED |
| Listing fees | Premium service listings (higher placement, portfolio boost) | PLANNED |
| Lead fees | Charge per job lead (per lead or per job) for providers in open categories | PLANNED |
| Advertising | Sponsored listings and display placements (reuses promotion engine) | PLANNED |
| Transaction fees | Fee on payments processed (beyond gateway cost) | PLANNED |
| Enterprise plans | Custom pricing for large provider businesses (contracts/SLA tier) | PLANNED |

## Provider pricing models

- **Freemium**: basic job tools free; quote, dispatch, inventory, analytics in paid tiers (planned).
- **Tiered pricing**: bronze/silver/gold/platinum provider tiers carry different features and commission rates (tier is LIVE on `TrustProfile`; tier benefits planned).
- **Pay-per-job**: per-completed-job fee where the category commission is low (config).
- **Subscription**: fixed monthly/yearly for business portals and dispatcher consoles (planned).

## Customer pricing models

| Model | How it works | Status |
| --- | --- | --- |
| Fixed price | Set price per service (`ProviderService.pricing.baseTZS`) | LIVE |
| Hourly rate | `perHourTZS` billed on tracked time (check-in/out) | LIVE |
| Quote-based | Estimate → on-site quote → approval → final | LIVE |
| Dynamic pricing | Distance, time-of-day, demand, urgency factors (surge config) | LIVE |
| Group buying | Discounts for group purchases of recurring plans | PLANNED |

## Provider earnings pipeline (from TRUST/ledger docs)

```
Gross job value
  → platform commission (category config)
  → payment processing
  → refunds / chargebacks
  → adjustments (penalties, bonuses)
  → provider earnings
  → pending → available → payout
```

Ledger entries: `booking_earning`, `delivery_fee`, `tip`, `bonus`, `commission`,
`adjustment`, `payout`, `refund` — plus planned `insurance_deduction`.

## Rules

- Commission rate is per-category (`ServiceCategoryConfig.commissionBps`), overridable per contract (B2B).
- Providers always see the commission breakdown on job settlement (commission visibility).
- Planned monetization is config-first: adding a revenue stream never changes the core contract.

## Commission withholding

Platform commission is withheld at settlement (gross job value minus commission, processing, and adjustments) — providers always see the withholding on the job statement.
