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

func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	// otel must sit above metrics so the span covers the recorded request,
	// and both above logRequests so they see the final status. /healthz and
	// /readyz run through the same chain: they are real requests and their
	// status is load-balancer signal worth alerting on (MONITORING.md).
	r.Use(s.otelMiddleware)
	r.Use(s.metricsMiddleware)
	r.Use(s.logRequests)
	r.Use(s.cors)

	r.Get("/metrics", s.metrics)
	r.Get("/healthz", s.health)
	r.Get("/readyz", s.ready)

	// /ws (contract /api/ws after the gateway strips the /api/v1 base path)
	// is deliberately outside the auth-wrapped tree: the handler authenticates
	// itself (Authorization bearer or ?token=) before upgrading, so the 401
	// envelope can be a plain JSON response instead of a failed handshake.
	r.Get("/ws", s.HandleWebSocket)

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

	r.Route("/auth", func(r chi.Router) {
		r.Post("/request-otp", s.RequestOtp)
		r.With(s.rateLimitIP("verify-otp", verifyRateLimitIP, verifyRateWindowIP)).Post("/verify-otp", s.VerifyOtp)
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
		r.Use(s.Idempotency)
		if s.db != nil {
			// Audit every money/status/moderation mutation (M5). Insert
			// failures are logged by the middleware, never fail the request.
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
		// Push-token registry (NOTIFICATIONS.md documented extension): the
		// contract now declares the three push-token endpoints
		// (/notifications/me/push-token POST/DELETE,
		// /notifications/me/push-tokens GET), so they mount through the
		// generated tree below (gen.HandlerFromMux) like every other
		// contract route.
		// Admin webhook ops extension (webhook_admin.go): the contract only
		// defines GET /admin/webhooks; the delivery list + manual retry are
		// documented extensions mounted before the generated surface so they
		// win over the generated 404/501 fallbacks.
		r.Get("/admin/webhooks/deliveries", s.AdminListWebhookDeliveries)
		r.Post("/admin/webhooks/deliveries/{deliveryId}/retry", s.AdminRetryWebhookDelivery)
		// Integrations create (POST /integrations): contract currently has no
		// create route (405), but DB supports it. Validate provider enum
		// (pos/erp/accounting/payroll/crm, NOT delivery_partner) and scope
		// before insert so invalid enums surface 422 not 500.
		r.Post("/integrations", s.CreateIntegration)
		// Admin conversation block alias: POST /admin/conversations/{id}/block
		// mirrors POST /conversations/{id}/block for staff moderation via the
		// admin prefix. The main handler now allows admin bypass of the
		// participant check.
		r.Post("/admin/conversations/{conversationId}/block", func(w http.ResponseWriter, rq *http.Request) {
			s.BlockConversation(w, rq, uuidParam(rq, "conversationId"))
		})
		// Customer offline replay (customer_sync.go, ARCHITECTURE.md offline
		// contract extended to customers): a documented-extension endpoint
		// mirroring the rider sync batch, mounted before the generated
		// fallback so no contract route can shadow it.
		r.Post("/sync/batch", s.SyncCustomerBatch)

		// Merchant web app multi-store alias tree. The contract's store
		// sub-resources (qr-codes, qualifications, menu, kitchen-camera,
		// self-pickup, receipt-templates, payment-accounts, logs, compliance,
		// settings, violations) are merchant-scoped handlers, so we mount them
		// under /stores/{storeId}/... to match the web app's multi-store paths.
		// The {storeId} segment is accepted but ignored (single-store model).
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
			r.Patch("/dual-screen", s.MthUpdateStoreDualScreen)
			r.Get("/qr-ordering", s.MthGetStoreQrOrdering)
			r.Patch("/qr-ordering", s.MthUpdateStoreQrOrdering)
			r.Get("/compliance", s.MthGetStoreCompliance)
			// Store-scoped order export (ext_export.go): the {storeId}
			// segment is accepted but ignored like the rest of this alias
			// tree (orders carry no store column this milestone).
			r.Get("/export", s.MthExportStoreOrders)
		})

		// Merchant web app + consumer mobile extension surface (handlers in
		// ext_*.go). All of these were live-verified 404 before mounting.
		r.Get("/analytics/overview", s.MthAnalyticsOverview)
		r.Get("/campaigns/{id}/performance", s.MthGetCampaignPerformance)
		r.Post("/campaigns/{id}/stop", s.MthStopCampaign)
		r.Get("/chat/threads", s.MthListChatThreads)
		r.Get("/closure/status", s.MthGetClosureStatus)
		r.Post("/coupons/suggest", s.MthSuggestCoupons)
		// GET /coupon-suggest (ext_marketing.go): body-less twin of POST
		// /coupons/suggest for the merchant marketing suite's probe path.
		r.Get("/coupon-suggest", s.MthGetCouponSuggest)
		// Merchant order export (ext_export.go): the web app's export
		// surfaces answered 404 before mounting. POST reads filters from the
		// JSON body, GET from the query string; both embed the payload as a
		// data URL under downloadUrl.
		r.Get("/export/orders", s.MthExportOrders)
		r.Post("/export/orders", s.MthExportOrders)
		r.Get("/customer-memberships/me", s.MthListCustomerMemberships)
		r.Post("/dual-screen/pair", s.MthPairDualScreen)
		r.Get("/finance/dispute-holds", s.MthListDisputeHolds)
		r.Get("/finance/revenue-composition", s.MthGetRevenueComposition)
		r.Get("/invoices", s.MthListInvoices)
		r.Post("/members/{id}/redeem", s.MthRedeemLoyaltyMember)
		r.Get("/marketing/coupons", s.MthListMarketingCoupons)
		r.Post("/loyalty/redemptions", s.MthCreateLoyaltyRedemption)
		r.Get("/payment-accounts", s.MthListPaymentAccounts)
		r.Patch("/payment-accounts/{id}", s.MthUpdatePaymentAccount)
		r.Get("/receipt-templates/active", s.MthGetActiveReceiptTemplate)
		r.Get("/redemptions", s.MthListRedemptions)
		r.Post("/redemptions", s.MthCreateRedemption)
		r.Post("/supplier-returns/{id}/process", s.MthProcessSupplierReturn)
		r.Post("/supplier-returns/{id}/reject", s.MthRejectSupplierReturn)
		r.Post("/tables/{id}/qr", s.MthTableQr)
		r.Post("/tasks/{id}/complete", s.MthCompleteTask)
		r.Get("/webhooks/{id}/test", s.MthTestWebhook)
		r.Post("/dine-in/reservations/{id}/confirm", s.MthConfirmReservation)
		r.Get("/privacy/export/{id}", s.MthPrivacyExport)
		r.Get("/printers", s.MthListPrinters)
		r.Post("/printers", s.MthCreatePrinter)
		r.Get("/printers/{id}", s.MthGetPrinter)
		r.Patch("/printers/{id}", s.MthUpdatePrinter)
		r.Delete("/printers/{id}", s.MthDeletePrinter)
		r.Post("/printers/{id}/connect", s.MthConnectPrinter)
		r.Post("/printers/{id}/test", s.MthTestPrinter)
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
		r.Delete("/payments/methods/{id}", s.MthDeletePaymentMethod)
		r.Post("/payments/methods", s.MthAddPaymentMethod)
		r.Get("/push/tokens", s.MthListPushTokens)
		r.Post("/push/tokens", s.MthRegisterPushTokenConsumer)
		r.Delete("/push/tokens/{id}", s.MthDeletePushToken)
		r.Get("/home/recommendations", s.MthHomeRecommendations)
		r.Get("/marketing/live-deals/{id}/chat", s.MthGetLiveDealChat)
		r.Post("/marketing/live-deals/{id}/chat", s.MthPostLiveDealChat)

		// Consumer mobile app extension surface (handlers in ext_consumer_*.go,
		// search.go, wallet.go). All of these were live-verified 404/405/403
		// before mounting; the generated tree has no such routes. The
		// /providers/{id} param route must come after /providers/available and
		// /providers/me/preferred (chi prefers static segments anyway).
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
		// Booking documents: the app null-maps ONLY 404 (bookings.ts
		// documentOrNull), so the customer GET surfaces answer NOT_FOUND — the
		// contract ships these as merchant-side POST mutations only.
		r.Get("/bookings/{id}/invoice", func(w http.ResponseWriter, rq *http.Request) {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "No invoice available for this booking")
		})
		r.Get("/bookings/{id}/warranty", func(w http.ResponseWriter, rq *http.Request) {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "No warranty available for this booking")
		})
		r.Get("/bookings/{id}/proof-of-service", func(w http.ResponseWriter, rq *http.Request) {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "No proof of service available for this booking")
		})

		// Merchant onboarding: the contract operation applyMerchant is
		// POST /merchants (public — "public lead or partner signup", no
		// bearerAuth), mounted by the generated tree below (POST /merchants
		// in gen.HandlerFromMux). It is NOT shadowed by the
		// GET /merchants/{merchantId} wildcard: that pattern needs a second
		// segment, so POST /merchants only ever matches this route. The
		// former POST /merchants/apply alias is gone — it is not a contract
		// path and no client calls it.

		// Merchant order queue + refund-create extensions (orders_extra.go):
		// the contract reserves GET /orders as create-only (405 for lists)
		// and defines no POST /orders/{id}/refund, so both are mounted ahead
		// of the generated tree — the merchant web app depends on them.
		r.Get("/orders", s.MthListOrders)
		r.Post("/orders/{id}/refund", func(w http.ResponseWriter, rq *http.Request) {
			s.MthCreateOrderRefund(w, rq, uuidParam(rq, "id"))
		})

		// COD cash collection (ext_rider_cod.go): rider-only endpoint to
		// mark a COD order as paid after collecting cash from the customer.
		r.Post("/orders/{id}/cod-collect", func(w http.ResponseWriter, rq *http.Request) {
			s.CollectCOD(w, rq, uuidParam(rq, "id"))
		})

		// Rider shift creation (rider_ops.go): the generated contract has no
		// POST /riders/me/shifts route, so the unexported handler is mounted
		// here. The generated tree only registers GET /riders/me/shifts and the
		// clock-in / clock-out / break / swap sub-routes.
		// Rider delivery advance (dispatch.go): POST /orders/me/advance is
		// contract-less — the generated tree only registers GET
		// /orders/me/advance (ListAdvanceOrders). Mount it here inside the
		// RequireAuth-wrapped block so a rider can step their in-flight
		// delivery (picked_up→delivering→delivered).
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

		// Dine-in extensions (FIX: dine-in soft-delete leak): the contract has no
		// GET /dine-in/tables/{tableId} (only PATCH/DELETE/GET /qr), so a plain
		// GET would 405. Mount a manual GET that hides soft-deleted rows as 404.
		// Also mount POST /dine-in/tables/{tableId}/qr as an alias to the GET QR
		// handler — the web app historically posts for QR generation; ensure
		// both verbs work.
		r.Get("/dine-in/tables/{tableId}", func(w http.ResponseWriter, rq *http.Request) {
			s.GetDineInTable(w, rq, uuidParam(rq, "tableId"))
		})
		r.Post("/dine-in/tables/{tableId}/qr", func(w http.ResponseWriter, rq *http.Request) {
			s.GetDineInTableQr(w, rq, uuidParam(rq, "tableId"))
		})

		// Consumer GET /payments/methods override: the generated tree mounts
		// GET /payments/methods to the static-enum ListPaymentMethods. Mount
		// the consumer-scoped MthListPaymentMethods AFTER the generated tree
		// (chi last-registration-wins) so callers get their own saved methods.
		r.Get("/payments/methods", s.MthListPaymentMethods)

		// GET /providers override: chi's last registration wins, so the
		// tolerant consumer list (MthListProvidersConsumer) is mounted AFTER
		// the generated tree. The app sends mock city ids (cityId=city_dar,
		// providers.ts list) which the generated ListProviders UUID param
		// rejects with a 400 before its handler runs.
		r.Get("/providers", s.MthListProvidersConsumer)
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
