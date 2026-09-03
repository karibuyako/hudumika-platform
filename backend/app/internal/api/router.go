package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/oapi-codegen/runtime"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/hudumika/api-backend/internal/audit"
	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
)

// uuidParam reads a {uuid} path segment the same way the generated chi-server
// wrapper does, returning the contract openapi_types.UUID.
func uuidParam(r *http.Request, name string) openapi_types.UUID {
	var u openapi_types.UUID
	_ = runtime.BindStyledParameterWithOptions("simple", name, chi.URLParam(r, name), &u,
		runtime.BindStyledParameterOptions{ParamLocation: runtime.ParamLocationPath, Required: true, Type: "string", Format: "uuid"})
	return u
}

// Per-IP verification budgets (AUTH.md: verification is rate-limited per IP
// and per destination).
const (
	verifyRateLimitIP  int64 = 20
	verifyRateWindowIP       = time.Minute
)

func stripApiV1Prefix(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/v1/") {
			r.URL.Path = strings.TrimPrefix(r.URL.Path, "/api/v1")
			if r.URL.Path == "" {
				r.URL.Path = "/"
			}
		} else if r.URL.Path == "/api/v1" {
			r.URL.Path = "/"
		}
		next.ServeHTTP(w, r)
	})
}

// authedRouter builds the auth-wrapped sub-tree (RequireAuth + Idempotency +
// audit + every contract route). It is shared between the public Router()
// and the /internal/ai/* bridge so the Jibu-driven surface mounts the
// exact same handlers with the exact same safety nets. Built lazily and
// cached on the server.
func (s *Server) authedRouter() http.Handler {
	s.authedOnce.Do(func() {
		s.authed = s.buildAuthedRouter()
	})
	return s.authed
}

// bridgeRouter returns the same authed surface as authedRouter() but
// strips the /internal/ai prefix from the request path before forwarding,
// so the Jibu bridge receives paths like /orders instead of
// /internal/ai/orders. It does NOT re-run RequireAuth — claims are
// already injected by internalKeyMiddleware.
func (s *Server) bridgeRouter() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Clone so we don't mutate the caller's request struct.
		clone := r.Clone(r.Context())
		clone.URL.Path = stripApiV1Path(clone.URL.Path)
		if clone.URL.Path == "" {
			clone.URL.Path = "/"
		}
		s.authedRouter().ServeHTTP(w, clone)
	})
}

// stripApiV1Path removes the /internal/ai prefix used by the Jibu bridge
// so the authed router's chi routes match the contract paths.
func stripApiV1Path(p string) string {
	const prefix = "/internal/ai"
	if len(p) >= len(prefix) && p[:len(prefix)] == prefix {
		return p[len(prefix):]
	}
	return p
}

func (s *Server) buildAuthedRouter() http.Handler {
	r := chi.NewRouter()
	r.Use(s.Idempotency)
	if s.db != nil {
		r.Use(audit.NewMiddleware(audit.NewPg(s.db.Pool()), s.logger, func(ctx context.Context) (string, string) {
			if c, ok := ClaimsFromContext(ctx); ok {
				subject := c.Subject
				if _, err := uuid.Parse(subject); err != nil && subject != "" {
					if user, uerr := auth.NewRepo(s.db.Pool()).GetUserByPhone(ctx, subject); uerr == nil && user != nil {
						subject = user.ID.String()
					} else if uerr != nil {
						s.logger.Warn("audit actor resolve failed", "subject", c.Subject, "error", uerr)
					}
				}
				return subject, c.Role
			}
			return "", ""
		}).Handler)
	}
	s.mountAuthedRoutes(r)
	return r
}

