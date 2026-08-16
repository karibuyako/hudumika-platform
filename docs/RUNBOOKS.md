# Hudumika Runbooks

Operational procedures promised in `backend/DEPLOYMENT.md` (runbooks must exist
before launch). Execute top to bottom; every runbook ends with verification and
a rollback path.

Legend: `[LIVE]` = works today, `[EXPECTED]` = lands with backend migrations
work (backend agent), `[PLANNED]` = build with this doc.

---

## 1. Deploy runbook

Shared release gates (all surfaces, every env):

1. Migrations reviewed and backward-compatible.
2. Contract check green against latest `backend/API-CONTRACT.yaml`.
3. Client apps on staging pass MSW-parity suites.
4. Audit + metrics dashboards green for 24 h on staging.
5. Release notes include client-compatibility notes.

### 1.1 API (backend)

Prerequisites:

- Tagged release image built by CI (build, `go vet`, unit + integration tests, contract check).
- Secret manager has all vars from `backend/DEPLOYMENT.md` config list.
- Migrations merged and reviewed (never run inside the app process).

Steps:

1. Back up the database (see runbook 2.1).
2. Run migrations as a separate step before rollout: `make migrate` (target lands with migration work `[EXPECTED]`).
3. Deploy the new image with a rolling update, gated on `/healthz` (process) and `/readyz` (db, redis) `[EXPECTED]` — container never receives traffic until ready.
4. Watch deploy metrics for 15 min (runbook 4).
5. Record deployed tag + time in the release log.

Verification:

- `curl https://api.hudumika.co.tz/api/v1/../healthz` returns `{"status":"ok"}`.
- Error rate < 1% and p99 < 1 s on the new revision; no 501 regression on exercised paths.
- Migration columns visible in `psql`; app logs free of migration errors.

Rollback:

- Redeploy the previous release image (immutable, tagged).
- If a forward migration is not backward-compatible, run the documented down-migration or restore from backup (runbook 2.3) — destructive schema changes must never have been shipped in a single release.

### 1.2 Web (public-web, admin-web)

Prerequisites:

- CI green (`vitest` → MSW parity → Playwright on staging for admin-web).
- Previous two build artifacts retained for rollback.

Steps:

1. Build `dist/` with per-env `VITE_*` values injected (`VITE_USE_MOCKS=false` for admin in staging/prod).
2. Deploy to the static host as an immutable, versioned artifact (tag + deploy date recorded).
3. Smoke: home + one portal route (public-web); login + MFA + one admin module (admin-web).

Verification:

- `curl -sI <origin>` → 200; CSP and `noindex` headers present on admin-web.
- Mocks never active: `VITE_USE_MOCKS` false and no MSW request in network tab.
- Env-specific config (API URL, feature flags) correct per environment.

Rollback:

- Republish the previous tagged build artifact; no rebuild needed for config-only changes.

### 1.3 Mobile (merchant, rider — Expo EAS)

Prerequisites:

- `eas.json` profiles exist (development / preview / production).
- EAS credentials for the project; `eas whoami` authenticated.

Steps:

1. Local: `npm run typecheck && npm test && npm run lint`.
2. Dev build: `eas build --profile development --platform all` (dev client, channel `development`).
3. Staging: `eas build --profile preview` → `eas submit` (TestFlight internal / Play internal), channel `preview`.
4. QA pass on staging channel, then promote to production:
   `eas build --profile production` (channel `production`) → `eas submit` to stores.
5. Non-native fixes after a store binary ships: `eas update --channel <channel>` (JS/asset only).

Verification:

- Channel → profile mapping: `eas channel:view`; update/binary shows correct channel.
- `EXPO_PUBLIC_ENV` matches profile; mocks disabled in preview/production (rider sets `EXPO_PUBLIC_MOCK_*` false).
- Store release gates: contract tests green vs staging, E2E happy path green on release build.

Rollback:

- OTA regression: `eas update --channel <previous>` repoints channel to last known-good update.
- Native regression: rebuild + resubmit previous version; disable the broken build (remove from sale / pause release).

---

## 2. Backup & restore runbook

### 2.1 Postgres backup (schedule)

Prerequisites: `pg_dump` on the backup host, object storage (S3) bucket with
credentials from the secret manager, cron/database host reachable.

Steps:

1. Daily (02:00 EAT) logical dump, per DB: `pg_dump -h <host> -U hudumika -Fc hudumika -f hudumika-$(date +%F).dump`.
2. Upload to S3: `aws s3 cp hudumika-*.dump s3://<bucket>/postgres/` (server-side encrypted).
3. Retention: 14 daily, 8 weekly, 6 monthly; expiry policy on the bucket.
4. Encrypt credentials to the dump (dump contains PII: phones, addresses).

