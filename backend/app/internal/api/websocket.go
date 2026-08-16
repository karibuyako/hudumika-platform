package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/hudumika/api-backend/internal/ws"
)

// The WebSocket hub is a package-level singleton: all servers in the process
// share one hub so the /ws route of any instance sees every connection of the
// process. It is created lazily on the first authenticated upgrade (auth
// failures never touch it) and lives for the process — Run is started in a
// goroutine with a background context, the same lifecycle as the servers
// themselves. When the first authenticated server has Redis wired, the hub
// pushes cross-instance through Redis pub/sub and the events relay below
// starts; otherwise pushes are process-local only (dev mode).
var (
	wsHubOnce sync.Once
	wsHub     *ws.Hub
	wsHubCtx  context.Context
	wsHubStop context.CancelFunc
)

// HandleWebSocket serves the /ws endpoint mounted in Router() outside the
// auth-wrapped tree. It authenticates itself — the Authorization bearer
// header or a ?token= query parameter — and answers the standard 401 JSON
// envelope before any upgrade happens. On success the connection is handed to
// the hub with the authenticated subject as the user scoping.
func (s *Server) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	token := bearerToken(r)
	if token == "" {
		token = r.URL.Query().Get("token")
	}
	if token == "" {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	claims, err := s.parseToken(token)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	// The JWT parser already rejects expired tokens; this is a belt-and-
	// braces check so the 401 envelope is emitted before any upgrade even if
	// a future parser option skips claim validation.
	if claims.ExpiresAt != nil && time.Now().After(claims.ExpiresAt.Time) {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Token expired")
		return
	}
	// Record the token's expiry in the session: the hub closes the
	// connection with a policy frame once it passes, so a long-lived WS
	// session cannot outlive its access token.
	expiresAt := time.Time{}
	if claims.ExpiresAt != nil {
		expiresAt = claims.ExpiresAt.Time
	}

	hub := s.wsHub()
	hub.HandleConn(w, r, claims.Subject, expiresAt, s.wsReadSince(),
		func(r *http.Request) bool { return s.allowsOrigin(r.Header.Get("Origin")) })
}

// wsHub returns the process-wide hub singleton, creating and starting it on
// first use (see the package comment).
func (s *Server) wsHub() *ws.Hub {
	wsHubOnce.Do(func() {
		hub := ws.NewHub(s.logger)
		if s.stores != nil && s.stores.Redis != nil {
			hub.SetRedis(s.stores.Redis.Client())
		}
		wsHub = hub
		wsHubCtx, wsHubStop = context.WithCancel(context.Background())
		go hub.Run(wsHubCtx)
		if s.stores != nil && s.stores.Redis != nil {
			go s.wsEventsRelay(wsHubCtx)
		}
	})
	return wsHub
}

// wsReadSince backs the sync frame: given the client's watermark it returns
// the complete reply JSON. The backend selection mirrors GetServerEvents —
// the Redis events stream when present, the PostgreSQL event_log fallback
// (pgReadEvents) otherwise — so the WS sync view and the /events long-poll
// view agree.
func (s *Server) wsReadSince() func(after int64) ([]byte, error) {
	return func(after int64) ([]byte, error) {
		ctx := context.Background()
		var (
			events []serverEvent
			latest int64
			err    error
		)
		switch {
		case s.stores != nil && s.stores.Redis != nil:
			events, latest, err = s.readEvents(ctx, strconv.FormatInt(after+1, 10))
		case s.db != nil:
			events, latest, err = pgReadEvents(ctx, s.db.Pool(), after, int(eventReadCount))
		default:
			return nil, errors.New("no event backend configured (redis or postgres)")
		}
		if err != nil {
			return nil, fmt.Errorf("ws sync read: %w", err)
		}
		if events == nil {
			events = []serverEvent{}
		}
		return json.Marshal(struct {
			Type string `json:"type"`
			serverEventsResponse
		}{
			Type:                 "sync",
			serverEventsResponse: serverEventsResponse{Events: events, LatestSeq: latest},
		})
	}
}

