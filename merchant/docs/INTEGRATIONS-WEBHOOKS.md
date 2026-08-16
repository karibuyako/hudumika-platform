# HUDumika Merchant — Integrations and Webhooks

Integration registry (POS/ERP/accounting/payroll/delivery partners/mini-programs) and outbound webhook subscriptions with delivery health. Backend M9b. The connector layer is phased — the registry and webhooks are contract-live; partner sync connectors are not built yet.

## Integration registry (`/integrations`)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/integrations` | Connected integrations and status | `IntegrationInfo[]` |
| POST | `/integrations/{integrationId}/disconnect` | Disconnect with `reason` ≤500 | 204 |

`IntegrationInfo`: `id`, `provider`, `label`, `status`, `lastSyncedAt`, `scopes[]`.

| Field | Values |
| --- | --- |
| `provider` | `pos` / `erp` / `accounting` / `payroll` / `delivery_partner` / `mini_program` |
| `status` | `connected` / `disconnected` / `error` |
| `scopes` | permission strings the integration holds (server-served, never client-defined) |

- Disconnect flow: confirm dialog with reason (required) → 204 → row flips to `disconnected`; owner gets the `integration.disconnected` in-app notification.
- Errors: `INTEGRATION_NOT_FOUND`, `INTEGRATION_DISCONNECTED`, `INTEGRATION_ALREADY_CONNECTED` (connect path), `INTEGRATION_SCOPE_INVALID`.
- Registry screen states: loading skeleton → empty ("No integrations connected") → error + retry → cards with status pills and `lastSyncedAt`; `error` status shows a "sync failing — review" banner with support-ticket CTA.

### Connector model (honest staging, M9b phased)

- The registry is contract-live today, but the sync connectors behind `pos`/`erp`/`accounting`/`payroll` are phased with M9b — a connected row means the integration is registered and credentialed, not that live sync flows yet.
- Inventory sync `masterSource: pos|erp` (INVENTORY-SUPPLY-CHAIN.md) activates only when the matching connector ships; until then the sync screen renders `INVENTORY_SYNC_DISABLED` semantics and no fake sync data.
- UI rules: the integrations screen renders statuses and scopes exactly as the API returns them; no row claims a capability the connector does not have.

## Outbound webhooks (`/webhooks`)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/webhooks` | Subscriptions list | `WebhookSubscription[]` |
| POST | `/webhooks` | Create (`url`, `events` required) | `WebhookSubscription` / 201 |
| PATCH | `/webhooks/{webhookId}` | Update subscription | `WebhookSubscription` |
| DELETE | `/webhooks/{webhookId}` | Delete subscription | 204 |
| GET | `/webhooks/deliveries` | Delivery attempts and failures | `WebhookDelivery[]` |

`WebhookSubscription`: `url`, `events[]` (e.g. `order.created`), `secret` (write-only, set once, never returned), `status` (`active` / `disabled` / `failing`), `lastDeliveryAt`, `createdAt`.

`WebhookDelivery`: `webhookId`, `event`, `status` (`success` / `failed` / `retrying`), `attempts`, `statusCode`, `nextRetryAt`, `deliveredAt`.

### Delivery behavior

- Retries use exponential backoff, maximum 8 attempts per event; a subscription flips to `failing` after 5 consecutive errors (data-model rule).
- `retrying` rows show `attempts` and `nextRetryAt`; `failed` rows show `statusCode` and surface the `webhook.delivery_failed` in-app alert to the merchant owner.
- Deliveries screen (filterable by `webhookId`): loading skeleton → empty ("No deliveries yet") → error + retry → attempts list with status pills; a failing subscription shows a banner with "re-enable" (PATCH) or "test" actions.
- Errors: `WEBHOOK_URL_INVALID`, `WEBHOOK_EVENT_INVALID`, `WEBHOOK_SECRET_MISSING`, `WEBHOOK_DELIVERY_FAILED`; URL and secret are never hardcoded — values come from the form and the API only.

### Admin health view (staff)

- `GET /admin/webhooks?failingOnly=` lists delivery health across merchants (staff only, 403 otherwise). Operations uses it to chase chronic `failing` subscriptions; merchants never see other merchants' webhooks.

## Desktop / web access

- Browser cloud access to the merchant dashboard already exists (web surface, README.md); a native desktop app is planned, not built — nothing in the webhook or integration UIs assumes a desktop runtime.

## Screen states and rules

- All list/editor screens: loading skeleton → empty → error + retry → success; mutations are optimistic with server rollback (409/422).
- Secrets handling: `secret` is write-only — the editor shows a "set once on create" field and never a value; no client stores or logs it.
- MSW parity: integration provider/status enums, disconnect 204s, webhook subscription shapes, delivery statuses/attempts/backoff timings, and all error codes above must match the contract.
