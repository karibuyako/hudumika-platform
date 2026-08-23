# Go version must stay pinned in lockstep with go.mod (go 1.25.x).
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/api ./cmd/api

# Final image runs nginx in front of the Go API. nginx terminates the public
# $PORT, strips /api/v1 and /api prefixes, and proxies the rest (bare routes
# and /ws) to the Go service listening on 127.0.0.1:8081.
FROM nginx:1.27-alpine
RUN apk add --no-cache ca-certificates
COPY --from=build /out/api /usr/local/bin/api
COPY nginx.conf.template /etc/nginx/nginx.conf.template
COPY start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE 8080
ENTRYPOINT ["/start.sh"]
