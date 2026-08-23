package api

import (
	"encoding/json"
	"errors"
	"net/http"

	openapi_types "github.com/oapi-codegen/runtime/types"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/gen"
)

// ---------- CURATED LISTS (Meituan 必吃榜-lite) ----------

func (s *Server) MthListConsumerLists(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, title_key, tagline_key, merchant_ids
		 FROM curated_lists ORDER BY created_at DESC`)
	if err != nil {
		s.logger.Error("list curated lists failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]gen.CuratedList, 0)
	for rows.Next() {
		var (
			id          uuid.UUID
			titleKey    string
			taglineKey  string
			merchantIDs json.RawMessage
		)
		if err := rows.Scan(&id, &titleKey, &taglineKey, &merchantIDs); err != nil {
			s.logger.Error("scan curated list failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		list := gen.CuratedList{
			Id:         id.String(),
			TitleKey:   titleKey,
			TaglineKey: taglineKey,
		}
		if len(merchantIDs) > 0 && string(merchantIDs) != "null" {
			var ids []openapi_types.UUID
			if err := json.Unmarshal(merchantIDs, &ids); err != nil {
				s.logger.Error("unmarshal curated list merchant_ids failed", "error", err)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
				return
			}
			list.MerchantIds = ids
		}
		out = append(out, list)
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate curated lists failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) MthGetConsumerList(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	listID, ok := mthParamUUID(r, "id")
	if !ok {
		// also accept listId param name
		listID, ok = mthParamUUID(r, "listId")
		if !ok {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id is required")
			return
		}
	}
	var (
		id          uuid.UUID
		titleKey    string
		taglineKey  string
		merchantIDs json.RawMessage
	)
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT id, title_key, tagline_key, merchant_ids
		 FROM curated_lists WHERE id=$1`, listID).Scan(&id, &titleKey, &taglineKey, &merchantIDs)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Curated list not found")
		return
	}
	if err != nil {
		s.logger.Error("get curated list failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	list := gen.CuratedList{
		Id:         id.String(),
		TitleKey:   titleKey,
		TaglineKey: taglineKey,
	}
	if len(merchantIDs) > 0 && string(merchantIDs) != "null" {
		var ids []openapi_types.UUID
		if err := json.Unmarshal(merchantIDs, &ids); err != nil {
			s.logger.Error("unmarshal curated list merchant_ids failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		list.MerchantIds = ids
	}
	writeJSON(w, http.StatusOK, list)
}
