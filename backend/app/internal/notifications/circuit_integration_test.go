//go:build integration

// Integration contract for SMS multi-provider failover: two httptest
// gateways behind a FailoverSMS — a down primary hands traffic to the backup,
// three primary failures open the circuit (backup serves without primary
// attempts), and a recovered primary is used again once the window passes.
// The circuit state runs against miniredis; no database is required.
package notifications

import (
	"context"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

// hitGateway counts every request its server receives, answering status.
func hitGateway(status int) (http.HandlerFunc, *atomic.Int32) {
	hits := &atomic.Int32{}
	return func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(status)
	}, hits
}

// statusGateway answers every request with the status stored in *status, so a
// test can heal or break a gateway mid-flight; it counts hits too.
func statusGateway(status *atomic.Int32) (http.HandlerFunc, *atomic.Int32) {
	hits := &atomic.Int32{}
	return func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(int(status.Load()))
	}, hits
}

// failoverTestPair wires the primary and backup httptest gateways into a
// FailoverSMS with a Redis-backed breaker under the given open window.
func failoverTestPair(t *testing.T, primaryStatus, backupStatus int, openFor time.Duration) (*FailoverSMS, *atomic.Int32, *atomic.Int32) {
	t.Helper()
	primaryHandler, primaryHits := hitGateway(primaryStatus)
	backupHandler, backupHits := hitGateway(backupStatus)
	primarySrv, _ := newGatewayServer(t, primaryHandler)
	backupSrv, _ := newGatewayServer(t, backupHandler)
	primary, err := NewHTTPGateway(HTTPGatewayConfig{URL: primarySrv.URL, Timeout: 5 * time.Second}, "sms")
	if err != nil {
		t.Fatalf("primary gateway: %v", err)
	}
	backup, err := NewHTTPGateway(HTTPGatewayConfig{URL: backupSrv.URL, Timeout: 5 * time.Second}, "sms")
	if err != nil {
		t.Fatalf("backup gateway: %v", err)
	}
	breaker := newCircuitTest(t)
	breaker.openFor = openFor
	return NewFailoverSMS(primary, backup, breaker, nil), primaryHits, backupHits
}

func TestFailoverIntegrationPrimaryDownUsesBackup(t *testing.T) {
	failover, primaryHits, backupHits := failoverTestPair(t, http.StatusInternalServerError, http.StatusOK, 5*time.Second)
	if err := failover.Send(context.Background(), sampleSMS()); err != nil {
		t.Fatalf("Send with a down primary must deliver via backup, got %v", err)
	}
	if primaryHits.Load() != 1 {
		t.Errorf("primary hits = %d, want 1 (attempted first)", primaryHits.Load())
	}
	if backupHits.Load() != 1 {
		t.Errorf("backup hits = %d, want 1 (delivered)", backupHits.Load())
	}
}

func TestFailoverIntegrationCircuitOpensAfterThreeFailures(t *testing.T) {
	failover, primaryHits, backupHits := failoverTestPair(t, http.StatusInternalServerError, http.StatusOK, 5*time.Second)
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		if err := failover.Send(ctx, sampleSMS()); err != nil {
			t.Fatalf("send %d: %v", i+1, err)
		}
	}
	if primaryHits.Load() != 3 {
		t.Errorf("primary hits = %d, want 3 (one per failure before the trip)", primaryHits.Load())
	}
	// The circuit is now open: the primary must not be touched again.
	for i := 0; i < 3; i++ {
		if err := failover.Send(ctx, sampleSMS()); err != nil {
			t.Fatalf("send with open circuit %d: %v", i+1, err)
		}
	}
	if primaryHits.Load() != 3 {
		t.Errorf("primary hits = %d, want 3 (open circuit must not probe the primary)", primaryHits.Load())
	}
	if backupHits.Load() != 6 {
		t.Errorf("backup hits = %d, want 6 (all sends delivered)", backupHits.Load())
	}
}

func TestFailoverIntegrationPrimaryRecoversAfterWindow(t *testing.T) {
	primaryStatus := &atomic.Int32{}
	primaryStatus.Store(int32(http.StatusInternalServerError))
	primaryHandler, primaryHits := statusGateway(primaryStatus)
	backupHandler, backupHits := hitGateway(http.StatusOK)
	primarySrv, _ := newGatewayServer(t, primaryHandler)
	backupSrv, _ := newGatewayServer(t, backupHandler)
	primary, err := NewHTTPGateway(HTTPGatewayConfig{URL: primarySrv.URL, Timeout: 5 * time.Second}, "sms")
	if err != nil {
		t.Fatalf("primary gateway: %v", err)
	}
	backup, err := NewHTTPGateway(HTTPGatewayConfig{URL: backupSrv.URL, Timeout: 5 * time.Second}, "sms")
	if err != nil {
		t.Fatalf("backup gateway: %v", err)
	}
	breaker := newCircuitTest(t)
	breaker.openFor = 40 * time.Millisecond
	failover := NewFailoverSMS(primary, backup, breaker, nil)

	ctx := context.Background()
	for i := 0; i < 3; i++ {
		if err := failover.Send(ctx, sampleSMS()); err != nil {
			t.Fatalf("send %d: %v", i+1, err)
		}
	}
	if primaryHits.Load() != 3 {
		t.Fatalf("primary hits = %d, want 3 before the circuit opens", primaryHits.Load())
	}

	// Let the open window pass, then heal the primary: the next send must
	// probe it again (half-open) and succeed, closing the circuit.
	time.Sleep(60 * time.Millisecond)
	primaryStatus.Store(int32(http.StatusOK))
	if err := failover.Send(ctx, sampleSMS()); err != nil {
		t.Fatalf("send after window: %v", err)
	}
	if primaryHits.Load() != 4 {
		t.Errorf("primary hits = %d, want 4 (recovered primary used again)", primaryHits.Load())
	}
	if backupHits.Load() != 3 {
		t.Errorf("backup hits = %d, want 3 (no backup sends after recovery)", backupHits.Load())
	}
}
