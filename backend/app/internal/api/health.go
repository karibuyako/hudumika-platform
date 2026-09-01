package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"net/http"
	"runtime"
	"sync"
	"syscall"
	"time"
)

// ---------------------------------------------------------------------------
// Health status types
// ---------------------------------------------------------------------------

type HealthStatus string

const (
	HealthUp       HealthStatus = "up"
	HealthDown     HealthStatus = "down"
	HealthDegraded HealthStatus = "degraded"
)

type HealthCheck struct {
	Status  HealthStatus `json:"status"`
	Details any          `json:"details,omitempty"`
}

type HealthReport struct {
	Status    HealthStatus           `json:"status"`
	Version   string                 `json:"version"`
	Uptime    string                 `json:"uptime"`
	Checks    map[string]HealthCheck `json:"checks"`
	CheckedAt time.Time              `json:"checkedAt"`
}

// ---------------------------------------------------------------------------
// AdminHealthCheck handles GET /admin/health (detailed, no auth required)
// ---------------------------------------------------------------------------

func (s *Server) AdminHealthCheck(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	checks := make(map[string]HealthCheck)
	overall := HealthUp

	// 1. Database
	dbCheck := s.checkDatabase(ctx)
	checks["database"] = dbCheck
	if dbCheck.Status == HealthDown {
		overall = HealthDown
	} else if dbCheck.Status == HealthDegraded && overall != HealthDown {
		overall = HealthDegraded
	}

	// 2. Redis
	if s.stores != nil && s.stores.Redis != nil {
		redisCheck := s.checkRedis(ctx)
		checks["redis"] = redisCheck
		if redisCheck.Status == HealthDown {
			overall = HealthDown
		} else if redisCheck.Status == HealthDegraded && overall != HealthDown {
			overall = HealthDegraded
		}
	}

	// 3. Disk
	diskCheck := s.checkDisk()
	checks["disk"] = diskCheck
	if diskCheck.Status == HealthDown {
		overall = HealthDown
	} else if diskCheck.Status == HealthDegraded && overall != HealthDown {
		overall = HealthDegraded
	}

	// 4. Memory
	memCheck := s.checkMemory()
	checks["memory"] = memCheck
	if memCheck.Status == HealthDown {
		overall = HealthDown
	} else if memCheck.Status == HealthDegraded && overall != HealthDown {
		overall = HealthDegraded
	}

	// 5. Degradation level from background monitor
	degLevel := GetDegradationLevel()
	if degLevel >= DegradationCritical {
		overall = HealthDown
	} else if degLevel >= DegradationDegraded && overall == HealthUp {
		overall = HealthDegraded
	}

	report := HealthReport{
		Status:    overall,
		Version:   "1.0.0",
		Uptime:    time.Since(s.startedAt).Truncate(time.Second).String(),
		Checks:    checks,
		CheckedAt: time.Now().UTC(),
	}

	statusCode := http.StatusOK
	if overall == HealthDegraded {
		statusCode = http.StatusOK // still 200 — degraded means serving
	} else if overall == HealthDown {
		statusCode = http.StatusServiceUnavailable
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(report)
}

// ---------------------------------------------------------------------------
// Individual check helpers
// ---------------------------------------------------------------------------

func (s *Server) checkDatabase(ctx context.Context) HealthCheck {
	if s.db == nil {
		return HealthCheck{Status: HealthDown, Details: map[string]string{"error": "database not configured"}}
	}
	start := time.Now()
	err := s.db.Ping(ctx)
	latency := time.Since(start)
	latencyMs := latency.Milliseconds()

	if err != nil {
		slog.Error("health check: database ping failed", "error", err, "latencyMs", latencyMs)
		return HealthCheck{Status: HealthDown, Details: map[string]any{"latencyMs": latencyMs, "error": err.Error()}}
	}

	level := HealthUp
	if latencyMs > 2000 {
		level = HealthDown
	} else if latencyMs > 500 {
		level = HealthDegraded
	}

	RecordDBLatency(latency)
	return HealthCheck{Status: level, Details: map[string]any{"latencyMs": latencyMs}}
}

func (s *Server) checkRedis(ctx context.Context) HealthCheck {
	if s.stores == nil || s.stores.Redis == nil {
		return HealthCheck{Status: HealthUp, Details: map[string]string{"note": "not configured"}}
	}
	start := time.Now()
	err := s.stores.Redis.Ping(ctx)
	latency := time.Since(start)
	latencyMs := latency.Milliseconds()

	if err != nil {
		slog.Error("health check: redis ping failed", "error", err, "latencyMs", latencyMs)
		return HealthCheck{Status: HealthDown, Details: map[string]any{"latencyMs": latencyMs, "error": err.Error()}}
	}

	return HealthCheck{Status: HealthUp, Details: map[string]any{"latencyMs": latencyMs}}
}

func (s *Server) checkDisk() HealthCheck {
	var stat syscall.Statfs_t
	if err := syscall.Statfs("/", &stat); err != nil {
		slog.Warn("health check: disk statfs failed", "error", err)
		return HealthCheck{Status: HealthDegraded, Details: map[string]string{"error": err.Error()}}
	}
	// Bavail = free blocks available to non-root; Bsize = block size
	availBytes := stat.Bavail * uint64(stat.Bsize)
	availGB := math.Round(float64(availBytes)/(1024*1024*1024)*10) / 10

	status := HealthUp
	if availGB < 1 {
		status = HealthDown
	} else if availGB < 5 {
		status = HealthDegraded
	}

	return HealthCheck{Status: status, Details: map[string]any{"availableGB": availGB}}
}

func (s *Server) checkMemory() HealthCheck {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	allocMB := math.Round(float64(m.Alloc)/(1024*1024)*10) / 10
	sysMB := math.Round(float64(m.Sys)/(1024*1024)*10) / 10

	status := HealthUp
	if sysMB > 1024 {
		status = HealthDegraded
	}

	return HealthCheck{
		Status:  status,
		Details: map[string]any{"allocMB": allocMB, "sysMB": sysMB, "heapInuseMB": math.Round(float64(m.HeapInuse)/(1024*1024)*10) / 10},
	}
}

// ---------------------------------------------------------------------------
// Background health monitor (also used by degradation.go)
// ---------------------------------------------------------------------------

var (
	healthMonitorOnce sync.Once
)

func (s *Server) startHealthMonitor(ctx context.Context) {
	healthMonitorOnce.Do(func() {
		interval := time.Duration(GetSettings().HealthMonitorIntervalSeconds) * time.Second
		if interval <= 0 {
			interval = 30 * time.Second
		}
		StartHealthMonitor(ctx, interval)
	})
}
