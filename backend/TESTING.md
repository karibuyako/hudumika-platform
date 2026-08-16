# HUDumika Backend Testing

## Pyramid

| Layer | What | Tooling |
| --- | --- | --- |
| Unit | domain rules, state machines, price math | `go test` + `testify` |
| Integration | handlers + PostgreSQL + Redis | `testcontainers-go` |
| Contract | HTTP surface vs OpenAPI spec | schemathesis / dapr-style request tests |
| E2E | full happy paths across services | docker compose + curl suite |

## Unit test targets (highest value)

- Order and booking state machines: every allowed and forbidden transition.
- Price computation: subtotal, fees, tax, discount, rounding (TZS minor units).
- Cancellation/refund rules before vs after acceptance.
- Dispatch scoring and acceptance timeouts.
- Ledger math: running balances, holds, statement opening/closing balances.
- OTP rate limiting and attempt caps.

## Integration tests

- One test container suite per bounded context (orders, payments, payouts, dispatch).
- Every test that mutates money asserts an audit log row was created.
- Webhook tests include signature verification with invalid-signature cases.
- Idempotency: replay the same request with the same key → same response, no double insert.

## Testing inventory (delivered)

- **Coverage pin**: `TestAllContractPathsReturnDefinedShape` (`internal/api/coverage_test.go`) walks the contract's 464 paths, exercises all 580 operations with a test token and fails on any blank 404, empty body (204 excepted) or non-JSON body. Unimplemented endpoints must answer the `501 NOT_IMPLEMENTED` envelope — explicit and counted, never a blank route. Only remaining 501 state: `GET /events` without Redis/PostgreSQL configured (dependency state).
- **25 integration suites** (`make test-integration`, real PostgreSQL + Redis) prove state survives restart and state machines stay single-winner under concurrency. (TODO: 82 files currently carry the `go:build integration` tag — reconcile the "25 suites" label with the per-file count.)
- **Unit patterns** (`make test`): `miniredis` + `httptest` keep the unit suite service-free — OTP/rate-limit/session/idempotency store logic, price math, state machines.
- **Concurrency single-winner pattern**: transitions use guarded `UPDATE ... WHERE status = <expected>` (0 rows → `409` conflict), partial-unique indexes and advisory locks; integration tests race two simultaneous accepts/clock-ins/voucher purchases and assert exactly one wins.
- **Loadsmoke harness**: `tools/loadsmoke` is a stdlib-only load harness firing a fixed mix (70% `/healthz`, 20% `/metrics`, 10% fresh-destination OTP) with a PASS/FAIL verdict against the MONITORING budgets (p99 < 1 s, error rate < 1%; 429s and 404s excluded from the error rate). Local run: **p99 97 ms, 0% errors at ~465 req/s** (per `app/README.md`; TODO: re-run and store the full output in RUNBOOKS).

## Contract tests (shared with all clients)

- MSW mocks in the client apps must match the OpenAPI spec (`backend/API-CONTRACT.yaml`):
  - Same paths, status codes, and payload shapes for the endpoints clients use.
  - A CI job validates generated client types against the spec on every backend PR.
- Run the same request suites against MSW (client CI) and staging (backend CI)
  so both sides agree on behavior before release.

## Testing checklist for every endpoint

1. Validation: missing fields, wrong types, out-of-range, unknown enum values → `VALIDATION_FAILED`.
2. Auth: no token, expired token, wrong role → `UNAUTHORIZED`/`FORBIDDEN`.
3. State: transition from an unexpected status → `CONFLICT`.
4. Idempotency: same key twice → same result.
5. Pagination: cursor end, empty result set.
6. Concurrency: two simultaneous accepts on one order → exactly one wins.
7. Error shape: every error includes `code`, `message`, `requestId`.

## CI gate

```text
go vet && go test ./...   ->   contract check   ->   build image
```

Secrets are never in the repo; CI reads them from the environment.