Verification:

- `aws s3 ls s3://<bucket>/postgres/ | tail` shows today's dump with non-zero size.
- Monthly restore drill (2.3) validates dumps are usable.

Rollback:

- On failed backup: alert (runbook 4 alert rules), retry once, escalate to on-call; never ship the day without a dump attempt.

### 2.2 Redis persistence note

- Redis (`redis:7-alpine` in compose) holds OTP codes, rate limits, sessions, and queue state.
- Persistence: RDB snapshots + AOF configured on the production instance; `SAVE ""` is never set in prod.
- Redis is **rebuilt state**: after a full Redis loss, expect forced re-login and OTP re-request; outbox/queue replay comes from Postgres.
- Back up RDB via replication or `redis-cli BGSAVE` + copy `dump.rdb` if a PITR copy is needed (lower priority than Postgres).

Verification: `redis-cli INFO persistence` → `rdb_last_bgsave_status:ok`; `INFO keyspace` sanity per env.

### 2.3 Restore drill

Prerequisites: clean target DB or throwaway instance, access to the S3 bucket.

Steps:

1. `aws s3 cp s3://<bucket>/postgres/hudumika-<date>.dump .`
2. Restore into a scratch DB: `createdb hudumika_restore && pg_restore -d hudumika_restore hudumika-<date>.dump`.
3. Run `psql -d hudumika_restore -c "select count(*) from users"` (or first table present) and compare to source counts.
4. For a live restore: drain traffic from the API, restore into the primary DB, restart API.

Verification: row counts match, API `/healthz` + `/readyz` `[EXPECTED]` green, login works with a restored user.

Rollback (of the drill): drop `hudumika_restore`; a live restore is only rolled back by restoring the pre-restore dump (never run a restore without a fresh dump in hand).

---

## 3. Incident runbook

### 3.1 Severity matrix

| Sev | Definition | Examples | Response time | Page |
| --- | --- | --- | --- | --- |
| SEV1 | Total outage, money/payout risk, data loss | API down, payment webhook backlog, dispatch queue stuck | 15 min | On-call + engineering lead + finance (if money) |
| SEV2 | Major degradation, no money impact | p99 > 1 s, error rate > 1%, readyz flapping | 30 min | On-call |
| SEV3 | Minor degradation or bug | Single OTP gateway latency, one city slow | 4 h | On-call (business hours) |
| SEV4 | Watch only | Queue depth spike that auto-recovers | next day | Slack channel |

### 3.2 On-call flow

1. Page fires (runbook 4 alert rules) or a report comes in → acknowledge within response time.
2. Declare: assign severity, announce in `#incidents` with a thread link.
3. Assess: check runbook 4 checklist (health endpoints, error rate, p99, queue depth, logs by `request_id`).
4. Mitigate: fastest safe action — rollback (runbook 1), switch SMS provider (config), drain/replay queue, enable read replica for list endpoints.
5. Communicate status (3.3) every 30 min for SEV1, 2 h for SEV2.
6. Resolve: verify recovery, close the incident, schedule postmortem (SEV1/2 within 3 working days).

### 3.3 Communication

| Audience | Channel | Content |
| --- | --- | --- |
| Internal team | Slack `#incidents` | Severity, affected surface, ETA, actions taken |
| Finance (money incidents) | Phone | Payment webhook / payout batch exceptions, replay plan |
| Customers | In-app notice only when > 15 min impact | What is down, when to expect fix — no internal detail |
| Merchants / riders | In-app + merchant portal banner | Order/dispatch delays, payout timing |
| Public web | Status page (planned) | Uptime + current incident banner |

Post-incident: a short `#incidents` summary (what, why, fix, prevention) before the postmortem.

### 3.4 Postmortem template

```
# Incident <ID> — <date>

Severity / Duration / Impact (RPO/RTO, affected users, money affected)

Timeline (UTC): detection → page → mitigation → resolution (with request_id or log links)

Root cause (5 whys)

Contributing factors

Actions:
- [ ] Fix 1 (owner, due)
- [ ] Prevention (alert, test, runbook update)

Verification: how each action is proven effective
```

---

## 4. Health & alerting runbook

### 4.1 Endpoints to check

| Endpoint | Meaning | Failure action |
| --- | --- | --- |
| `/healthz` | Process alive | Restart the container; check OOM, panic logs |
| `/readyz` `[EXPECTED]` | DB + Redis reachable | Check `DATABASE_URL`/`REDIS_URL`, connection pool saturation; alert when 503 for 2 min |
| `/metrics` `[PLANNED]` | Prometheus scrape target | Scraper config, target down alert |