// mountAuthedRoutes attaches every authenticated handler to r — the same
// tree previously inline in Router() so the Jibu /internal/ai bridge can
// reuse it without recursion.
func (s *Server) mountAuthedRoutes(r chi.Router) {
	r.Get("/admin/webhooks/deliveries", s.withAdminSecurity(s.AdminListWebhookDeliveries))
	r.Post("/admin/webhooks/deliveries/{deliveryId}/retry", s.withAdminSecurity(s.AdminRetryWebhookDelivery))
	r.Post("/integrations", s.CreateIntegration)
	r.Post("/admin/conversations/{conversationId}/block", s.withAdminSecurity(func(w http.ResponseWriter, rq *http.Request) {
		s.BlockConversation(w, rq, uuidParam(rq, "conversationId"))
	}))
	r.Get("/admin/sessions", s.AdminListSessions)
	r.Delete("/admin/sessions/{sessionId}", func(w http.ResponseWriter, rq *http.Request) {
		s.AdminRevokeSession(w, rq, uuidParam(rq, "sessionId"))
	})
	r.Post("/admin/sessions/revoke-all", s.AdminRevokeAllSessions)
	r.Get("/admin/audit-log", s.AdminListAuditLog)
	r.Get("/admin/limits", s.AdminGetLimits)
	r.Post("/sync/batch", s.SyncCustomerBatch)

	r.Route("/stores/{storeId}", func(r chi.Router) {
		r.Get("/qr-codes", s.ListStoreQrCodes)
		r.Post("/qr-codes", s.CreateStoreQrCode)
		r.Delete("/qr-codes/{qrCodeId}", func(w http.ResponseWriter, rq *http.Request) {
			s.DeleteStoreQrCode(w, rq, uuidParam(rq, "qrCodeId"))
		})
		r.Get("/qualifications", s.ListQualifications)
		r.Post("/qualifications", s.UploadQualification)
		r.Get("/menu", s.ListMenus)
		r.Post("/menu", s.CreateMenu)
		r.Patch("/menu/{menuId}", func(w http.ResponseWriter, rq *http.Request) {
			s.UpdateMenu(w, rq, uuidParam(rq, "menuId"))
		})
		r.Delete("/menu/{menuId}", func(w http.ResponseWriter, rq *http.Request) {
			s.DeleteMenu(w, rq, uuidParam(rq, "menuId"))
		})
		r.Get("/kitchen-camera", s.GetKitchenCamera)
		r.Put("/kitchen-camera", s.UpdateKitchenCamera)
		r.Get("/self-pickup", s.GetSelfPickupConfig)
		r.Put("/self-pickup", s.PutSelfPickupConfig)
		r.Get("/receipt-templates", s.ListReceiptTemplates)
		r.Post("/receipt-templates", s.CreateReceiptTemplate)
		r.Put("/receipt-templates/{templateId}", func(w http.ResponseWriter, rq *http.Request) {
			s.UpdateReceiptTemplate(w, rq, uuidParam(rq, "templateId"))
		})
		r.Delete("/receipt-templates/{templateId}", func(w http.ResponseWriter, rq *http.Request) {
			s.DeleteReceiptTemplate(w, rq, uuidParam(rq, "templateId"))
		})
		r.Post("/receipt-templates/{templateId}/activate", func(w http.ResponseWriter, rq *http.Request) {
			s.ActivateReceiptTemplate(w, rq, uuidParam(rq, "templateId"))
		})
		r.Get("/payment-accounts", s.ListStorePaymentAccounts)
		r.Post("/payment-accounts", s.CreateStorePaymentAccount)
		r.Delete("/payment-accounts/{accountId}", func(w http.ResponseWriter, rq *http.Request) {
			s.DeleteStorePaymentAccount(w, rq, uuidParam(rq, "accountId"))
		})
		r.Post("/payment-accounts/{accountId}/verify", func(w http.ResponseWriter, rq *http.Request) {
			s.VerifyStorePaymentAccount(w, rq, uuidParam(rq, "accountId"))
		})
		r.Get("/logs", func(w http.ResponseWriter, rq *http.Request) {
			s.GetStoreLogs(w, rq, gen.GetStoreLogsParams{})
		})
		r.Post("/compliance/recheck", s.RequestComplianceRecheck)
		r.Get("/settings", s.GetMyStoreSettings)
		r.Put("/settings", s.UpdateMyStoreSettings)
		r.Get("/violations", s.ListStoreViolations)
		r.Get("/dual-screen", s.MthGetStoreDualScreen)
		r.Patch("/dual-screen", s.MthUpdateStoreDualScreenReal)
		r.Get("/qr-ordering", s.MthGetStoreQrOrdering)
		r.Patch("/qr-ordering", s.MthUpdateStoreQrOrderingReal)
		r.Get("/", s.MthGetStoreReal)

		r.Get("/compliance", s.MthGetStoreCompliance)
		r.Get("/export", s.MthExportStoreOrders)
	})

	r.Get("/analytics/overview", s.MthAnalyticsOverview)
	r.Get("/campaigns/{id}/performance", s.MthGetCampaignPerformance)
	r.Post("/campaigns/{id}/stop", s.MthStopCampaignReal)
	r.Get("/chat/threads", s.MthListChatThreads)
	r.Get("/closure/status", s.MthGetClosureStatusReal)
	r.Post("/coupons/suggest", s.MthSuggestCoupons)
	r.Get("/coupon-suggest", s.MthGetCouponSuggest)
	r.Get("/export/orders", s.MthExportOrders)
	r.Post("/export/orders", s.MthExportOrders)
	r.Get("/customer-memberships/me", s.MthListCustomerMemberships)
	r.Post("/dual-screen/pair", s.MthPairDualScreenReal)
	r.Get("/finance/dispute-holds", s.MthListDisputeHoldsReal)
	r.Get("/finance/revenue-composition", s.MthGetRevenueComposition)
	r.Get("/invoices", s.MthListInvoicesReal)
	r.Post("/members/{id}/redeem", s.MthRedeemLoyaltyMemberReal)
	r.Get("/marketing/coupons", s.MthListMarketingCouponsReal)
	r.Post("/loyalty/redemptions", s.MthCreateLoyaltyRedemptionReal)
	r.Get("/payment-accounts", s.MthListPaymentAccounts)
	r.Patch("/payment-accounts/{id}", s.MthUpdatePaymentAccountReal)
	r.Get("/receipt-templates/active", s.MthGetActiveReceiptTemplate)
	r.Get("/redemptions", s.MthListRedemptionsReal)
	r.Post("/redemptions", s.MthCreateRedemptionReal)
	r.Post("/supplier-returns/{id}/process", s.MthProcessSupplierReturnReal)
	r.Post("/supplier-returns/{id}/reject", s.MthRejectSupplierReturnReal)
	r.Post("/tables/{id}/qr", s.MthTableQrReal)
	r.Post("/tasks/{id}/complete", s.MthCompleteTaskReal)
	r.Get("/webhooks/{id}/test", s.MthTestWebhook)
	r.Post("/dine-in/reservations/{id}/confirm", s.MthConfirmReservationReal)
	r.Get("/privacy/export/{id}", s.MthPrivacyExportReal)
	r.Get("/printers", s.MthListPrintersReal)
	r.Post("/printers", s.MthCreatePrinterReal)
	r.Get("/printers/{id}", s.MthGetPrinterReal)
	r.Patch("/printers/{id}", s.MthUpdatePrinterReal)
	r.Delete("/printers/{id}", s.MthDeletePrinterReal)
	r.Post("/printers/{id}/connect", s.MthConnectPrinterReal)
	r.Post("/printers/{id}/test", s.MthTestPrinterReal)
	r.Get("/products", s.MthListProductsReal)
	r.Post("/products", s.MthCreateProductReal)
	r.Get("/stores", s.MthListStoresReal)
	r.Patch("/journeys/{id}", s.MthUpdateJourneyReal)
	r.Post("/dine-in/orders/{id}/request-bill", s.MthRequestBillReal)
	r.Post("/refunds/{refundId}/decide", s.MthDecideRefundReal)

	r.Get("/staff", s.MthListStaff)

	r.Get("/users/me/2fa", s.MthGet2FA)
	r.Post("/users/me/2fa", s.MthEnable2FA)
	r.Delete("/users/me/2fa", s.MthDelete2FA)
	r.Delete("/favorites/lists/{id}", s.MthDeleteFavoriteList)
	r.Post("/favorites/lists/{id}/merchants", s.MthAddFavoriteMerchant)
	r.Delete("/favorites/lists/{id}/merchants/{merchantId}", s.MthRemoveFavoriteMerchant)
	r.Get("/lists", s.MthListConsumerLists)
	r.Get("/lists/{id}", s.MthGetConsumerList)
	r.Post("/group-orders", s.MthCreateGroupOrder)
	r.Get("/group-orders/{id}", s.MthGetGroupOrder)
	r.Post("/group-orders/{id}/items", s.MthAddGroupOrderItem)
	r.Delete("/group-orders/{id}/items", s.MthRemoveGroupOrderItem)
	r.Post("/group-orders/{id}/finalize", s.MthFinalizeGroupOrder)
	r.Get("/disputes/me", s.MthListMyDisputes)
	r.Post("/disputes", s.MthCreateDispute)
	r.Get("/disputes/{id}", s.MthGetDispute)
	r.Get("/dine-in/orders/{id}/splits", s.MthGetOrderSplits)
	r.Post("/dine-in/orders/{id}/splits", s.MthCreateOrderSplit)
	r.Get("/splits/{id}", s.MthGetSplit)
	r.Get("/red-packets/me/received", s.MthListReceivedRedPackets)
	r.Post("/red-packets/me/share", s.MthShareRedPacket)
	r.Get("/tracking-share/{id}", s.MthGetTrackingShare)
	r.Post("/orders/{id}/tracking-share", s.MthCreateTrackingShare)

	r.Get("/bus/routes", s.ListBusRoutes)
	r.Get("/bus/routes/{routeId}", func(w http.ResponseWriter, rq *http.Request) {
		s.GetBusRoute(w, rq, uuidParam(rq, "routeId"))
	})
	r.Get("/bus/routes/{routeId}/vehicles", func(w http.ResponseWriter, rq *http.Request) {
		s.GetBusRouteVehicles(w, rq, uuidParam(rq, "routeId"))
	})
	r.Get("/bus/vehicles/{vehicleId}", func(w http.ResponseWriter, rq *http.Request) {
		s.GetBusVehicle(w, rq, uuidParam(rq, "vehicleId"))
	})
	r.Get("/bus/reminders", s.ListBusReminders)
	r.Post("/bus/reminders", s.CreateBusReminder)

	r.Get("/bikes/nearby", s.ListNearbyBikes)
	r.Get("/bikes/{bikeId}", func(w http.ResponseWriter, rq *http.Request) {
		s.GetBike(w, rq, uuidParam(rq, "bikeId"))
	})
	r.Get("/bikes/rides/active", s.GetActiveBikeRide)
	r.Post("/bikes/unlock", s.UnlockBike)
	r.Post("/bikes/rides/{rideId}/lock", func(w http.ResponseWriter, rq *http.Request) {
		s.LockBikeRide(w, rq, uuidParam(rq, "rideId"))
	})
	r.Post("/bikes/rides/{rideId}/unlock", func(w http.ResponseWriter, rq *http.Request) {
		s.UnlockBikeRide(w, rq, uuidParam(rq, "rideId"))
	})
	r.Post("/bikes/rides/{rideId}/finish", func(w http.ResponseWriter, rq *http.Request) {
		s.FinishBikeRide(w, rq, uuidParam(rq, "rideId"))
	})
	r.Post("/bikes/rides/{rideId}/pay", func(w http.ResponseWriter, rq *http.Request) {
		s.PayBikeRide(w, rq, uuidParam(rq, "rideId"))
	})
	r.Get("/bikes/rides/me", s.ListMyBikeRides)
	r.Get("/bikes/rides/{rideId}", func(w http.ResponseWriter, rq *http.Request) {
		s.GetBikeRide(w, rq, uuidParam(rq, "rideId"))
	})

	r.Post("/rides/estimate", s.EstimateRide)
	r.Post("/rides", s.CreateRide)
	r.Get("/rides/me", s.ListMyRides)
	r.Get("/rides/{rideId}", func(w http.ResponseWriter, rq *http.Request) {
		s.GetRide(w, rq, uuidParam(rq, "rideId"))
	})
	r.Post("/rides/{rideId}/cancel", func(w http.ResponseWriter, rq *http.Request) {
		s.CancelRide(w, rq, uuidParam(rq, "rideId"))
	})
	r.Delete("/payments/methods/{id}", s.MthDeletePaymentMethod)
	r.Post("/payments/methods", s.MthAddPaymentMethod)
	r.Get("/push/tokens", s.MthListPushTokens)
	r.Post("/push/tokens", s.MthRegisterPushTokenConsumer)
	r.Delete("/push/tokens/{id}", s.MthDeletePushToken)
	r.Get("/home/recommendations", s.MthHomeRecommendations)
	r.Get("/marketing/live-deals/{id}/chat", s.MthGetLiveDealChat)
	r.Post("/marketing/live-deals/{id}/chat", s.MthPostLiveDealChat)

	r.Get("/favorites/lists", s.MthListFavoriteLists)
	r.Post("/favorites/lists", s.MthCreateFavoriteList)
	r.Get("/delivery-providers", s.MthListDeliveryProviders)
	r.Get("/providers/available", s.MthListProvidersAvailable)
	r.Get("/providers/me/preferred", s.MthPreferredProviders)
	r.Get("/providers/{id}", s.MthGetProviderPublic)
	r.Put("/providers/{id}/preference", s.MthSetProviderPreference)
	r.Post("/search/history", s.RecordSearchHistory)
	r.Get("/search/image", s.SearchImageGet)
	r.Get("/search/voice", s.SearchVoiceGet)
	r.Put("/payments/methods/{id}/default", s.MthSetDefaultPaymentMethod)
	r.Post("/red-packets/{id}/claim", s.MthClaimRedPacket)
	r.Post("/splits", s.MthCreateSplit)
	r.Post("/splits/{id}/pay", s.MthPaySplitShare)
	r.Post("/splits/{id}/complete", s.MthCompleteSplit)
	r.Get("/bookings/{id}/invoice", func(w http.ResponseWriter, rq *http.Request) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No invoice available for this booking")
	})
	r.Get("/bookings/{id}/warranty", func(w http.ResponseWriter, rq *http.Request) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No warranty available for this booking")
	})
	r.Get("/bookings/{id}/proof-of-service", func(w http.ResponseWriter, rq *http.Request) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No proof of service available for this booking")
	})

	r.Get("/orders", s.MthListOrders)
	r.Get("/orders/estimate", s.EstimateOrder)
	r.Post("/orders/{id}/refund", func(w http.ResponseWriter, rq *http.Request) {
		s.MthCreateOrderRefund(w, rq, uuidParam(rq, "id"))
	})
	r.Post("/orders/{id}/cod-collect", func(w http.ResponseWriter, rq *http.Request) {
		s.CollectCOD(w, rq, uuidParam(rq, "id"))
	})
	r.Post("/orders/me/advance", s.AdvanceMyOrder)
	r.Post("/riders/me/shifts", s.createRiderShift)

	gen.HandlerWithOptions(s, gen.ChiServerOptions{
		BaseRouter: r,
		ErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
			var reqErr *gen.RequiredParamError
			if errors.As(err, &reqErr) {
				writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", reqErr.ParamName+" is required")
				return
			}
			var fmtErr *gen.InvalidParamFormatError
			if errors.As(err, &fmtErr) {
				writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", fmtErr.ParamName+" is invalid")
				return
			}
			http.Error(w, err.Error(), http.StatusBadRequest)
		},
	})

	r.Get("/dine-in/tables/{tableId}", func(w http.ResponseWriter, rq *http.Request) {
		s.GetDineInTable(w, rq, uuidParam(rq, "tableId"))
	})
	r.Post("/dine-in/tables/{tableId}/qr", func(w http.ResponseWriter, rq *http.Request) {
		s.GetDineInTableQr(w, rq, uuidParam(rq, "tableId"))
	})

	r.Get("/payments/methods", s.MthListPaymentMethods)
	r.Post("/payments/methods", s.MthAddPaymentMethod)
	r.Delete("/payments/methods/{id}", s.MthDeletePaymentMethod)
	r.Put("/payments/methods/{id}/default", s.MthSetDefaultPaymentMethod)

	r.Get("/providers", s.MthListProvidersConsumer)

	r.Post("/analytics/reports/export", s.MthExportAnalyticsReportReal)
	r.Post("/chain/reports", s.MthExportChainReportReal)

	r.Post("/admin/dispatch/nearest-rider", s.AdminFindNearestRiders)
	r.Post("/admin/dispatch/optimize-routes", s.AdminOptimizeRoutes)
	r.Post("/admin/dispatch/service-area", s.AdminCalculateServiceArea)
	// Rider self-grab (POST /dispatch/available-orders/{orderId}/accept):
	// rider-role only; the grab-mode counterpart to the staff manual
	// override. Like the neighbouring GET /dispatch/available-orders feed
	// (contract, served via the generated tree below) it sits outside the
	// /admin/* staff policy so rider sessions reach it.
	r.Post("/dispatch/available-orders/{orderId}/accept", s.GrabAvailableOrder)

	r.With(s.RequireABAC("bookings", "refund")).Post("/refunds/{refundId}/decision", func(w http.ResponseWriter, rq *http.Request) {
		s.AdminRefundDecision(w, rq, uuidParam(rq, "refundId"))
	})
	r.With(s.RequireABAC("disputes", "resolve")).Post("/disputes/{disputeId}/decision", func(w http.ResponseWriter, rq *http.Request) {
		s.AdminDisputeDecision(w, rq, uuidParam(rq, "disputeId"))
	})
	r.With(s.RequireABAC("payroll", "run")).Post("/payroll/run", s.AdminRunPayroll)
	r.With(s.RequireABAC("payouts", "reconcile")).Post("/payouts/{batchId}/reconcile", func(w http.ResponseWriter, rq *http.Request) {
		s.AdminPayoutReconcile(w, rq, uuidParam(rq, "batchId"))
	})
	r.With(s.RequireABAC("admins", "suspend")).Post("/admins/{adminId}/suspend", func(w http.ResponseWriter, rq *http.Request) {
		s.AdminSuspendAdmin(w, rq, uuidParam(rq, "adminId"))
	})

	r.Post("/bookings/{id}/resume", func(w http.ResponseWriter, rq *http.Request) {
		s.ResumeBooking(w, rq, uuidParam(rq, "id"))
	})
	r.Post("/providers/me/kyc/verify", s.VerifyProviderKyc)

	// PUT /providers/me/service-plans/{planId} is a manual extension (the
	// contract only declares the collection GET/POST): same provider
	// scoping as the collection handlers, 404 PLAN_NOT_FOUND when foreign.
	r.Put("/providers/me/service-plans/{planId}", func(w http.ResponseWriter, rq *http.Request) {
		s.UpdateProviderServicePlan(w, rq, uuidParam(rq, "planId"))
	})

	// Jibu AI bridge (POST /notifications): server-side notification
	// creation endpoint mounted here so Jibu can push proactive messages.
	r.Post("/notifications", s.CreateNotification)
}

