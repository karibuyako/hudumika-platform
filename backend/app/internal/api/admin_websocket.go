package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin:   func(r *http.Request) bool { return true },
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
}

type WSClient struct {
	conn  *websocket.Conn
	send  chan []byte
	rooms map[string]bool
}

type WSHub struct {
	clients    map[*WSClient]bool
	broadcast  chan WSBroadcastMsg
	register   chan *WSClient
	unregister chan *WSClient
	mu         sync.RWMutex
}

type WSBroadcastMsg struct {
	Room    string          `json:"room"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

type RiderPosition struct {
	EntityID   uuid.UUID `json:"entityId"`
	Lat        float64   `json:"lat"`
	Lon        float64   `json:"lon"`
	SpeedKmh   *float32  `json:"speedKmh,omitempty"`
	Heading    *float32  `json:"heading,omitempty"`
	AccuracyM  *float32  `json:"accuracyM,omitempty"`
	Activity   string    `json:"activity,omitempty"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

var hub *WSHub

func NewWSHub() *WSHub {
	return &WSHub{
		clients:    make(map[*WSClient]bool),
		broadcast:  make(chan WSBroadcastMsg, 256),
		register:   make(chan *WSClient),
		unregister: make(chan *WSClient),
	}
}

func (h *WSHub) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			h.mu.Lock()
			for client := range h.clients {
				close(client.send)
				delete(h.clients, client)
			}
			h.mu.Unlock()
			return
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client] = true
			h.mu.Unlock()
		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client]; ok {
				close(client.send)
				delete(h.clients, client)
			}
			h.mu.Unlock()
		case msg := <-h.broadcast:
			data, err := json.Marshal(msg)
			if err != nil {
				continue
			}
			h.mu.RLock()
			for client := range h.clients {
				if client.rooms[msg.Room] {
					select {
					case client.send <- data:
					default:
						h.mu.RUnlock()
						h.mu.Lock()
						close(client.send)
						delete(h.clients, client)
						h.mu.Unlock()
						h.mu.RLock()
					}
				}
			}
			h.mu.RUnlock()
		}
	}
}

// BroadcastRiderPositions sends live rider positions to all map subscribers.
func (h *WSHub) BroadcastRiderPositions(positions []RiderPosition) {
	payload, err := json.Marshal(positions)
	if err != nil {
		return
	}
	h.broadcast <- WSBroadcastMsg{
		Room:    "map:rider-positions",
		Type:    "rider-positions",
		Payload: payload,
	}
}

// BroadcastMapIncidents sends incident updates to all map subscribers.
func (h *WSHub) BroadcastMapIncidents(incidents json.RawMessage) {
	h.broadcast <- WSBroadcastMsg{
		Room:    "map:traffic",
		Type:    "map-incidents",
		Payload: incidents,
	}
}

// AdminWSHandler handles WebSocket connections from admin clients.
func (s *Server) AdminWSHandler(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireRBAC(w, r, s, PermConfigurationRead)
	if !ok {
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.logger.Error("websocket upgrade failed", "error", err)
		return
	}

	client := &WSClient{
		conn:  conn,
		send:  make(chan []byte, 256),
		rooms: make(map[string]bool),
	}

	hub.register <- client

	s.logger.Info("admin ws connected", "subject", claims.Subject)

	go client.writePump()
	go client.readPump(hub, s.logger)
}

func (c *WSClient) readPump(h *WSHub, logger *slog.Logger) {
	defer func() {
		h.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(4096)
	c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				logger.Warn("ws read error", "error", err)
			}
			break
		}

		var msg struct {
			Type string `json:"type"`
			Room string `json:"room"`
		}
		if err := json.Unmarshal(message, &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "subscribe":
			if msg.Room != "" {
				c.rooms[msg.Room] = true
			}
		case "unsubscribe":
			delete(c.rooms, msg.Room)
		}
	}
}

func (c *WSClient) writePump() {
	ticker := time.NewTicker(30 * time.Second)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			w, err := c.conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			w.Write(message)
			if err := w.Close(); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
