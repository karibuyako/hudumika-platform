.PHONY: gen build test vet test-integration run docker migrate migrate-down

# Regenerate Go types + server interface from the contract (Team 6 owns changes)
gen:
	oapi-codegen -generate types,chi-server,spec -package gen -o internal/gen/openapi.gen.go ../../backend/API-CONTRACT.yaml

build:
	go build ./...

test:
	go test ./...

vet:
	go vet ./...

# Integration tests run against real PostgreSQL/Redis (docker compose).
# They are excluded from `go test ./...` via the integration build tag.
# -p 1 keeps packages serial: they share the dev database and truncate in
# setup, so parallel package execution would race.
test-integration:
	go test -p 1 -tags integration ./...

run:
	go run ./cmd/api

docker:
	docker compose up --build

# Deploy-step migrations: run before rollout, never at app boot.
# Requires DATABASE_URL.
migrate:
	go run ./cmd/migrate -up

migrate-down:
	go run ./cmd/migrate -down
