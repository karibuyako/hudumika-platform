# Hudumika Admin Platform — Deployment Runbook

## Overview

This runbook covers deployment, configuration, and operational procedures for the Hudumika admin platform's enterprise security features.

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgres://user:pass@host:5432/hudumika` |
| `JWT_SECRET` | Secret key for JWT signing (min 32 bytes) | `openssl rand -base64 48` |
| `REDIS_URL` | Redis connection string (optional for dev) | `redis://:pass@host:6379` |
| `ADMIN_ALLOWED_IPS` | Comma-separated allowed IPs (empty = allow all) | `10.0.0.0/8,172.16.0.0/12` |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `ENV` | `development` | Environment: `development`, `staging`, `production` |
| `OTP_DEV_CODE` | `123456` | Dev OTP code (disabled in production) |
| `CORS_ORIGINS` | `*` | Allowed CORS origins |
| `ACCESS_TTL` | `15m` | JWT access token TTL |
| `REFRESH_TTL` | `720h` | JWT refresh token TTL |

## Security Configuration

### Rate Limiting

The admin API enforces per-IP rate limits:
- **Default**: 100 requests/minute per IP
- **Auth endpoints** (`/auth/*`): 10 requests/minute per IP
- **Response**: HTTP 429 with `RATE_LIMITED` code and `Retry-After` header

To customize, modify the `routeLimits` map in `server.go`:
```go
routeLimits := map[string]rateLimit{
    "/auth":             {rate: 10, burst: 10},
    "/admin/bookings":   {rate: 200, burst: 200},
}
```

### IP Allowlisting

Restrict admin API access to specific IPs:
```bash
export ADMIN_ALLOWED_IPS="10.0.0.0/8,172.16.0.0/12,192.168.1.0/24"
```

- Empty value = allow all IPs
- Returns 403 `IP_NOT_ALLOWED` for unauthorized IPs
- Applied before rate limiting

### Login Throttling

Protects OTP verification from brute-force:
- **Max attempts**: 10 failed OTPs per IP
- **Lockout duration**: 15 minutes
- **Response**: HTTP 429 with `LOGIN_THROTTLED` code

### Two-Person Approval

Dangerous operations require approval from a second admin:
- Refunds above TZS 5,000,000
- Admin suspension
- Payroll execution
- Payout reconciliation
- Settings changes
- Gateway configuration

The threshold is configurable in `platform_settings` table.

### Session Management

- Sessions are tracked in `admin_sessions` table
- Each session records IP, user agent, and creation time
- Admins can view and revoke sessions via:
  - `GET /admin/sessions` — list active sessions
  - `DELETE /admin/sessions/{id}` — revoke a session
  - `POST /admin/sessions/revoke-all` — revoke all sessions

### Security Headers

All responses include:
```
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Content-Security-Policy: default-src 'self'; ...
```

## Database Migrations

### Running Migrations

```bash
# Install goose
go install github.com/pressly/goose/v3/cmd/goose@latest

# Run migrations
goose -dir migrations postgres "$DATABASE_URL" up

# Check status
goose -dir migrations postgres "$DATABASE_URL" status

# Rollback (if needed)
goose -dir migrations postgres "$DATABASE_URL" down 1
```

### Migration Summary

| Migration | Tables | Purpose |
|-----------|--------|---------|
| 00121 | `admin_users`, `admin_teams`, `admin_policies`, `admin_content`, `admin_scheduled_notifications`, `admin_payroll_batches` | Core admin tables |
| 00122 | `facility_entries`, `password_reset_tokens` + extensions | Handler support tables |
| 00123 | `live_locations`, `geofences`, `geofence_events` | Live map & geofencing |
| 00124 | `admin_sessions` | Session tracking |
| 00125 | `admin_audit_log` | Audit trail |
| 00126 | `deleted_at` columns | Soft delete |

## Monitoring

### Health Check

```bash
# Basic health (load balancer)
curl https://api.hudumika.app/healthz

# Detailed health (admin, no auth)
curl https://api.hudumika.app/admin/health
```

Response includes: database latency, Redis status, disk space, memory usage, degradation level.

### Degradation Levels

| Level | DB Latency | Behavior |
|-------|-----------|----------|
| `none` | < 100ms | Full operation |
| `slow` | 100-500ms | Warning logged |
| `degraded` | 500ms-2s | Non-critical features skipped |
| `critical` | > 2s | 503 on non-essential endpoints |

### Structured Logging

All requests are logged with structured fields:
```json
{
  "level": "info",
  "method": "POST",
  "path": "/admin/bookings/refund",
  "status": 200,
  "latencyMs": 45,
  "requestId": "abc-123",
  "adminId": "uuid",
  "ip": "1.2.3.4",
  "msg": "request"
}
```

### Audit Log

