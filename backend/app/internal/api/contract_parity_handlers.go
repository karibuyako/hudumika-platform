package api

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/hudumika/api-backend/internal/gen"
)

// SocialLogin handles POST /auth/social
func (s *Server) SocialLogin(w http.ResponseWriter, r *http.Request) {
	s.MthSocialAuth(w, r)
}

// GetMyTwoFactorStatus handles GET /users/me/2fa
func (s *Server) GetMyTwoFactorStatus(w http.ResponseWriter, r *http.Request) {
	s.MthGet2FA(w, r)
}

// EnableMyTwoFactor handles POST /users/me/2fa
func (s *Server) EnableMyTwoFactor(w http.ResponseWriter, r *http.Request) {
	s.MthEnable2FA(w, r)
}

// DisableMyTwoFactor handles DELETE /users/me/2fa
func (s *Server) DisableMyTwoFactor(w http.ResponseWriter, r *http.Request) {
	s.MthDelete2FA(w, r)
}

// RegisterPushTokenAlias handles POST /push/tokens
func (s *Server) RegisterPushTokenAlias(w http.ResponseWriter, r *http.Request) {
	s.MthRegisterPushTokenConsumer(w, r)
}

// ListPushTokensAlias handles GET /push/tokens
func (s *Server) ListPushTokensAlias(w http.ResponseWriter, r *http.Request) {
	s.MthListPushTokens(w, r)
}

// DeletePushTokenAlias handles DELETE /push/tokens/{token}
func (s *Server) DeletePushTokenAlias(w http.ResponseWriter, r *http.Request, token string) {
	ctx := chi.NewRouteContext()
	ctx.URLParams.Add("id", token)
	ctx.URLParams.Add("token", token)
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, ctx))
	s.MthDeletePushToken(w, r)
}



// ListCuratedLists handles GET /lists
func (s *Server) ListCuratedLists(w http.ResponseWriter, r *http.Request) {
	s.MthListConsumerLists(w, r)
}

// GetCuratedList handles GET /lists/{listId}
func (s *Server) GetCuratedList(w http.ResponseWriter, r *http.Request, listId string) {
	ctx := chi.NewRouteContext()
	ctx.URLParams.Add("id", listId)
	ctx.URLParams.Add("listId", listId)
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, ctx))
	s.MthGetConsumerList(w, r)
}

// CreateTrackingShare handles POST /orders/{orderId}/tracking-share
func (s *Server) CreateTrackingShare(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID, params gen.CreateTrackingShareParams) {
	ctx := chi.NewRouteContext()
	ctx.URLParams.Add("id", orderId.String())
	ctx.URLParams.Add("orderId", orderId.String())
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, ctx))
	s.MthCreateTrackingShare(w, r)
}

// GetTrackingShare handles GET /tracking-share/{token}
func (s *Server) GetTrackingShare(w http.ResponseWriter, r *http.Request, token string) {
	ctx := chi.NewRouteContext()
	ctx.URLParams.Add("id", token)
	ctx.URLParams.Add("token", token)
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, ctx))
	s.MthGetTrackingShare(w, r)
}

// GetProvider handles GET /providers/{providerId}
func (s *Server) GetProvider(w http.ResponseWriter, r *http.Request, providerId openapi_types.UUID) {
	ctx := chi.NewRouteContext()
	ctx.URLParams.Add("id", providerId.String())
	ctx.URLParams.Add("providerId", providerId.String())
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, ctx))
	s.MthGetProviderPublic(w, r)
}

// ListPreferredProviders handles GET /providers/me/preferred
func (s *Server) ListPreferredProviders(w http.ResponseWriter, r *http.Request) {
	s.MthPreferredProviders(w, r)
}

// SetProviderPreference handles PUT /providers/{providerId}/preference
func (s *Server) SetProviderPreference(w http.ResponseWriter, r *http.Request, providerId openapi_types.UUID, params gen.SetProviderPreferenceParams) {
	ctx := chi.NewRouteContext()
	ctx.URLParams.Add("id", providerId.String())
	ctx.URLParams.Add("providerId", providerId.String())
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, ctx))
	s.MthSetProviderPreference(w, r)
}

