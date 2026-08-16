// Command migrate applies goose migrations as a deploy step. It must never be
// invoked from the API process: migrations run explicitly before rollout,
// never at app boot (docs: backend/DEPLOYMENT.md).
package main

import (
	"database/sql"
	"flag"
	"fmt"
	"log"
	"os"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/hudumika/api-backend/migrations"
)

func main() {
	up := flag.Bool("up", false, "apply all pending migrations (deploy step)")
	down := flag.Bool("down", false, "roll back one migration (never in production)")
	status := flag.Bool("status", false, "print migration status")
	flag.Parse()

	url := os.Getenv("DATABASE_URL")
	if url == "" {
		log.Fatal("DATABASE_URL is required")
	}

	// pgx stdlib driver registers as "pgx".
	pool, err := sql.Open("pgx", url)
	if err != nil {
		log.Fatalf("open database: %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(); err != nil {
		log.Fatalf("ping database: %v", err)
	}

	goose.SetBaseFS(migrations.FS)
	if err := goose.SetDialect("postgres"); err != nil {
		log.Fatalf("goose dialect: %v", err)
	}

	var action error
	switch {
	case *up:
		// WithAllowMissing lets a migration whose version number precedes
		// already-applied ones (e.g. 00031 landing after 00032-00035 in a
		// shared dev database) still be applied; goose refuses out-of-order
		// migrations by default.
		action = goose.Up(pool, ".", goose.WithAllowMissing())
	case *down:
		action = goose.Down(pool, ".")
	case *status:
		action = goose.Status(pool, ".")
	default:
		flag.Usage()
		os.Exit(2)
	}
	if action != nil {
		log.Fatalf("migrate: %v", action)
	}
	fmt.Println("migrations OK")
}
