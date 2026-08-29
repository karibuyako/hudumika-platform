package notifications

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/hudumika/api-backend/internal/tracing"
)

// TextBeeGateway delivers SMS via api.textbee.dev
// POST https://api.textbee.dev/api/v1/gateway/send-sms with {recipients:[], message}
type TextBeeGateway struct {
	url    string
	apiKey string
	client *http.Client
}

func NewTextBeeGateway(url, apiKey string) (*TextBeeGateway, error) {
	if strings.TrimSpace(url) == "" {
		return nil, fmt.Errorf("textbee: gateway URL is empty")
	}
	if url == "https://textbee.dev" || url == "https://textbee.dev/" {
		url = "https://api.textbee.dev/api/v1/gateway/send-sms"
	}
	if url == "https://api.textbee.dev" || url == "https://api.textbee.dev/" {
		url = "https://api.textbee.dev/api/v1/gateway/send-sms"
	}
	return &TextBeeGateway{
		url:    url,
		apiKey: apiKey,
		client: tracing.HTTPClient(&http.Client{Timeout: 10 * time.Second}),
	}, nil
}

type textBeeRequest struct {
	Recipients []string `json:"recipients"`
	Message    string   `json:"message"`
}

func (g *TextBeeGateway) Send(ctx context.Context, msg Message) error {
	if msg.Channel != "sms" {
		return fmt.Errorf("textbee: cannot deliver %q message", msg.Channel)
	}
	body, err := json.Marshal(textBeeRequest{
		Recipients: []string{msg.Recipient},
		Message:    string(msg.Payload),
	})
	if err != nil {
		return fmt.Errorf("textbee: marshal: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("textbee: request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if g.apiKey != "" {
		req.Header.Set("x-api-key", g.apiKey)
	}
	resp, err := g.client.Do(req)
	if err != nil {
		return fmt.Errorf("textbee: POST: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, maxGatewayResponse))
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("textbee: responded %s: %s", resp.Status, strings.TrimSpace(string(respBody)))
	}
	return nil
}