// AddPaymentMethod handles POST /payments/methods
func (s *Server) AddPaymentMethod(w http.ResponseWriter, r *http.Request, params gen.AddPaymentMethodParams) {
	s.MthAddPaymentMethod(w, r)
}

// DeletePaymentMethod handles DELETE /payments/methods/{methodId}
func (s *Server) DeletePaymentMethod(w http.ResponseWriter, r *http.Request, methodId openapi_types.UUID) {
	ctx := chi.NewRouteContext()
	ctx.URLParams.Add("id", methodId.String())
	ctx.URLParams.Add("methodId", methodId.String())
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, ctx))
	s.MthDeletePaymentMethod(w, r)
}

// SetDefaultPaymentMethod handles PUT /payments/methods/{methodId}/default
func (s *Server) SetDefaultPaymentMethod(w http.ResponseWriter, r *http.Request, methodId openapi_types.UUID) {
	ctx := chi.NewRouteContext()
	ctx.URLParams.Add("id", methodId.String())
	ctx.URLParams.Add("methodId", methodId.String())
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, ctx))
	s.MthSetDefaultPaymentMethod(w, r)
}

// SuggestCoupon handles POST /coupons/suggest
func (s *Server) SuggestCoupon(w http.ResponseWriter, r *http.Request) {
	s.MthSuggestCoupons(w, r)
}

// GetLiveDealChat handles GET /marketing/live-deals/{dealId}/chat
func (s *Server) GetLiveDealChat(w http.ResponseWriter, r *http.Request, dealId openapi_types.UUID) {
	ctx := chi.NewRouteContext()
	ctx.URLParams.Add("id", dealId.String())
	ctx.URLParams.Add("dealId", dealId.String())
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, ctx))
	s.MthGetLiveDealChat(w, r)
}

// PostLiveDealChat handles POST /marketing/live-deals/{dealId}/chat
func (s *Server) PostLiveDealChat(w http.ResponseWriter, r *http.Request, dealId openapi_types.UUID, params gen.PostLiveDealChatParams) {
	ctx := chi.NewRouteContext()
	ctx.URLParams.Add("id", dealId.String())
	ctx.URLParams.Add("dealId", dealId.String())
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, ctx))
	s.MthPostLiveDealChat(w, r)
}

// CreateLoyaltyRedemption handles POST /loyalty/redemptions
func (s *Server) CreateLoyaltyRedemption(w http.ResponseWriter, r *http.Request, params gen.CreateLoyaltyRedemptionParams) {
	s.MthCreateLoyaltyRedemption(w, r)
}

// CreateSplit handles POST /splits
func (s *Server) CreateSplit(w http.ResponseWriter, r *http.Request, params gen.CreateSplitParams) {
	s.MthCreateSplit(w, r)
}

// GetSplit handles GET /splits/{splitId}
func (s *Server) GetSplit(w http.ResponseWriter, r *http.Request, splitId openapi_types.UUID) {
	ctx := chi.NewRouteContext()
	ctx.URLParams.Add("id", splitId.String())
	ctx.URLParams.Add("splitId", splitId.String())
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, ctx))
	s.MthGetSplit(w, r)
}

// PaySplitShare handles POST /splits/{splitId}/pay
func (s *Server) PaySplitShare(w http.ResponseWriter, r *http.Request, splitId openapi_types.UUID, params gen.PaySplitShareParams) {
	ctx := chi.NewRouteContext()
	ctx.URLParams.Add("id", splitId.String())
	ctx.URLParams.Add("splitId", splitId.String())
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, ctx))
	s.MthPaySplitShare(w, r)
}

// CompleteSplit handles POST /splits/{splitId}/complete
func (s *Server) CompleteSplit(w http.ResponseWriter, r *http.Request, splitId openapi_types.UUID, params gen.CompleteSplitParams) {
	ctx := chi.NewRouteContext()
	ctx.URLParams.Add("id", splitId.String())
	ctx.URLParams.Add("splitId", splitId.String())
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, ctx))
	s.MthCompleteSplit(w, r)
}

// GetDineInSplit handles GET /dine-in/orders/{orderId}/splits
func (s *Server) GetDineInSplit(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
	ctx := chi.NewRouteContext()
	ctx.URLParams.Add("id", orderId.String())
	ctx.URLParams.Add("orderId", orderId.String())
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, ctx))
	s.MthGetOrderSplits(w, r)
}

