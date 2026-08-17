package api

// VOICE SEARCH surface (API-CONTRACT.yaml /search/voice): the contract
// summary is "Voice search — transcript is sent, results mirror /search" and
// the body is { query: string, maxLength 200 }. There is no speech-to-text
// model in this milestone (AI-LAYER.md honesty rule), so the handler is
// honest like image_search.go: it validates the request, then answers the
// contract's SearchResults shape with an EMPTY results array echoing the
// transcript as query — a client can correlate the response to its request,
// and nothing fabricated is ever returned (the consumer mock returns a
// canned corpus only because it seeds one; the live server has no seeded
// demo state).
//
// The handler is stateless: it never touches s.db (nil is fine), Redis, or
// any external service. Auth is enforced by the router gate — /search/voice
// is not in isPublicPath, so RequireAuth rejects unauthenticated callers
// with 401 before this handler runs (AUTH.md).

import (
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/hudumika/api-backend/internal/gen"
)

// voiceSearchMaxQueryLen is the contract bound on VoiceSearchBody query
// (maxLength 200).
const voiceSearchMaxQueryLen = 200

// VoiceSearch answers the voice-transcript search surface (POST
// /search/voice, body {query}, 200 SearchResults): query echoes the trimmed
// transcript, results is the contract's empty array (never null) — a real
// speech-to-text + corpus match is a Phase 3 upgrade.
func (s *Server) VoiceSearch(w http.ResponseWriter, r *http.Request) {
	var body gen.VoiceSearchJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	query := strings.TrimSpace(body.Query)
	if query == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "query is required")
		return
	}
	if utf8.RuneCountInString(query) > voiceSearchMaxQueryLen {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "query must be at most 200 characters")
		return
	}

	writeJSON(w, http.StatusOK, gen.SearchResults{
		Query:   query,
		Results: emptySearchResults(),
	})
}