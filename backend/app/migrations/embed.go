// Package migrations embeds the SQL migration files so the migrate deploy
// step (cmd/migrate) can run goose without reading from disk at deploy time.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
