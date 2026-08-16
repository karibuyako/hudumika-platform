// Package ws implements the /ws WebSocket endpoint: a per-process hub of
// connected clients plus a Redis pub/sub spine so any API instance can push
// an event to the users connected to any other instance (multi-instance
// safe). When Redis is absent the hub degrades to process-local fan-out only
// (development mode); the real-time contract is still served, but pushes
// never leave the process.
package ws

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/gorilla/websocket"
)

// wsEventsChannel is the Redis pub/sub channel carrying cross-instance push
// messages. Each payload is a pubMessage; every instance's subscriber
// re-broadcasts it to its local clients.
const wsEventsChannel = "ws:events"

// defaultMaxConnsPerUser caps how many concurrent connections one user may
// hold in a single process; NewHub seeds MaxConnsPerUser with it and the
// API layer can raise it per deployment if needed.
const defaultMaxConnsPerUser = 8

// platformUserID is the pseudo-user carried by platform-wide (BroadcastAll)
// push messages on ws:events. It matches every client regardless of the
// client's own userID — the ACL grants a client its own events plus any
// message addressed to this platform topic.
const platformUserID = "*"

// Client is one upgraded WebSocket connection. send carries the payloads the
// hub (or the connection's own read loop, for replies) wants delivered; it is
// buffered and never blocks the broadcaster — a slow client has messages
// dropped and is eventually reaped by the pong deadline. topics is the set of
// topics the client subscribed to with {"type":"subscribe"}; it is read by
// deliver and written by the connection's own read loop, both under h.mu.
type Client struct {
	conn   *websocket.Conn
	userID string
	send   chan []byte
	topics map[string]bool
}

// Hub tracks the connected clients of one process. Register/unregister are
// the only ways clients enter or leave the map, so Run's single goroutine
// owns client membership; the broadcast methods take the mutex only to
// snapshot the set. userConns mirrors clients on a per-user basis so the
// per-user connection cap can be enforced without scanning the whole map.
type Hub struct {
	mu         sync.Mutex
	clients    map[*Client]bool
	userConns  map[string]int
	register   chan *Client
	unregister chan *Client
	logger     *slog.Logger
	// redis is non-nil when the hub pushes through Redis pub/sub
	// (multi-instance mode). It is set before Run starts and never swapped.
	redis *redis.Client
	// MaxConnsPerUser is the connection cap per userID for this process.
	// It is read by CanRegister; zero is treated as the default.
	MaxConnsPerUser int
}

// NewHub builds a hub with no connected clients and no Redis spine. Wire
// Redis with SetRedis before calling Run when the process has it.
func NewHub(logger *slog.Logger) *Hub {
	return &Hub{
		clients:         make(map[*Client]bool),
		userConns:       make(map[string]int),
		register:        make(chan *Client),
		unregister:      make(chan *Client),
		logger:          logger,
		MaxConnsPerUser: defaultMaxConnsPerUser,
	}
}

// maxConns returns the effective per-user cap (the zero value means the
// default). Callers must hold h.mu.
func (h *Hub) maxConns() int {
	if h.MaxConnsPerUser <= 0 {
		return defaultMaxConnsPerUser
	}
	return h.MaxConnsPerUser
}

// CanRegister reports whether userID may open one more connection under the
// per-user cap. HandleConn calls it before registering; the check is
// advisory (two racing dials can both pass before Run applies either), so
// the cap is a soft bound under extreme concurrency, not a strict one.
func (h *Hub) CanRegister(userID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.userConns[userID] < h.maxConns()
}

// SetRedis wires the Redis client used for cross-instance push. It must be
// called before Run (the subscriber reads it once at startup). The hub keeps
// working without it: BroadcastToUser/BroadcastAll fall back to local fan-out.
func (h *Hub) SetRedis(client *redis.Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.redis = client
}

// Run drives the hub until ctx is cancelled: it applies registrations,
// unregistrations, starts the Redis subscriber goroutine, and on shutdown
// closes every client's send channel so write loops exit. Blocking sends into
// register/unregister from dying connections after ctx is done are expected
// at process shutdown and are not recovered here.
func (h *Hub) Run(ctx context.Context) {
	h.logger.Info("ws hub started")
	go h.SubscribeRedis(ctx)

	for {
		select {
		case c := <-h.register:
			h.mu.Lock()
			h.clients[c] = true
			h.userConns[c.userID]++
			h.mu.Unlock()
		case c := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[c]; ok {
				delete(h.clients, c)
				if n := h.userConns[c.userID]; n > 1 {
					h.userConns[c.userID] = n - 1
				} else {
					delete(h.userConns, c.userID)
				}
				close(c.send)
			}
			h.mu.Unlock()
		case <-ctx.Done():
			h.mu.Lock()
			for c := range h.clients {
				delete(h.clients, c)
				close(c.send)
			}
			h.userConns = make(map[string]int)
			h.mu.Unlock()
			h.logger.Info("ws hub stopped")
			return
		}
	}
}