func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(stripApiV1Prefix)
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(s.otelMiddleware)
	r.Use(s.metricsMiddleware)
	r.Use(s.logRequests)
	r.Use(s.structuredLogger.HandlerMiddleware)
	r.Use(s.cors)
	r.Use(SecurityHeaders)

	r.Get("/metrics", s.metrics)
	r.Get("/healthz", s.health)
	r.Get("/readyz", s.ready)

	// Detailed health check (no auth required): database, redis, disk, memory,
	// and degradation level. Sits outside the auth-wrapped tree so load
	// balancers and uptime probes can reach it unauthenticated.
	r.Get("/admin/health", s.AdminHealthCheck)

	// /ws (contract /api/ws after the gateway strips the /api/v1 base path)
	// is deliberately outside the auth-wrapped tree: the handler authenticates
	// itself (Authorization bearer or ?token=) before upgrading, so the 401
	// envelope can be a plain JSON response instead of a failed handshake.
	r.Get("/ws", s.HandleWebSocket)
	r.Get("/admin/ws", s.AdminWSHandler)

	// /docs/* is the public developer surface (customer_sync.go): the
	// contract spec (served raw with Content-Type application/yaml — the
	// bytes are the embedded spec JSON) and a minimal HTML index of the
	// top-level resource groups. Both sit outside the auth-wrapped tree and
	// are named in isPublicPath (auth.go) so the generated fallback and any
	// auth audit keep seeing them as public.
	r.Get("/docs", s.GetDocs)
	r.Get("/docs/openapi.yaml", s.GetOpenAPISpec)

	// /internal/* is the staging-only customer simulator (ARCHITECTURE.md).
	// It sits OUTSIDE the auth-wrapped tree: every flow mints its own
	// customer/merchant sessions through the server's mint path. The
	// simulatorGate answers 403 FORBIDDEN unless SIMULATOR_KEY is set
	// (staging/dev only; never production) and the x-internal-key header
	// matches.
	r.Route("/internal", func(r chi.Router) {
		r.Use(s.simulatorGate)
		r.Post("/simulate/order", s.SimulateOrderFlow)
		r.Post("/simulate/chat", s.SimulateChatFlow)
		r.Post("/simulate/rush", s.SimulateRushFlow)
	})

	// /internal/ai/* is the Jibu AI microservice bridge (JIBU_INTERNAL_KEY).
	// It sits OUTSIDE the auth-wrapped tree: the internalKeyMiddleware
	// verifies the static key, resolves a real user from X-Internal-User-Phone,
	// and injects claims so every handler treats the request as an
	// authenticated user session for the requested role. The route is
	// fail-closed in production (no JIBU_INTERNAL_KEY env → 403).
	r.Route("/internal/ai", func(r chi.Router) {
		r.Use(s.internalKeyMiddleware)
		// Jibu proactive push: real-time fan-out to connected WS clients.
		r.Post("/events", s.EmitEvent)
		// Forward every other contract path to the auth-wrapped surface
		// (the same tree the public Router() mounts). This is the SAME
		// handler chain — RequireAuth is skipped because claims are
		// already injected by internalKeyMiddleware above.
		r.Mount("/", s.bridgeRouter())
	})

	r.Route("/auth", func(r chi.Router) {
		r.With(s.loginThrottler.Middleware).Post("/request-otp", s.RequestOtp)
		r.With(s.loginThrottler.Middleware, s.rateLimitIP("verify-otp", verifyRateLimitIP, verifyRateWindowIP)).Post("/verify-otp", s.VerifyOtp)
		r.Post("/refresh", s.RefreshToken)
		r.Post("/logout", s.Logout)
		r.Post("/social", s.MthSocialAuth)
		// TOTP two-factor extension (twofa.go, API-CONTRACT.yaml /auth/2fa/*):
		// a documented manual extension like the push-token registry and
		// /sync/batch. Unlike the neighbouring /auth routes (tokens in body)
		// these authenticate with the ACCESS token, so they ride the same
		// RequireAuth wrapper the generated tree uses.
		r.Route("/2fa", func(r chi.Router) {
			r.Use(s.RequireAuth)
			r.Get("/enroll", s.TwoFaEnroll)
			r.Post("/verify", s.TwoFaVerify)
			r.Post("/verify-for-session", s.TwoFaVerifyForSession)
			r.Post("/disable", s.TwoFaDisable)
			r.Post("/recovery", s.TwoFaRecovery)
		})
		// Contract /auth paths without a manual handler (e.g.
		// /auth/change-password) fall through to the generated interface so
		// they answer the NOT_IMPLEMENTED envelope instead of a blank 404.
		// The route context is reset because the parent subrouter already
		// stripped the /auth prefix from RoutePath.
		fallback := chi.NewRouter()
		gen.HandlerFromMux(s, fallback)
		r.NotFound(func(w http.ResponseWriter, r *http.Request) {
			ctx := context.WithValue(r.Context(), chi.RouteCtxKey, chi.NewRouteContext())
			fallback.ServeHTTP(w, r.WithContext(ctx))
		})
	})

	r.Route("/", func(r chi.Router) {
		r.Use(s.RequireAuth)
		// The full auth-wrapped surface (every contract route + manual
		// extensions) is built once in buildAuthedRouter() and shared
		// with the /internal/ai/* Jibu bridge so the same handlers +
		// safety nets run for both surfaces.
		r.Mount("/", s.authedRouter())
	})

	return r
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "time": time.Now().UTC().Format(time.RFC3339)})
}

