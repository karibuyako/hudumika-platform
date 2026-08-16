package api

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/hudumika/api-backend/internal/gen"
)

// IMAGE SEARCH bounded context (API-CONTRACT.yaml /search/image): the
// contract declares the endpoint PLANNED — the summary is "Image search
// (PLANNED — placeholder endpoint)" and the body is { imageUrl: uri }.
// The vision model that would embed an image and match it against the
// marketplace catalogue does not exist yet, so the handler is honest about
// that: it validates the request, then always answers the contract's
// SearchResults shape with an EMPTY results array.
//
// The contract's SearchResults schema (required: query, results) has NO note
// field, so the placeholder note cannot ride in the payload and is documented
// here instead. The response is:
//
//	{ "query": "<imageUrl echoed>", "results": [] }
//
// query echoes the requested imageUrl so a client can correlate the response
// to its request; results is the contract's empty array (never null). No
// `total` is sent: the contract marks it optional and there are no rows to
// count. A future implementation should replace this body with the real
// vision search and, if a note is still wanted, add a note field to the
// contract schema first.
//
// The handler is stateless: it never touches s.db (nil is fine), Redis, or
// any external service. Auth is enforced by the router gate — /search/image
// is not in isPublicPath, so RequireAuth rejects unauthenticated callers with
// 401 before this handler runs (AUTH.md).
func (s *Server) ImageSearch(w http.ResponseWriter, r *http.Request) {
	var body gen.ImageSearchJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}

	imageURL := strings.TrimSpace(body.ImageUrl)
	if imageURL == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "imageUrl is required")
		return
	}
	if !validImageSearchURL(imageURL) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "imageUrl must be an http(s) URL")
		return
	}

	writeJSON(w, http.StatusOK, gen.SearchResults{
		Query:   imageURL,
		Results: emptySearchResults(),
	})
}

// validImageSearchURL reports whether the value satisfies the contract's
// uri format for imageUrl: an absolute http(s) URL with a host.
func validImageSearchURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return false
	}
	return u.Host != ""
}