// CreateDineInSplit handles POST /dine-in/orders/{orderId}/splits
func (s *Server) CreateDineInSplit(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID, params gen.CreateDineInSplitParams) {
	ctx := chi.NewRouteContext()
	ctx.URLParams.Add("id", orderId.String())
	ctx.URLParams.Add("orderId", orderId.String())
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, ctx))
	s.MthCreateOrderSplit(w, r)
}

// CreateGroupOrder handles POST /group-orders
func (s *Server) CreateGroupOrder(w http.ResponseWriter, r *http.Request, params gen.CreateGroupOrderParams) {
	s.MthCreateGroupOrder(w, r)
}

// GetGroupOrder handles GET /group-orders/{groupId}
func (s *Server) GetGroupOrder(w http.ResponseWriter, r *http.Request, groupId openapi_types.UUID) {
	ctx := chi.NewRouteContext()
	ctx.URLParams.Add("id", groupId.String())
	ctx.URLParams.Add("groupId", groupId.String())
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, ctx))
	s.MthGetGroupOrder(w, r)
}

// AddGroupOrderItem handles POST /group-orders/{groupId}/items
func (s *Server) AddGroupOrderItem(w http.ResponseWriter, r *http.Request, groupId openapi_types.UUID, params gen.AddGroupOrderItemParams) {
	ctx := chi.NewRouteContext()
	ctx.URLParams.Add("id", groupId.String())
	ctx.URLParams.Add("groupId", groupId.String())
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, ctx))
	s.MthAddGroupOrderItem(w, r)
}

// RemoveGroupOrderItem handles DELETE /group-orders/{groupId}/items
func (s *Server) RemoveGroupOrderItem(w http.ResponseWriter, r *http.Request, groupId openapi_types.UUID) {
	ctx := chi.NewRouteContext()
	ctx.URLParams.Add("id", groupId.String())
	ctx.URLParams.Add("groupId", groupId.String())
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, ctx))
	s.MthRemoveGroupOrderItem(w, r)
}

// FinalizeGroupOrder handles POST /group-orders/{groupId}/finalize
func (s *Server) FinalizeGroupOrder(w http.ResponseWriter, r *http.Request, groupId openapi_types.UUID, params gen.FinalizeGroupOrderParams) {
	ctx := chi.NewRouteContext()
	ctx.URLParams.Add("id", groupId.String())
	ctx.URLParams.Add("groupId", groupId.String())
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, ctx))
	s.MthFinalizeGroupOrder(w, r)
}

// ListRedPacketsReceived handles GET /red-packets/me/received
func (s *Server) ListRedPacketsReceived(w http.ResponseWriter, r *http.Request) {
	s.MthListReceivedRedPackets(w, r)
}

// ShareRedPacket handles POST /red-packets/me/share
func (s *Server) ShareRedPacket(w http.ResponseWriter, r *http.Request, params gen.ShareRedPacketParams) {
	s.MthShareRedPacket(w, r)
}

// ClaimRedPacket handles POST /red-packets/{packetId}/claim
func (s *Server) ClaimRedPacket(w http.ResponseWriter, r *http.Request, packetId string, params gen.ClaimRedPacketParams) {
	ctx := chi.NewRouteContext()
	ctx.URLParams.Add("id", packetId)
	ctx.URLParams.Add("packetId", packetId)
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, ctx))
	s.MthClaimRedPacket(w, r)
}

// CreateDispute handles POST /disputes
func (s *Server) CreateDispute(w http.ResponseWriter, r *http.Request, params gen.CreateDisputeParams) {
	s.MthCreateDispute(w, r)
}

// ListMyDisputes handles GET /disputes/me
func (s *Server) ListMyDisputes(w http.ResponseWriter, r *http.Request) {
	s.MthListMyDisputes(w, r)
}

// GetDispute handles GET /disputes/{disputeId}
func (s *Server) GetDispute(w http.ResponseWriter, r *http.Request, disputeId openapi_types.UUID) {
	ctx := chi.NewRouteContext()
	ctx.URLParams.Add("id", disputeId.String())
	ctx.URLParams.Add("disputeId", disputeId.String())
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, ctx))
	s.MthGetDispute(w, r)
}
