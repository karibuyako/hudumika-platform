package api

// AI ASSISTANT chat surface (API-CONTRACT.yaml /assistant/chat, "Xiaomei-lite,
// mock-first", consumer docs/CONTRACT-ADDITIONS.md "AI assistant"): there is
// no model in this milestone (AI-LAYER.md honesty rule) — the handler is a
// deterministic rule-based engine that mirrors the consumer mock exactly
// (mock/assistant.ts): the FIRST intent whose keyword list the message hits
// wins, every intent returns a short canned reply with 2-3 tappable
// suggestions and contextUsed = ["intent:<key>"], and unknown messages get
// the helpful fallback. Reply text is SERVER copy and renders verbatim in
// the app — it is never localized.
//
// The handler is stateless (no database): the food/booking/order intents
// answer the no-data variant of the mock's copy because there is no seeded
// demo state server-side. Validation mirrors the contract body: message is
// required and maxLength 1000 (422 VALIDATION_FAILED otherwise).

import (
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/hudumika/api-backend/internal/gen"
)

// assistantChatMaxMessageLen is the contract bound on AssistantChatBody
// message (maxLength 1000).
const assistantChatMaxMessageLen = 1000

// assistantIntent is one keyword bucket of the rule engine; key is echoed in
// contextUsed and drives the canned reply selection.
type assistantIntent struct {
	key      string
	keywords []string
}

// assistantIntents mirrors mock/assistant.ts INTENTS, order matters: the
// first intent whose keyword list hits wins.
var assistantIntents = []assistantIntent{
	{"greeting", []string{"hello", "hi", "hey", "jambo", "habari", "morning", "evening", "thanks", "thank"}},
	{"payment", []string{"pay", "payment", "refund", "mpesa", "card", "wallet", "money", "charge", "cash", "airtel", "tigo", "halotel", "ezy"}},
	{"vertical", []string{"hotel", "travel", "trip", "flight", "event", "stay", "accommodation", "vacation", "holiday", "bus", "train"}},
	{"booking", []string{"booking", "service", "plumber", "clean", "repair", "provider", "reservation", "electrician", "technician"}},
	{"food", []string{"food", "restaurant", "eat", "hungry", "dish", "menu", "chips", "pilau", "chicken", "drink", "meal", "lunch", "dinner", "snack", "chapati", "fish"}},
	{"help", []string{"help", "support", "ticket", "issue", "problem", "complain", "agent", "human"}},
	{"order", []string{"order", "track", "deliver", "rider", "cancel", "reorder", "waybill", "eta", "shipment"}},
	{"account", []string{"account", "profile", "name", "address", "password", "language", "phone"}},
}

// assistantReply is the canned copy + suggestions for one intent.
type assistantReply struct {
	reply       string
	suggestions []string
}

// assistantReplies holds the server-owned copy per intent (the greeting is
// the app's first-open bubble, so the text must stay stable across versions).
var assistantReplies = map[string]assistantReply{
	"greeting": {
		reply:       "Habari! I'm Xiaomei, your HUDumika assistant — I can help you order food, book services, track orders and more. What would you like to do?",
		suggestions: []string{"Order food", "Book a service", "Get help"},
	},
	"payment": {
		reply:       "We support M-Pesa, Tigo Pesa, Airtel Money, cards and cash on delivery. Refunds land back in your wallet or original payment method within a few days.",
		suggestions: []string{"Check my wallet", "Payment methods", "Get help"},
	},
	"vertical": {
		reply:       "We now cover hotels, travel and events too — book a stay, plan a trip or find tickets, all in one place.",
		suggestions: []string{"Book a hotel", "Plan a trip", "Browse events"},
	},
	"booking": {
		reply:       "You can book services like plumbing, cleaning and repairs from the Services tab. I can point you to the right category.",
		suggestions: []string{"Book a service", "View my bookings", "Get help"},
	},
	"food": {
		reply:       "You can browse restaurants on the Home tab and order anything from their menus. I can help you pick something popular.",
		suggestions: []string{"Order food", "Browse restaurants", "View my orders"},
	},
	"help": {
		reply:       "For anything that needs a human, open a support ticket or browse the help center from the Me tab. I can also answer quick questions right here.",
		suggestions: []string{"Open a support ticket", "Browse help articles", "Ask something else"},
	},
	"order": {
		reply:       "You can track your orders in the Orders tab — open any order for live rider location, or chat with the merchant. Cancellations and reorders live there too.",
		suggestions: []string{"Track my order", "Cancel an order", "Reorder last order"},
	},
	"account": {
		reply:       "Your profile, addresses and security settings live in the Me tab — you can update your name, language and payment methods there.",
		suggestions: []string{"Update my profile", "Manage addresses", "Get help"},
	},
}

// assistantUnknownReply is the fallback for unmatched messages.
var assistantUnknownReply = assistantReply{
	reply:       "I'm not sure I caught that — but I can help you order food, book a service or track an order. Try one of these:",
	suggestions: []string{"Order food", "Book a service", "Get help"},
}

// assistantTokens lowercases the message, strips punctuation and splits on
// whitespace (mirrors the mock tokenizer; only ASCII letters/digits become
// tokens).
func assistantTokens(text string) []string {
	var tokens []string
	var cur []rune
	flush := func() {
		if len(cur) > 0 {
			tokens = append(tokens, string(cur))
			cur = nil
		}
	}
	for _, r := range strings.ToLower(text) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			cur = append(cur, r)
			continue
		}
		flush()
	}
	flush()
	return tokens
}

// assistantMatches reports whether any keyword is a token prefix or exact
// match (mirrors the mock's startsWith rule).
func assistantMatches(text string, keywords []string) bool {
	toks := assistantTokens(text)
	for _, kw := range keywords {
		for _, tok := range toks {
			if tok == kw || strings.HasPrefix(tok, kw) {
				return true
			}
		}
	}
	return false
}

// assistantIntentFor returns the first intent key whose keywords hit, or
// "unknown".
func assistantIntentFor(message string) string {
	for _, intent := range assistantIntents {
		if assistantMatches(message, intent.keywords) {
			return intent.key
		}
	}
	return "unknown"
}

// AssistantChat answers the Xiaomei-lite chat surface (POST /assistant/chat,
// body {message, context?}, 200 AssistantReply). The reply is a pure
// function of the message: identical input always yields identical output
// (documented: a model-backed reply is a Phase 3 upgrade, AI-LAYER.md).
// context is accepted but ignored — nothing server-side is derivable from it
// in the rule engine, so it cannot influence the reply.
func (s *Server) AssistantChat(w http.ResponseWriter, r *http.Request) {
	if _, ok := ClaimsFromContext(r.Context()); !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	var body gen.AssistantChatJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	message := strings.TrimSpace(body.Message)
	if message == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Message cannot be empty")
		return
	}
	if utf8.RuneCountInString(message) > assistantChatMaxMessageLen {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED",
			"Message exceeds the 1000-character limit")
		return
	}

	key := assistantIntentFor(message)
	reply := assistantUnknownReply
	if canned, ok := assistantReplies[key]; ok {
		reply = canned
	}
	contextUsed := []string{"intent:" + key}
	writeJSON(w, http.StatusOK, gen.AssistantReply{
		Reply:       reply.reply,
		Suggestions: reply.suggestions,
		ContextUsed: &contextUsed,
	})
}