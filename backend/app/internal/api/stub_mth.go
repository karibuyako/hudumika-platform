package api

import (
	"net/http"

	"github.com/google/uuid"
)

// Stubs for router.go references missing implementations.
// Makes go vet pass at HEAD 66fc58b.
func (s *Server) MthAddFavoriteMerchant(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthAddGroupOrderItem(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthAddPaymentMethod(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthAnalyticsOverview(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthClaimRedPacket(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthCompleteSplit(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthCompleteTask(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthConfirmReservation(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthConnectPrinter(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthCreateDispute(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthCreateFavoriteList(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthCreateGroupOrder(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthCreateLoyaltyRedemption(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthCreateOrderRefund(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthCreateOrderSplit(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthCreatePrinter(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthCreateRedemption(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthCreateSplit(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthCreateTrackingShare(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthDelete2FA(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthDeleteFavoriteList(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthDeletePaymentMethod(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthDeletePrinter(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthDeletePushToken(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthEnable2FA(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthExportOrders(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthExportStoreOrders(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthFinalizeGroupOrder(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthGet2FA(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthGetActiveReceiptTemplate(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthGetCampaignPerformance(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthGetClosureStatus(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthGetConsumerList(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthGetCouponSuggest(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthGetGroupOrder(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthGetLiveDealChat(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthGetOrderSplits(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthGetPrinter(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthGetProviderPublic(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthGetRevenueComposition(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthGetSplit(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthGetStoreCompliance(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthGetStoreDualScreen(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthGetStoreQrOrdering(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthGetTrackingShare(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthHomeRecommendations(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthListChatThreads(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthListConsumerLists(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthListCustomerMemberships(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthListDeliveryProviders(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthListDisputeHolds(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthListFavoriteLists(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthListInvoices(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthListMarketingCoupons(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthListMyDisputes(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthListOrders(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthListPaymentAccounts(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthListPaymentMethods(w http.ResponseWriter, r *http.Request) {
	s.ListPaymentMethods(w, r)
}
func (s *Server) MthListPrinters(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthListProvidersAvailable(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthListProvidersConsumer(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthListPushTokens(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthListReceivedRedPackets(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthListRedemptions(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthListStaff(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthPairDualScreen(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthPaySplitShare(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthPostLiveDealChat(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthPreferredProviders(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthPrivacyExport(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthProcessSupplierReturn(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthRedeemLoyaltyMember(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthRegisterPushTokenConsumer(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthRejectSupplierReturn(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthRemoveFavoriteMerchant(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthRemoveGroupOrderItem(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthSetDefaultPaymentMethod(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthSetProviderPreference(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthShareRedPacket(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthSocialAuth(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthStopCampaign(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthSuggestCoupons(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthTableQr(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthTestPrinter(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthTestWebhook(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthUpdatePaymentAccount(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthUpdatePrinter(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthUpdateStoreDualScreen(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) MthUpdateStoreQrOrdering(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) RecordSearchHistory(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) SearchImageGet(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) SearchVoiceGet(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
func (s *Server) CollectCOD(w http.ResponseWriter, r *http.Request, id uuid.UUID) {
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "not implemented")
}
