package ws

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// sendBuffer is the per-client outbound queue depth; broadcasts never
	// block on a slow client (see Hub.deliver).
	sendBuffer = 16
	// maxReadBytes caps inbound client frames.
	maxReadBytes = 4096
	// writeWait is how long a single write (reply, ping) may block on the
	// socket before the connection is judged dead.
	writeWait = 10 * time.Second
	// readWait is the read-deadline grace: it is refreshed on every inbound
	// frame and by the pong handler, so a connection that neither sends nor
	// answers pings is closed after readWait of silence.
	readWait = 60 * time.Second
	// pongWait is the read-deadline grace: the connection must answer a ping
	// with a pong within it or the read loop closes it.
	pongWait = 30 * time.Second
	// pingPeriod keeps pings comfortably inside the pong deadline.
	pingPeriod = (pongWait * 9) / 10
)

// clientMessage is one frame from the client. The contract's sync frame is
// {type:'sync', merchantId, after}; merchantId is accepted and ignored — the
// event log is shared platform-wide and the client dispatcher filters.
type clientMessage struct {
	Type       string `json:"type"`
	After      *int64 `json:"after,omitempty"`
	Topic      string `json:"topic,omitempty"`
	MerchantID string `json:"merchantId,omitempty"`
}

// knownTopicPrefixes names the topic namespaces the server accepts in
// {"type":"subscribe"} frames; a topic is known when it carries one of these
// prefixes (the part after the colon is the domain id, e.g. a conversation
// UUID). Anything else is answered with the "unknown topic" error.
var knownTopicPrefixes = []string{"conversation:"}

// knownTopic reports whether topic names a namespace the server can deliver.
func knownTopic(topic string) bool {
	if topic == "" {
		return false
	}
	for _, prefix := range knownTopicPrefixes {
		if strings.HasPrefix(topic, prefix) {
			return true
		}
	}
	return false
}

// HandleConn upgrades the request to a WebSocket and serves the connection
// until it dies. The API layer authenticates before calling this; userID is
// the authenticated subject and expiresAt is the token's exp (zero means no
// session expiry). readSince answers {type:'sync'} frames from the event
// log: given the client's watermark it returns the complete JSON reply bytes
// (the caller owns the backend — Redis stream or PostgreSQL event_log).
// checkOrigin implements the upgrader's cross-origin policy (the API layer
// passes the configured CORS origins). Connections over the per-user cap are
// closed with a policy close frame (1008) instead of being registered.
// HandleConn blocks for the lifetime of the connection.
func (h *Hub) HandleConn(w http.ResponseWriter, r *http.Request, userID string, expiresAt time.Time, readSince func(after int64) ([]byte, error), checkOrigin func(r *http.Request) bool) {
	upgrader := websocket.Upgrader{CheckOrigin: checkOrigin}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.logger.Warn("ws upgrade failed", "error", err)
		return
	}
	if !h.CanRegister(userID) {
		h.refuse(conn, userID, "connection limit exceeded for user")
		return
	}
	c := &Client{conn: conn, userID: userID, send: make(chan []byte, sendBuffer), topics: make(map[string]bool)}
	h.register <- c
	h.logger.Info("ws client connected", "user", userID)
	defer func() {
		h.unregister <- c
		conn.Close()
		h.logger.Info("ws client disconnected", "user", userID)
	}()
	go h.writeLoop(c)
	h.readLoop(c, expiresAt, readSince)
}

// refuse closes a connection that the policy will not accept with a 1008
// close frame instead of registering it with the hub.
func (h *Hub) refuse(conn *websocket.Conn, userID, reason string) {
	h.logger.Warn("ws connection refused", "user", userID, "reason", reason)
	_ = conn.WriteControl(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.ClosePolicyViolation, reason),
		time.Now().Add(writeWait))
	conn.Close()
}

// expire sends the close frame that ends a session whose token expired
// mid-connection. WriteControl is safe to call concurrently with the write
// loop; the read loop then returns and HandleConn tears the connection down.
func (h *Hub) expire(c *Client) {
	h.logger.Info("ws session expired", "user", c.userID)
	_ = c.conn.WriteControl(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "token expired"),
		time.Now().Add(writeWait))
}

// readLoop consumes client frames until the connection breaks:
//   - {"type":"ping"} → {"type":"pong"}
//   - {"type":"sync","after":N} → the event log after N, as returned by
//     readSince (exclusive lower bound; absent after means 0)
//   - {"type":"subscribe","topic":...} → the client receives pushes to that
//     topic (e.g. "conversation:<id>" for live chat); unknown topics are
//     answered {"type":"error","message":"unknown topic"}
//   - {"type":"unsubscribe","topic":...} → pushes to the topic stop reaching
//     the client
//
// Unknown frames are logged and ignored. Read errors (timeout, close frame,
// peer gone) end the loop. On every tick the session expiry is enforced: a
// connection whose token has expired is closed with a policy frame (1008)
// instead of lingering.
func (h *Hub) readLoop(c *Client, expiresAt time.Time, readSince func(after int64) ([]byte, error)) {
	c.conn.SetReadLimit(maxReadBytes)
	_ = c.conn.SetReadDeadline(time.Now().Add(readWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(readWait))
	})

	for {
		if !expiresAt.IsZero() && time.Now().After(expiresAt) {
			h.expire(c)
			return
		}
		var msg clientMessage
		if err := c.conn.ReadJSON(&msg); err != nil {
			return
		}
		_ = c.conn.SetReadDeadline(time.Now().Add(readWait))
		switch msg.Type {
		case "ping":
			h.enqueue(c, mustJSON(map[string]string{"type": "pong"}))
		case "sync":
			after := int64(0)
			if msg.After != nil {
				after = *msg.After
			}
			payload, err := readSince(after)
			if err != nil {
				h.logger.Warn("ws sync read failed", "user", c.userID, "after", after, "error", err)
				payload = mustJSON(map[string]string{"type": "sync_error", "error": err.Error()})
			}
			h.enqueue(c, payload)
		case "subscribe":
			if !knownTopic(msg.Topic) {
				h.enqueue(c, mustJSON(map[string]string{"type": "error", "message": "unknown topic"}))
				break
			}
			h.SubscribeTopic(c, msg.Topic)
		case "unsubscribe":
			if msg.Topic != "" {
				h.UnsubscribeTopic(c, msg.Topic)
			}
		default:
			h.logger.Debug("ws unknown frame", "user", c.userID, "type", msg.Type)
		}
	}
}

// writeLoop pumps outbound payloads and heartbeats. When the hub closes the
// send channel (unregister/shutdown) it sends a close frame and exits; any
// write error kills the loop and the read loop then tears the connection down.
func (h *Hub) writeLoop(c *Client) {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()
	for {
		select {
		case payload, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, payload); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// enqueue queues a reply without blocking the read loop; a full buffer drops
// the reply (the connection is already flagged slow by the pong deadline).
func (h *Hub) enqueue(c *Client, payload []byte) {
	select {
	case c.send <- payload:
	default:
	}
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte(`{"type":"error"}`)
	}
	return b
}
