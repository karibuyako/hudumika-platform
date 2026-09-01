#!/usr/bin/env bash
set -euo pipefail

API="${ADMIN_API_URL:-http://localhost:8080/api/v1}"
TOKEN="${ADMIN_TOKEN:?Set ADMIN_TOKEN}"
CONCURRENCY="${CONCURRENCY:-10}"
DURATION="${DURATION:-30}"

echo "=== Hudumika Admin API Load Test ==="
echo "Target: $API"
echo "Concurrency: $CONCURRENCY"
echo "Duration: ${DURATION}s"
echo ""

# Check for tools
if command -v hey &>/dev/null; then
    TOOL="hey"
elif command -v wrk &>/dev/null; then
    TOOL="wrk"
else
    TOOL="curl"
fi

echo "Using tool: $TOOL"
echo ""

run_test() {
    local name="$1"
    local method="$2"
    local path="$3"
    local url="${API}${path}"

    echo "--- Testing: $name ---"

    case "$TOOL" in
        hey)
            hey -n $((CONCURRENCY * 100)) -c "$CONCURRENCY" -m "$method" \
                -H "Authorization: Bearer $TOKEN" "$url" 2>&1 | \
                grep -E "Requests/sec|Average|Fastest|Slowest|Status code"
            ;;
        wrk)
            wrk -t4 -c"$CONCURRENCY" -d"${DURATION}s" \
                -H "Authorization: Bearer $TOKEN" "$url" 2>&1
            ;;
        curl)
            # curl-based parallel test
            end_time=$(($(date +%s) + DURATION))
            success=0
            fail=0
            total=0
            while [ "$(date +%s)" -lt "$end_time" ]; do
                for i in $(seq 1 "$CONCURRENCY"); do
                    (
                        code=$(curl -s -o /dev/null -w "%{http_code}" \
                            -X "$method" \
                            -H "Authorization: Bearer $TOKEN" \
                            "$url" 2>/dev/null)
                        echo "$code"
                    ) &
                done
                wait
                total=$((total + CONCURRENCY))
            done
            echo "Completed $total requests"
            ;;
    esac
    echo ""
}

# Run tests
run_test "Health Check (no auth)" "GET" "/health"
run_test "Bookings List" "GET" "/admin/bookings"
run_test "Analytics Dashboard" "GET" "/admin/analytics/dashboard"
run_test "Admin Users List" "GET" "/admin/admins"

echo "=== Load Test Complete ==="
