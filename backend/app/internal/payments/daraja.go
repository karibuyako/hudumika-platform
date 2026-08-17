package payments

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/hudumika/api-backend/internal/tracing"
)

// Daraja (Safaricom M-Pesa) STK push client (backend/PAYMENTS.md): OAuth
// token acquisition with expiry caching, the STK processrequest invoke and
// the standard callback envelope mapping. The outbox delivery worker uses it
// through STKPushClient; without MPESA_CONSUMER_KEY the platform keeps the
// generic HTTP gateway fallback (mock-gateway in dev/staging).

const (
	// darajaBaseSandbox is the Safaricom sandbox host.
	darajaBaseSandbox = "https://sandbox.safaricom.co.ke"
	// darajaBaseProduction is the Safaricom production host.
	darajaBaseProduction = "https://api.safaricom.co.ke"
	// darajaTokenPath is the OAuth client-credentials token endpoint.
	darajaTokenPath = "/oauth/v1/generate"
	// darajaStkPushPath is the STK processrequest endpoint.
	darajaStkPushPath = "/mpesa/stkpush/v1/processrequest"
	// darajaTokenSafetyMargin shaves this much off the cached token lifetime
	// so an expired token is never presented to Daraja.
	darajaTokenSafetyMargin = 60 * time.Second
	// darajaRequestTimeout bounds a single Daraja HTTP call.
	darajaRequestTimeout = 15 * time.Second
	// maxDarajaResponse caps the response body read after a Daraja call.
	maxDarajaResponse = 1 << 16
)

// DarajaConfig is the operator-level M-Pesa configuration, assembled from
// MPESA_* env vars by DarajaConfigFromEnv.
type DarajaConfig struct {
	Env            string // "sandbox" or "production"
	ConsumerKey    string
	ConsumerSecret string
	ShortCode      string
	PassKey        string
	CallbackURL    string
	// BaseURL overrides the Daraja host (tests, custom gateways); empty uses
	// the env default (sandbox/production).
	BaseURL string
	// HTTPClient overrides the transport (tests); nil uses a default with a
	// 15s timeout and OTel tracing.
	HTTPClient *http.Client
	// Now overrides the clock (tests); nil uses time.Now.
	Now func() time.Time
}

// DarajaConfigFromEnv assembles the Daraja configuration from the MPESA_*
// environment. ok is false when MPESA_CONSUMER_KEY is unset — the caller
// keeps the generic HTTP gateway fallback (mock-gateway) in that case, so a
// dev server with no credentials still works.
func DarajaConfigFromEnv() (DarajaConfig, bool) {
	cfg := DarajaConfig{
		Env:            getEnvStr("MPESA_ENV", "sandbox"),
		ConsumerKey:    os.Getenv("MPESA_CONSUMER_KEY"),
		ConsumerSecret: os.Getenv("MPESA_CONSUMER_SECRET"),
		ShortCode:      os.Getenv("MPESA_SHORTCODE"),
		PassKey:        os.Getenv("MPESA_PASSKEY"),
		CallbackURL:    os.Getenv("MPESA_STK_CALLBACK_URL"),
	}
	if cfg.ConsumerKey == "" {
		return DarajaConfig{}, false
	}
	return cfg, true
}

func getEnvStr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// DarajaClient talks to Safaricom's Daraja API: an OAuth token (cached until
// just before expiry) and the STK push invocation.
type DarajaClient struct {
	cfg     DarajaConfig
	baseURL string
	client  *http.Client
	now     func() time.Time

	mu          sync.Mutex
	token       string
	tokenExpiry time.Time
}