// rateLimitIP enforces a fixed-window per-IP budget on a route group via the
// shared Redis-backed limiter (in-memory in tests). On store failure the
// request passes through (log + degrade, never break the request). The
// X-RateLimit-* trio rides both the 429 and the success response: the
// window budget, what this window has left, and the unix second the window
// resets (RetryAfter on denial, the end of the window on success).
func (s *Server) rateLimitIP(action string, limit int64, window time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			now := time.Now()
			decision, err := s.stores.Rate.Allow(r.Context(), "ip:"+clientIP(r), limit, window, now)
			if err != nil {
				s.logger.Error("rate limit store failed", "action", action, "error", err)
				next.ServeHTTP(w, r)
				return
			}
			if !decision.Allowed {
				s.logger.Warn("ip rate limited", "action", action, "ip", clientIP(r))
				writeRateLimitHeaders(w, limit, 0, decision.RetryAfter)
				writeErrorWithRetry(w, http.StatusTooManyRequests, "RATE_LIMITED", "Too many requests", int(decision.RetryAfter.Seconds()))
				return
			}
			writeRateLimitHeaders(w, limit, rateLimitRemaining(decision, limit), window)
			next.ServeHTTP(w, r)
		})
	}
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		for _, part := range strings.Split(xff, ",") {
			if ip := strings.TrimSpace(part); ip != "" {
				return ip
			}
		}
	}
	return r.RemoteAddr
}