### 4.2 Key metrics

| Metric | Warning | Critical | Note |
| --- | --- | --- | --- |
| p99 latency | > 1 s for 5 min | > 2 s for 5 min | From `http_request_duration_seconds` histogram |
| Error rate (5xx + contract error codes) | > 1% for 5 min | > 5% for 5 min | Excludes 404; split by endpoint |
| Dispatch queue depth | > 100 | > 500 | Rider pool verification + drain/re-enqueue |
| readyz 503 | 1 min | 2 min | Db/redis down or saturated |
| Payment webhook failures | any unprocessed > 5 min | backlog > 50 | Replay outbox, alert finance |
| Payout batch exceptions | 1 batch | 2 batches | Finance review workflow, manual settlement |

### 4.3 Response playbook (backend/DEPLOYMENT.md runbook topics)

1. Payment webhook down → queue backlog → replay outbox → alert finance.
2. Dispatch queue stuck → drain, re-enqueue, verify rider pools.
3. DB connection saturation → read replica for list endpoints; inspect pool + long queries.
4. OTP gateway outage → switch SMS provider via config, verify request/verify rates.
5. Payout batch exception → finance review workflow, manual settlement (never auto-retry money).

Verification of recovery: alert clears for 5 min, error rate back under 1%, p99 under 1 s, queue drains.

Rollback: incident mitigations always prefer reversible actions (config flip, traffic shift) over irreversible ones (schema change, data rewrite).

---

## 5. Environment provisioning runbook

### 5.1 dev

Prerequisites: Docker, Go toolchain, Node 20+, Expo CLI, repo clone.

Steps:

1. `docker compose up` in `backend/app` (api + postgres 16 + redis 7, healthchecks included).
2. Migrations via `make migrate` `[EXPECTED]` (until then, scaffold runs in-memory).
3. Clients: `npm install`, `npm run mock:gateway` (merchant, port from `MOCK_PORT` default 3001) or `npx expo start` with MSW.
4. Public/admin web: `npm run dev` with `VITE_*` defaults; mocks on.

Verification: `/healthz` 200; OTP dev code `123456` works; client contract tests green.

Rollback: `docker compose down` and reset volumes — dev data is disposable.

### 5.2 staging

Prerequisites: staging host/VM, secret manager entries, DNS `staging-api.hudumika.co.tz`.

Steps:

1. Provision host; install docker + compose; pull release image.
2. Create `docker-compose.prod.yml` with `ENV=staging`, real secrets from the secret manager, `CORS_ORIGINS` = staging web origins.
3. `make migrate` on the staging DB, then deploy API with rolling update (runbook 1.1).
4. Deploy web artifacts with `VITE_*` staging values; submit mobile `preview` builds (runbook 1.3).
5. Seed representative data (cities, merchants, riders) for E2E and MSW parity suites.

Verification: contract test suites green against `https://staging-api.hudumika.co.tz/api/v1`; E2E happy paths pass; dashboards green 24 h before promotion.

Rollback: redeploy previous image/build; staging DB resets are allowed with team sign-off.

### 5.3 production

Prerequisites: staging green for 24 h, launch checklist signed (`docs/ROADMAP.md`), finance/provider credentials certified.

Steps:

1. DNS + TLS in place (`api.hudumika.co.tz`, see 5.4); edge (CDN/WAF) configured.
2. Provision prod Postgres 16 + Redis 7 with backups enabled (runbook 2).
3. Create `docker-compose.prod.yml` with `ENV=production` and prod secrets; `ADMIN_ALLOWED_IPS` locked.
4. `make migrate`, then rolling deploy; mobile: `production` profile builds → store submission.
5. Announce go-live; monitor first hour (runbook 4).

Verification: `/healthz` 200; real OTP SMS delivered; payment sandbox cert done; all launch definition items green.

Rollback: redeploy previous image/build; if migration breaks, restore dump (runbook 2.3) — prod rollback is rehearsed in the restore drill.

### 5.4 DNS notes

| Hostname | Purpose | Notes |
| --- | --- | --- |
| `api.hudumika.co.tz` | Public API (prod) | From `backend/API-CONTRACT.yaml` servers; TLS enforced, path prefix `/api/v1` |
| `staging-api.hudumika.co.tz` | Staging API | Same contract base path |
| `ops.hudumika.co.tz` | Admin web (prod) | Never linked from public surfaces; IP allow-list + staff MFA |
| `staging-ops.hudumika.co.tz` | Admin web staging | Same protection as prod |
| `dev-api.hudumika.co.tz` | Dev API (optional) | Local-first; only if a shared dev box is needed |