// wsEventsRelay is the live-push half of the real-time contract: it blocks on
// the Redis events stream (XREAD) and re-broadcasts every entry as
// {"type":"event","event":{...}} through the hub. The delivery target is
// read from the entry payload: a "topic" field (e.g. "conversation:<id>")
// routes through BroadcastToTopic, a "user" field through BroadcastToUser,
// and everything else is broadcast platform-wide. The hub fans out via
// ws:events pub/sub (multi-instance safe: an event XADDed by any instance
// reaches every hub). It starts with "$" so only events published after the
// relay is up are pushed live — catch-up happens through the sync frame,
// whose readSince reads the same stream. Delivery is at-least-once: the
// watermark is never reset, so events published during a transient read
// failure are re-read (and re-pushed) rather than lost; clients dedupe by
// event id and can always resync via `after`.
func (s *Server) wsEventsRelay(ctx context.Context) {
	client := s.stores.Redis.Client()
	lastID := "$"
	for {
		if ctx.Err() != nil {
			return
		}
		streams, err := client.XRead(ctx, &redis.XReadArgs{
			Streams: []string{eventStreamKey, lastID},
			Count:   eventReadCount,
			Block:   time.Second,
		}).Result()
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			if err != redis.Nil {
				// A quiet block timeout (redis.Nil) just means the stream had
				// nothing new; only real errors back off.
				select {
				case <-ctx.Done():
					return
				case <-time.After(500 * time.Millisecond):
				}
			}
			continue
		}
		for _, stream := range streams {
			for _, m := range stream.Messages {
				lastID = m.ID
				payload := wsPushBytes(m)
				switch wsRelayTarget(m) {
				case wsRelayTopic:
					wsHub.BroadcastToTopic(wsRelayTargetValue(m), payload)
				case wsRelayUser:
					wsHub.BroadcastToUser(wsRelayTargetValue(m), payload)
				default:
					wsHub.BroadcastAll(payload)
				}
			}
		}
	}
}

// wsRelayTargetKind is the routing hint the relay reads from a stream entry
// payload.
type wsRelayTargetKind int

const (
	wsRelayPlatform wsRelayTargetKind = iota
	wsRelayTopic
	wsRelayUser
)

// wsRelayTarget reads the payload's routing fields. The payload is the
// JSON-marshaled event payload (the stream's "payload" field); when it
// carries a "topic" string the event is topic-scoped, else a "user" string
// user-scopes it. Malformed payloads fall back to platform-wide.
func wsRelayTarget(m redis.XMessage) wsRelayTargetKind {
	var meta struct {
		Topic string `json:"topic"`
		User  string `json:"user"`
	}
	if raw := streamString(m.Values, "payload"); raw != "" {
		_ = json.Unmarshal([]byte(raw), &meta)
	}
	switch {
	case meta.Topic != "":
		return wsRelayTopic
	case meta.User != "":
		return wsRelayUser
	default:
		return wsRelayPlatform
	}
}

// wsRelayTargetValue returns the routing value (topic or user id) for a
// topic- or user-scoped entry; empty for platform-wide entries.
func wsRelayTargetValue(m redis.XMessage) string {
	var meta struct {
		Topic string `json:"topic"`
		User  string `json:"user"`
	}
	if raw := streamString(m.Values, "payload"); raw != "" {
		_ = json.Unmarshal([]byte(raw), &meta)
	}
	if meta.Topic != "" {
		return meta.Topic
	}
	return meta.User
}

// wsPushBytes renders one Redis stream entry in the live-push frame format
// {"type":"event","event":{id,type,payload,at}}.
func wsPushBytes(m redis.XMessage) []byte {
	ev := serverEvent{}
	if ms, ok := streamIDMilliseconds(m.ID); ok {
		ev.ID = ms
		ev.At = time.UnixMilli(ms).UTC().Format(time.RFC3339)
	}
	ev.Type = streamString(m.Values, "type")
	if raw, ok := m.Values["payload"].(string); ok && raw != "" {
		if err := json.Unmarshal([]byte(raw), &ev.Payload); err != nil {
			ev.Payload = map[string]any{"raw": raw}
		}
	}
	b, err := json.Marshal(struct {
		Type  string      `json:"type"`
		Event serverEvent `json:"event"`
	}{Type: "event", Event: ev})
	if err != nil {
		return []byte(`{"type":"event"}`)
	}
	return b
}
