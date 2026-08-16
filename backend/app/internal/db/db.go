package db

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/tracing"
)

// DB owns the PostgreSQL connection pool. Keep a single instance per process.
type DB struct {
	pool *pgxpool.Pool
}

// New connects to PostgreSQL and verifies the connection with a ping. It is a
// hard error when the database is unreachable: callers must not proceed.
func New(ctx context.Context, url string) (*DB, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("pgxpool.ParseConfig: %w", err)
	}
	// Attach the OTel tracer unconditionally: it resolves the global
	// TracerProvider lazily, so queries produce no spans (and no export
	// machinery runs) until InitTracing / otel.SetTracerProvider has run.
	cfg.ConnConfig.Tracer = tracing.PgxTracer()
	p, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("pgxpool.New: %w", err)
	}
	if err := p.Ping(ctx); err != nil {
		p.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return &DB{pool: p}, nil
}

// Ping checks liveness against the configured database. Used by /readyz.
func (d *DB) Ping(ctx context.Context) error {
	if d == nil || d.pool == nil {
		return fmt.Errorf("database not configured")
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	return d.pool.Ping(ctx)
}

func (d *DB) Pool() *pgxpool.Pool { return d.pool }

func (d *DB) Close() {
	if d != nil && d.pool != nil {
		d.pool.Close()
	}
}