Admin API surface (`/admin/*`) is reachable only via the protected ops hostname or network policy — never exposed on the public API hostname (`backend/DEPLOYMENT.md`).

---

## Drill status

Rehearsed 2026-08-14 (local PostgreSQL 16 + Redis 7 on localhost, no docker;
scripts in `backend/app/scripts/`). Marked rehearsed: sections 2.1–2.3 and 4.

### Backup drill (runbook 2.1, 2.2) — PASSED 2026-08-14 12:37 EAT

```
DATABASE_URL=postgres://hudumika:hudumika@localhost:5432/hudumika \
REDIS_URL=redis://localhost:6379/0 \
backend/app/scripts/backup.sh
```

Output (verbatim):

```
backup.sh: pg_dump -Fc -> ./backups/hudumika-20260814-123704.dump
backup.sh: PostgreSQL dump OK: ./backups/hudumika-20260814-123704.dump (15059 bytes)
backup.sh: redis SAVE enabled (3600 1 300 100 60 10000) — triggering SAVE
backup.sh: WARN redis SAVE ran but RDB copy failed (permissions on /var/lib/redis/dump.rdb?) — Postgres backup unaffected
backup.sh: done — backup file: ./backups/hudumika-20260814-123704.dump (15059 bytes)
```

Notes:

- `pg_dump -Fc` backup written and verified non-zero (15,059 bytes). Backup
  command matches runbook 2.1 step 1 (dump + S3 upload + retention remain the
  production steps; local drill covers dump generation and exit behavior).
- Redis `SAVE` succeeded (server-side snapshot, `rdb_last_save` updated) but the
  RDB copy step could not read `/var/lib/redis/dump.rdb` (root-owned on this
  host) — the script warns and does not fail the Postgres backup, exactly as
  designed for best-effort Redis snapshots. For local backups on this host,
  run the copy with a user that can read `/var/lib/redis` or set a writable
  `dir`/`dbfilename` (see runbook 2.2 note: RDB backup is lower priority than
  Postgres).

### Restore drill (runbook 2.3) — PASSED 2026-08-14 12:39 EAT

```
PGPASSWORD=postgres createdb -h localhost -U postgres -O hudumika hudumika_restore_test
DATABASE_URL=postgres://hudumika:hudumika@localhost:5432/hudumika_restore_test \
BACKUP_FILE=./backups/hudumika-20260814-123704.dump backend/app/scripts/restore.sh
PGPASSWORD=postgres dropdb -h localhost -U postgres hudumika_restore_test
```

Output (verbatim):

```
restore.sh: pg_restore --clean --if-exists -d <target> ./backups/hudumika-20260814-123704.dump
restore.sh: restore OK — smoke SELECT count(*) FROM users = 2
```

Notes:

- Restore into scratch DB `hudumika_restore_test`, smoke count `users = 2`
  matches the source DB (`hudumika` also had 2), then the scratch DB was
  dropped (runbook 2.3 rollback step).
- The local `hudumika` role has no `CREATEDB`, so the scratch DB was created
  (and later dropped) by the `postgres` superuser with `-O hudumika` ownership
  — an environment quirk, not a script gap. `restore.sh` itself refuses
  `ENV=production` and requires both `DATABASE_URL` and `BACKUP_FILE`.

### Health-check drill (runbook 4) — PASSED 2026-08-14 13:05 EAT

API built (`go build ./cmd/api`) and run locally on `PORT=8098` with
`ENV=development`; `backend/app/scripts/verify-release.sh` exercised gates
1–4 against it. Output (verbatim, exit 0):

```
GATE ok: ENV=development
GATE ok: production secret guards skipped (ENV=development)
GATE ok: healthz http://127.0.0.1:8098/healthz -> 200
GATE ok: readyz http://127.0.0.1:8098/readyz -> 200
GATE ok: /metrics exposes http_requests_total and http_request_duration_seconds
GATE ok: migration version >= 9 (current: 9)
SIGNED verify-release: ENV=development PORT=8098 healthz=200 readyz=200 metrics=ok migrate_version=9 by=Team 6 backend agent at 2026-08-14T10:05:49Z (scripts/verify-release.sh)
```

Notes:

- `/healthz`, `/readyz`, `/metrics` verified live (runbook 4.1 table).
- Migration status = 9 (runbook 1.1 deploy gate, `cmd/migrate -status`).
- Production-only gates (JWT ≥ 32 chars, no `CORS_ORIGINS=*`,
  `DATABASE_URL`/`REDIS_URL`/`OTP_PAYLOAD_KEY` set) are skipped in
  development mode by design; they must be re-run in a staging drill before
  launch.
