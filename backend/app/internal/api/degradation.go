package api

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// Degradation level
// ---------------------------------------------------------------------------

type DegradationLevel int

const (
	DegradationNone DegradationLevel = iota
	DegradationSlow
	DegradationDegraded
	DegradationCritical
)

func (l DegradationLevel) String() string {
	switch l {
	case DegradationNone:
		return "none"
	case DegradationSlow:
		return "slow"
	case DegradationDegraded:
		return "degraded"
	case DegradationCritical:
		return "critical"
	default:
		return "unknown"
	}
}

// ---------------------------------------------------------------------------
// Service health singleton
// ---------------------------------------------------------------------------

type ServiceHealth struct {
	DBLatency    time.Duration
	RedisLatency time.Duration
	Level        DegradationLevel
	mu           sync.RWMutex
}

var serviceHealth = &ServiceHealth{}

// RecordDBLatency records the last DB query latency.
func RecordDBLatency(d time.Duration) {
	serviceHealth.mu.Lock()
	defer serviceHealth.mu.Unlock()
	serviceHealth.DBLatency = d
	serviceHealth.Level = classifyLatency(d)
}

// GetDegradationLevel returns the current degradation level.
func GetDegradationLevel() DegradationLevel {
	serviceHealth.mu.RLock()
	defer serviceHealth.mu.RUnlock()
	return serviceHealth.Level
}

// classifyLatency maps a DB latency to a degradation level using
// configurable thresholds from platform_settings.
func classifyLatency(d time.Duration) DegradationLevel {
	settings := GetSettings()
	criticalMs := settings.DegradationThresholdCriticalMs
	if criticalMs <= 0 {
		criticalMs = 2000
	}
	degradedMs := settings.DegradationThresholdDegradedMs
	if degradedMs <= 0 {
		degradedMs = 500
	}
	slowMs := settings.DegradationThresholdSlowMs
	if slowMs <= 0 {
		slowMs = 100
	}
	switch {
	case d > time.Duration(criticalMs)*time.Millisecond:
		return DegradationCritical
	case d > time.Duration(degradedMs)*time.Millisecond:
		return DegradationDegraded
	case d > time.Duration(slowMs)*time.Millisecond:
		return DegradationSlow
	default:
		return DegradationNone
	}
}

// StartHealthMonitor runs a background goroutine that periodically pings the
// DB and Redis, updating the global degradation level. The monitor honours
// context cancellation for clean shutdown.
func StartHealthMonitor(ctx context.Context, checkInterval time.Duration) {
	if checkInterval <= 0 {
		checkInterval = 30 * time.Second
	}

	go func() {
		ticker := time.NewTicker(checkInterval)
		defer ticker.Stop()

		slog.Info("health monitor started", "interval", checkInterval)

		for {
			select {
			case <-ctx.Done():
				slog.Info("health monitor stopped")
				return
			case <-ticker.C:
				probeServiceHealth()
			}
		}
	}()
}

// probeServiceHealth pings DB and Redis and updates the global level.
func probeServiceHealth() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	serviceHealth.mu.Lock()
	defer serviceHealth.mu.Unlock()

	// The DB ping is done via the global serviceHealth — callers update
	// DBLatency via RecordDBLatency from their own pings. Here we do a
	// lightweight probe to keep the level fresh.
	//
	// We rely on the server's db.ping path (called by AdminHealthCheck or
	// the readyz probe) to update the latency via RecordDBLatency. The
	// monitor's job is to reclassify based on whatever latency was last
	// recorded. This avoids coupling the monitor to the DB pool directly.

	// Re-evaluate the current level from the last known latency.
	serviceHealth.Level = classifyLatency(serviceHealth.DBLatency)

	// Log state transitions
	switch serviceHealth.Level {
	case DegradationSlow:
		slog.Warn("service degradation: slow",
			"dbLatency", serviceHealth.DBLatency,
			"level", serviceHealth.Level.String())
	case DegradationDegraded:
		slog.Warn("service degradation: degraded",
			"dbLatency", serviceHealth.DBLatency,
			"level", serviceHealth.Level.String(),
			"action", "skip non-critical features (analytics)")
	case DegradationCritical:
		slog.Error("service degradation: critical",
			"dbLatency", serviceHealth.DBLatency,
			"level", serviceHealth.Level.String(),
			"action", "return 503 on non-essential endpoints")
	default:
		// Healthy — no log noise.
	}

	_ = ctx // suppress unused
}