// ready is the deploy gate: it returns 503 when any configured dependency
// (PostgreSQL, Redis) is down — or when nothing is configured at all. When a
// dependency is not configured it is not part of readiness in development.
func (s *Server) ready(w http.ResponseWriter, r *http.Request) {
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		bad     []string
		checked bool
	)
	check := func(name string, fn func() error) {
		checked = true
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := fn(); err != nil {
				mu.Lock()
				bad = append(bad, name)
				mu.Unlock()
			}
		}()
	}

	if s.db != nil {
		check("postgres", func() error { return s.db.Ping(r.Context()) })
	}
	if s.stores != nil && s.stores.Redis != nil {
		check("redis", func() error { return s.stores.Redis.Ping(r.Context()) })
	}
	wg.Wait()

	if !checked {
		// No dependency configured: the process is not ready to serve.
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"status": "unavailable",
			"down":   []string{"no dependencies configured"},
		})
		return
	}
	if len(bad) > 0 {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"status": "unavailable",
			"down":   bad,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		// The generated Unimplemented handlers answer 501 with an empty body;
		// fill the envelope only then. Handlers that already wrote their own
		// 501 body (e.g. a 501 for a missing dependency) must not be doubled.
		if ww.Status() == http.StatusNotImplemented && ww.BytesWritten() == 0 {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			_ = json.NewEncoder(w).Encode(gen.ErrorResponse{
				Code:      "NOT_IMPLEMENTED",
				Message:   "This endpoint is defined in the contract but not implemented yet",
				RequestId: newUUID(newRequestID()),
			})
		}
		s.logger.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", ww.Status(),
			"duration_ms", time.Since(start).Milliseconds(),
			"request_id", middleware.GetReqID(r.Context()),
		)
	})
}

func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if s.allowsOrigin(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, X-Request-Id, x-request-id, X-Country, x-country, X-City, x-city, X-City-Id, x-city-id")
			w.Header().Set("Access-Control-Max-Age", "86400")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) allowsOrigin(origin string) bool {
	for _, o := range s.cfg.CORSOrigins {
		if o == "*" || o == origin {
			return true
		}
	}
	return false
}

func (s *Server) withAdminSecurity(next http.HandlerFunc) http.HandlerFunc {
	var allowedIPs []string
	if s.cfg.AdminAllowedIPs != "" {
		for _, ip := range splitAndTrim(s.cfg.AdminAllowedIPs) {
			if ip != "" {
				allowedIPs = append(allowedIPs, ip)
			}
		}
	}
	ipCheck := IPAllowlist(allowedIPs)
	rateCheck := RateLimit(s.rateLimiter)
	return func(w http.ResponseWriter, r *http.Request) {
		handler := http.Handler(http.HandlerFunc(next))
		handler = rateCheck(handler)
		handler = ipCheck(handler)
		handler.ServeHTTP(w, r)
	}
}

func splitAndTrim(s string) []string {
	var result []string
	for _, part := range strings.Split(s, ",") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}
