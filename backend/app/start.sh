#!/bin/sh
# Combined entrypoint: run the Go API on an internal port and nginx in front
# of it. nginx terminates the public $PORT, strips /api/v1 and /api prefixes,
# and proxies the rest (including bare routes and /ws) to the Go service.
set -e

GATEWAY_PORT="${PORT:-8080}"
GO_PORT="8081"
export GATEWAY_PORT GO_PORT

envsubst '${GATEWAY_PORT} ${GO_PORT}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

# Start the Go API on the internal port (background).
PORT=8081 /usr/local/bin/api &

# Start nginx in the foreground (handles signals, keeps container alive).
nginx -g 'daemon off;'