// SubscribeRedis consumes the ws:events pub/sub channel and re-broadcasts
// every message to the local clients it is addressed to: by userID, or by
// topic when the envelope carries one (an empty user means platform-wide).
// This is the receive half of the multi-instance spine: another instance's
// BroadcastToUser/BroadcastToTopic/BroadcastAll lands here. Without a wired
// Redis client the subscriber is a no-op and pushes are process-local only
// (dev mode). go-redis re-subscribes automatically on reconnect; if the
// subscription channel ever closes the loop resubscribes so a transient Redis
// hiccup cannot permanently silence live pushes. The subscription ends when
// ctx is cancelled.
func (h *Hub) SubscribeRedis(ctx context.Context) {
	h.mu.Lock()
	client := h.redis
	h.mu.Unlock()
	if client == nil {
		h.logger.Debug("ws redis subscriber skipped: redis not configured")
		return
	}
	for ctx.Err() == nil {
		sub := client.Subscribe(ctx, wsEventsChannel)
		h.logger.Info("ws redis subscriber started", "channel", wsEventsChannel)
		for msg := range sub.Channel() {
			m, err := decodePubMessage(msg.Payload)
			if err != nil {
				h.logger.Warn("ws redis push ignored", "error", err)
				continue
			}
			h.deliver(m.UserID, m.Topic, []byte(m.Payload))
		}
		_ = sub.Close()
		if ctx.Err() != nil {
			return
		}
		h.logger.Warn("ws redis subscription lost; resubscribing")
		select {
		case <-ctx.Done():
			return
		case <-time.After(500 * time.Millisecond):
		}
	}
}

// BroadcastToUser pushes payload to every connected client with the given
// userID. With Redis wired the push is published on ws:events (so every
// instance's subscribers deliver it locally — the publisher's own subscriber
// covers its local clients); without Redis it fans out directly in-process.
func (h *Hub) BroadcastToUser(userID string, payload []byte) {
	h.publish(userID, "", payload)
}

// BroadcastToTopic pushes payload to every connected client subscribed to
// topic. With Redis wired the push is published on ws:events inside a topic
// envelope; without Redis it fans out directly to the local subscribers.
func (h *Hub) BroadcastToTopic(topic string, payload []byte) {
	h.publish("", topic, payload)
}

// BroadcastAll pushes payload to every connected client in the platform,
// regardless of user. Same Redis/local split as BroadcastToUser. Platform
// pushes carry the platformUserID topic so the subscriber fan-out (deliver)
// matches every client under the per-user ACL.
func (h *Hub) BroadcastAll(payload []byte) {
	h.publish(platformUserID, "", payload)
}

// SubscribeTopic registers topic on the client so topic-scoped pushes reach
// it. It is called by the connection's read loop on {"type":"subscribe"};
// delivery reads the same map under h.mu, so no further synchronization is
// needed.
func (h *Hub) SubscribeTopic(c *Client, topic string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	c.topics[topic] = true
}

// UnsubscribeTopic removes topic from the client; pushes to the topic stop
// reaching it from the moment the removal is applied.
func (h *Hub) UnsubscribeTopic(c *Client, topic string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(c.topics, topic)
}

func (h *Hub) publish(userID, topic string, payload []byte) {
	h.mu.Lock()
	client := h.redis
	h.mu.Unlock()
	if client != nil {
		raw, err := json.Marshal(pubMessage{
			UserID:  userID,
			Topic:   topic,
			Payload: base64.StdEncoding.EncodeToString(payload),
		})
		if err != nil {
			h.logger.Warn("ws push marshal failed", "error", err)
			return
		}
		if err := client.Publish(context.Background(), wsEventsChannel, raw).Err(); err != nil {
			h.logger.Warn("ws redis publish failed", "error", err)
		}
		return
	}
	h.deliver(userID, topic, payload)
}

// deliver sends payload to the local clients it is addressed to. A non-empty
// topic reaches only the clients subscribed to it; otherwise the per-user ACL
// applies (the platform topic platformUserID — or the legacy empty userID —
// matches everyone). This is the ACL enforcement point shared by the local
// fan-out and the Redis subscriber: a client only ever receives messages
// addressed to its own userID, to a topic it subscribed to, or to the
// platform topic. The send never blocks: a client whose buffer is full is
// skipped — it is lagging and will be reaped by the pong deadline (or catch
// up via a sync request).
func (h *Hub) deliver(userID, topic string, payload []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		if topic != "" {
			if !c.topics[topic] {
				continue
			}
		} else if userID != "" && userID != platformUserID && c.userID != userID {
			continue
		}
		select {
		case c.send <- payload:
		default:
			h.logger.Debug("ws push dropped for slow client", "user", c.userID)
		}
	}
}

// pubMessage is the wire format on ws:events. Payload is base64-encoded so
// arbitrary push bytes survive the JSON envelope unchanged; UserID scopes the
// push — the platformUserID ("*") topic, or an empty user, means
// platform-wide. Topic scopes the push to the subscribers of one topic and
// takes precedence over UserID at delivery.
type pubMessage struct {
	UserID  string `json:"user,omitempty"`
	Topic   string `json:"topic,omitempty"`
	Payload string `json:"payload"`
}

func decodePubMessage(raw string) (pubMessage, error) {
	var m pubMessage
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return m, err
	}
	b, err := base64.StdEncoding.DecodeString(m.Payload)
	if err != nil {
		return m, err
	}
	m.Payload = string(b)
	return m, nil
}