Query the audit trail:
```sql
-- Recent actions by an admin
SELECT * FROM admin_audit_log 
WHERE admin_id = 'uuid' 
ORDER BY created_at DESC LIMIT 50;

-- All refund actions
SELECT * FROM admin_audit_log 
WHERE action = 'booking.refund' 
AND created_at > now() - interval '7 days';

-- Changes to a specific entity
SELECT * FROM admin_audit_log 
WHERE entity_type = 'admin_user' 
AND entity_id = 'uuid';
```

## Operational Procedures

### Emergency: Revoke All Sessions

```sql
UPDATE admin_sessions SET active = false WHERE active = true;
```

### Emergency: Block an IP

Set `ADMIN_ALLOWED_IPS` to exclude the IP and restart.

### Emergency: Disable Rate Limiting

Not recommended, but if needed: set all rates to `999999` in `routeLimits`.

### Emergency: Force Password Reset

```sql
-- Invalidate all password reset tokens
DELETE FROM password_reset_tokens WHERE used = false;

-- Force all admins to re-authenticate
UPDATE admin_sessions SET active = false WHERE active = true;
```

### Viewing Active Sessions

```sql
SELECT s.id, s.user_id, s.ip_address, s.user_agent, s.created_at
FROM admin_sessions s
WHERE s.active = true
ORDER BY s.created_at DESC;
```

### Configuring ABAC Policies

```sql
-- Deny refunds above TZS 10M for finance role
INSERT INTO admin_policies (type, resource, action, effect, created_by)
VALUES ('deny', 'bookings', 'refund', 'deny', 'admin-uuid');

-- Allow compliance team to view audit logs
INSERT INTO admin_policies (type, resource, action, effect, created_by)
VALUES ('allow', 'audit_log', 'read', 'allow', 'admin-uuid');
```

### Geofence Management

```sql
-- Create a hub zone
INSERT INTO geofences (name, type, boundary)
VALUES ('Dar es Salaam Hub', 'hub_zone', 
  '{"type": "Polygon", "coordinates": [[[39.2, -6.8], [39.3, -6.8], [39.3, -6.7], [39.2, -6.7], [39.2, -6.8]]]}');

-- View recent geofence events
SELECT e.*, g.name 
FROM geofence_events e 
JOIN geofences g ON g.id = e.geofence_id 
ORDER BY e.created_at DESC LIMIT 100;
```

## Troubleshooting

### Rate Limiting Too Aggressive

If legitimate requests are being rate-limited:
1. Check the client IP (may be behind NAT)
2. Increase rate limits in `routeLimits`
3. Use `X-Forwarded-For` header for accurate IP detection

### Login Throttling False Positives

If users are locked out unexpectedly:
```go
// Reset a specific IP
loginThrottler.Reset("1.2.3.4")
```

### Audit Log Growing Too Large

```sql
-- Archive old entries
CREATE TABLE admin_audit_log_archive AS 
SELECT * FROM admin_audit_log 
WHERE created_at < now() - interval '90 days';

DELETE FROM admin_audit_log 
WHERE created_at < now() - interval '90 days';

-- Add partitioning for large tables (recommended for > 1M rows)
```

### WebSocket Connection Issues

1. Check that the reverse proxy supports WebSocket upgrade
2. Verify `Upgrade` and `Connection` headers are forwarded
3. Check the `Content-Security-Policy` includes `ws:` in `connect-src`

## Performance Tuning

### Database Connection Pool

Configure `pgx` pool settings in production:
```go
config.MaxConns = 25
config.MinConns = 5
config.MaxConnLifetime = 30 * time.Minute
config.MaxConnIdleTime = 5 * time.Minute
```

### Redis Connection Pool

For high-traffic deployments:
```go
redisOptions.PoolSize = 20
redisOptions.MinIdleConns = 5
```

### Idempotency Store

The in-memory idempotency store cleans up every 10 minutes with a 24-hour TTL. For distributed deployments, consider Redis-backed idempotency.

## Backup Procedures

### Database Backup

```bash
# Full backup
pg_dump -Fc "$DATABASE_URL" > backup_$(date +%Y%m%d_%H%M%S).dump

# Schema only
pg_dump --schema-only "$DATABASE_URL" > schema_$(date +%Y%m%d).sql
```

### Audit Log Backup

```bash
# Export audit log to CSV
psql "$DATABASE_URL" -c "\COPY admin_audit_log TO 'audit_export.csv' CSV HEADER"
```

## Rollback Procedures

### Code Rollback

1. Deploy previous version
2. No database rollback needed (migrations are additive)

### Database Rollback

```bash
# Rollback last migration
goose -dir migrations postgres "$DATABASE_URL" down 1

# Rollback to specific version
goose -dir migrations postgres "$DATABASE_URL" down-to 00122
```

**Warning**: Soft-delete columns (00126) should not be rolled back while data exists.
