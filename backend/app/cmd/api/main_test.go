package main

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/hudumika/api-backend/internal/api"
	"github.com/hudumika/api-backend/internal/config"
)

// TestGracefulShutdown verifies the M1 exit criterion: an in-flight request
// completes and Shutdown returns cleanly within its deadline.
func TestGracefulShutdown(t *testing.T) {
	cfg := config.Config{
		Env:         "test",
		JWTSecret:   []byte("test-secret"),
		OTPDevCode:  "123456",
		AccessTTL:   time.Minute,
		RefreshTTL:  time.Hour,
		CORSOrigins: []string{"*"},
	}
	server, err := api.New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("new server: %v", err)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	srv := &http.Server{
		Handler:      server.Router(),
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}
	done := make(chan error, 1)
	go func() { done <- srv.Serve(ln) }()

	// A request that outlives the shutdown call.
	reqStarted := make(chan struct{})
	reqFinished := make(chan struct{})
	go func() {
		resp, err := http.Get("http://" + ln.Addr().String() + "/readyz")
		if err != nil {
			t.Errorf("in-flight request failed: %v", err)
			close(reqStarted)
			close(reqFinished)
			return
		}
		_ = resp.Body.Close()
		close(reqStarted)
		close(reqFinished)
	}()
	<-reqStarted

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	select {
	case <-reqFinished:
	case <-time.After(2 * time.Second):
		t.Fatal("in-flight request did not finish during graceful shutdown")
	}
	select {
	case err := <-done:
		if err != nil && err != http.ErrServerClosed {
			t.Fatalf("serve: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("server did not stop after shutdown")
	}
}