// NewDarajaClient validates the configuration and returns a ready client.
// An empty consumer key is an error: callers must keep the generic gateway
// fallback instead (DarajaConfigFromEnv reports it as not configured).
func NewDarajaClient(cfg DarajaConfig) (*DarajaClient, error) {
	if cfg.Env != "sandbox" && cfg.Env != "production" {
		return nil, fmt.Errorf("payments: daraja: MPESA_ENV must be sandbox or production, got %q", cfg.Env)
	}
	if cfg.ConsumerKey == "" || cfg.ConsumerSecret == "" {
		return nil, fmt.Errorf("payments: daraja: MPESA_CONSUMER_KEY and MPESA_CONSUMER_SECRET are required")
	}
	if cfg.ShortCode == "" {
		return nil, fmt.Errorf("payments: daraja: MPESA_SHORTCODE is required")
	}
	if cfg.PassKey == "" {
		return nil, fmt.Errorf("payments: daraja: MPESA_PASSKEY is required")
	}
	if cfg.CallbackURL == "" {
		return nil, fmt.Errorf("payments: daraja: MPESA_STK_CALLBACK_URL is required")
	}
	baseURL := darajaBaseSandbox
	if cfg.Env == "production" {
		baseURL = darajaBaseProduction
	}
	if cfg.BaseURL != "" {
		baseURL = strings.TrimRight(cfg.BaseURL, "/")
	}
	client := cfg.HTTPClient
	if client == nil {
		client = tracing.HTTPClient(&http.Client{Timeout: darajaRequestTimeout})
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	return &DarajaClient{cfg: cfg, baseURL: baseURL, client: client, now: now}, nil
}

// Token returns a valid OAuth access token, fetching and caching one until
// just before its expiry. Concurrent callers share the cached token; a fetch
// failure is surfaced as-is so the delivery worker retries with backoff.
func (c *DarajaClient) Token(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	if c.token != "" && now.Before(c.tokenExpiry) {
		return c.token, nil
	}
	token, expiresIn, err := c.fetchToken(ctx)
	if err != nil {
		return "", err
	}
	c.token = token
	ttl := time.Duration(expiresIn) * time.Second
	if ttl > darajaTokenSafetyMargin {
		ttl -= darajaTokenSafetyMargin
	}
	c.tokenExpiry = now.Add(ttl)
	return c.token, nil
}

// tokenResponse is the Daraja OAuth success envelope.
type tokenResponse struct {
	AccessToken string `json:"access_token"`
	ExpiresIn   string `json:"expires_in"`
}

// fetchToken performs the client-credentials grant: GET the token endpoint
// with HTTP Basic auth over the consumer key/secret pair.
func (c *DarajaClient) fetchToken(ctx context.Context) (token string, expiresIn int, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		c.baseURL+darajaTokenPath+"?grant_type=client_credentials", nil)
	if err != nil {
		return "", 0, fmt.Errorf("payments: daraja: token request: %w", err)
	}
	req.SetBasicAuth(c.cfg.ConsumerKey, c.cfg.ConsumerSecret)

	resp, err := c.client.Do(req)
	if err != nil {
		return "", 0, fmt.Errorf("payments: daraja: token POST: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxDarajaResponse))
	if err != nil {
		return "", 0, fmt.Errorf("payments: daraja: token read: %w", err)
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return "", 0, fmt.Errorf("payments: daraja: token responded %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	var parsed tokenResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", 0, fmt.Errorf("payments: daraja: token envelope: %w", err)
	}
	if parsed.AccessToken == "" {
		return "", 0, errors.New("payments: daraja: token envelope carried no access_token")
	}
	expiresIn = 3600
	if parsed.ExpiresIn != "" {
		if n, perr := parseInt(parsed.ExpiresIn); perr == nil && n > 0 {
			expiresIn = n
		}
	}
	return parsed.AccessToken, expiresIn, nil
}

// STKPushRequest is the Daraja STK processrequest invocation. Phone is the
// customer MSISDN in local form (+255/0/255 prefixes are normalized to 254).
type STKPushRequest struct {
	AmountTZS        int64
	Phone            string
	AccountReference string
	TransactionDesc  string
}

// STKPushResponse is the Daraja STK invoke envelope. ResponseCode "0" is an
// acceptance by Daraja; the outcome itself arrives on the callback.
type STKPushResponse struct {
	MerchantRequestID string
	CheckoutRequestID string
	ResponseCode      string
	ResponseDesc      string
}

// STKPushClient is the seam the outbox delivery worker (notifications
// package) depends on; *DarajaClient implements it.
type STKPushClient interface {
	STKPush(ctx context.Context, req STKPushRequest) (STKPushResponse, error)
}

// STKPushRequestFromProviderRequest shapes the Daraja invocation from the
// enqueued outbox payload (BuildProviderRequest): the platform reference (or
// the AccountReference carried in the payload, which the intent build sets
// to the order id) becomes Daraja's AccountReference.
func STKPushRequestFromProviderRequest(req ProviderRequest) (STKPushRequest, error) {
	accountRef := req.Reference
	if v, ok := req.Payload["AccountReference"].(string); ok && v != "" {
		accountRef = v
	}
	if req.AmountTZS <= 0 {
		return STKPushRequest{}, fmt.Errorf("payments: daraja: amount must be positive, got %d", req.AmountTZS)
	}
	return STKPushRequest{
		AmountTZS:        req.AmountTZS,
		Phone:            req.Phone,
		AccountReference: accountRef,
		TransactionDesc:  "Hudumika payment",
	}, nil
}

// NormalizeMpesaPhone converts a Tanzanian subscriber number into the Daraja
// MSISDN form (2547XXXXXXXX): +2557XXXXXXXX, 2557XXXXXXXX, 07XXXXXXXX and
// 7XXXXXXXX are all accepted. Anything else fails with a clear error so an
// unparseable number is surfaced at delivery time, never silently sent.
func NormalizeMpesaPhone(p string) (string, error) {
	p = strings.TrimSpace(p)
	if strings.HasPrefix(p, "+") {
		p = p[1:]
	}
	switch {
	case strings.HasPrefix(p, "254"):
		if len(p) == 12 && p[3] == '7' {
			return p, nil
		}
	case strings.HasPrefix(p, "255"):
		rest := p[3:]
		if len(rest) == 9 && rest[0] == '7' {
			return "254" + rest, nil
		}
	case strings.HasPrefix(p, "0"):
		rest := p[1:]
		if len(rest) == 9 && rest[0] == '7' {
			return "254" + rest, nil
		}
	default:
		if len(p) == 9 && p[0] == '7' {
			return "254" + p, nil
		}
	}
	return "", fmt.Errorf("payments: daraja: phone %q is not a valid Tanzanian M-Pesa number (want +2557XXXXXXXX, 07XXXXXXXX or 2547XXXXXXXX)", p)
}

// STKPush invokes the Daraja STK processrequest: the password is
// base64(shortcode+passkey+timestamp), PartyA/PhoneNumber are the normalized
// customer MSISDN, and a non-"0" ResponseCode is an error carrying Daraja's
// description.
func (c *DarajaClient) STKPush(ctx context.Context, req STKPushRequest) (STKPushResponse, error) {
	msisdn, err := NormalizeMpesaPhone(req.Phone)
	if err != nil {
		return STKPushResponse{}, err
	}
	if req.AmountTZS <= 0 {
		return STKPushResponse{}, fmt.Errorf("payments: daraja: amount must be positive, got %d", req.AmountTZS)
	}
	if req.AccountReference == "" {
		return STKPushResponse{}, errors.New("payments: daraja: AccountReference is required")
	}
	token, err := c.Token(ctx)
	if err != nil {
		return STKPushResponse{}, err
	}

	ts := c.now().Format("20060102150405")
	password := base64.StdEncoding.EncodeToString([]byte(c.cfg.ShortCode + c.cfg.PassKey + ts))
	payload := map[string]any{
		"BusinessShortCode": c.cfg.ShortCode,
		"Password":          password,
		"Timestamp":         ts,
		"TransactionType":   "CustomerPayBillOnline",
		"Amount":            req.AmountTZS,
		"PartyA":            msisdn,
		"PartyB":            c.cfg.ShortCode,
		"PhoneNumber":       msisdn,
		"CallBackURL":       c.cfg.CallbackURL,
		"AccountReference":  req.AccountReference,
		"TransactionDesc":   req.TransactionDesc,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return STKPushResponse{}, fmt.Errorf("payments: daraja: stk payload: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+darajaStkPushPath, strings.NewReader(string(body)))
	if err != nil {
		return STKPushResponse{}, fmt.Errorf("payments: daraja: stk request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+token)

	resp, err := c.client.Do(httpReq)
	if err != nil {
		return STKPushResponse{}, fmt.Errorf("payments: daraja: stk push POST: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxDarajaResponse))
	if err != nil {
		return STKPushResponse{}, fmt.Errorf("payments: daraja: stk push read: %w", err)
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return STKPushResponse{}, fmt.Errorf("payments: daraja: stk push responded %s: %s", resp.Status, strings.TrimSpace(string(raw)))
	}
	var envelope struct {
		MerchantRequestID string `json:"MerchantRequestID"`
		CheckoutRequestID string `json:"CheckoutRequestID"`
		ResponseCode      string `json:"ResponseCode"`
		ResponseDesc      string `json:"ResponseDesc"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return STKPushResponse{}, fmt.Errorf("payments: daraja: stk envelope: %w", err)
	}
	if envelope.ResponseCode != "" && envelope.ResponseCode != "0" {
		return STKPushResponse{}, fmt.Errorf("payments: daraja: stk push rejected: %s %s", envelope.ResponseCode, envelope.ResponseDesc)
	}
	return STKPushResponse{
		MerchantRequestID: envelope.MerchantRequestID,
		CheckoutRequestID: envelope.CheckoutRequestID,
		ResponseCode:      envelope.ResponseCode,
		ResponseDesc:      envelope.ResponseDesc,
	}, nil
}

// ---- Callback envelope ----

// stkCallbackEnvelope is the wire form Daraja posts to MPESA_STK_CALLBACK_URL:
//
//	{ "Body": { "stkCallback": { "MerchantRequestID", "CheckoutRequestID",
//	  "ResultCode", "ResultDesc", "CallbackMetadata": { "Item": [
//	    {"Name": "Amount", "Value": ...}, ... ] } } } }
type stkCallbackEnvelope struct {
	Body struct {
		StkCallback struct {
			MerchantRequestID string `json:"MerchantRequestID"`
			CheckoutRequestID string `json:"CheckoutRequestID"`
			ResultCode        int    `json:"ResultCode"`
			ResultDesc        string `json:"ResultDesc"`
			CallbackMetadata  *struct {
				Item []struct {
					Name  string          `json:"Name"`
					Value json.RawMessage `json:"Value"`
				} `json:"Item"`
			} `json:"CallbackMetadata"`
		} `json:"stkCallback"`
	} `json:"Body"`
}

// STKCallback is the mapped Daraja callback outcome. ResultCode 0 is a
// completed payment; any other code is a failure described by ResultDesc.
type STKCallback struct {
	MerchantRequestID string
	CheckoutRequestID string
	ResultCode        int
	ResultDesc        string
	AmountTZS         int64
	MpesaReceipt      string
	AccountReference  string
	Phone             string
}

// Status maps the Daraja ResultCode onto the platform webhook status:
// 0 → paid, everything else → failed.
func (c STKCallback) Status() string {
	if c.ResultCode == 0 {
		return "paid"
	}
	return "failed"
}

// ParseSTKCallback decodes the Daraja STK callback envelope. A payload
// without a CheckoutRequestID is not a Daraja callback and is an error; the
// Amount/AccountReference values are lifted from CallbackMetadata so the
// platform can reconcile the intent and settle the order.
func ParseSTKCallback(body []byte) (STKCallback, error) {
	var env stkCallbackEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		return STKCallback{}, fmt.Errorf("payments: daraja: callback envelope: %w", err)
	}
	cb := env.Body.StkCallback
	if cb.CheckoutRequestID == "" {
		return STKCallback{}, errors.New("payments: daraja: callback envelope carried no CheckoutRequestID")
	}
	out := STKCallback{
		MerchantRequestID: cb.MerchantRequestID,
		CheckoutRequestID: cb.CheckoutRequestID,
		ResultCode:        cb.ResultCode,
		ResultDesc:        cb.ResultDesc,
	}
	if cb.CallbackMetadata != nil {
		for _, item := range cb.CallbackMetadata.Item {
			switch item.Name {
			case "Amount":
				out.AmountTZS = rawInt64(item.Value)
			case "MpesaReceiptNumber":
				out.MpesaReceipt = strings.Trim(string(item.Value), `"`)
			case "AccountReference":
				out.AccountReference = strings.Trim(string(item.Value), `"`)
			case "PhoneNumber":
				out.Phone = strings.Trim(string(item.Value), `"`)
			}
		}
	}
	return out, nil
}

// rawInt64 reads an int64 from a JSON RawMessage that is either a number or
// a numeric string (Daraja is inconsistent across sandbox/production).
func rawInt64(raw json.RawMessage) int64 {
	var n int64
	if err := json.Unmarshal(raw, &n); err == nil {
		return n
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		if v, perr := parseRawInt64(s); perr == nil {
			return v
		}
	}
	return 0
}

// parseInt parses a base-10 integer, tolerating whitespace.
func parseInt(s string) (int, error) {
	var n int
	_, err := fmt.Sscanf(strings.TrimSpace(s), "%d", &n)
	if err != nil {
		return 0, err
	}
	return n, nil
}

// parseRawInt64 parses a base-10 integer from a JSON number or numeric
// string into an int64.
func parseRawInt64(s string) (int64, error) {
	var n int64
	_, err := fmt.Sscanf(strings.TrimSpace(s), "%d", &n)
	if err != nil {
		return 0, err
	}
	return n, nil
}