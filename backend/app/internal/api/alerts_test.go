package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// liveMetrics mirrors the collectors registered in internal/api/metrics.go
// (httpRequestsTotal, httpRequestDuration, otpRequestsTotal,
// idempotencyHitsTotal, activeSessions). Alert rules and dashboards must
// only reference these — plus the Prometheus built-ins in builtinMetrics.
var liveMetrics = []string{
	"http_requests_total",
	"http_request_duration_seconds",
	"otp_requests_total",
	"idempotency_hits_total",
	"active_sessions",
}

// builtinMetrics are series produced by the Prometheus server itself, not
// exported from this app's /metrics, and therefore legal in alert
// expressions. `up` powers the ReadyzDown rule (scrape health of the API
// job).
var builtinMetrics = map[string]bool{"up": true}

// histogramSuffixes map derived series names (buckets/_count/_sum of a
// histogram) back to the base metric so the drift check can resolve
// http_request_duration_seconds_bucket -> http_request_duration_seconds.
var histogramSuffixes = []string{"_bucket", "_count", "_sum"}

// metricTokenRe finds identifiers used as metric names in PromQL: a name
// immediately followed by a label selector `{` or a range selector `[`.
// Templates like `{{ $labels.path }}` and label lists like `by (le, path)`
// are separated by whitespace/punctuation and cannot match.
var metricTokenRe = regexp.MustCompile(`([a-z_][a-z0-9_]*)[\[{]`)

// alertRule is one parsed `- alert:` block of dashboards/alerts.yml.
type alertRule struct {
	name     string
	expr     string
	forDur   string
	severity string
	team     string
	runbook  string
}

// alertsRulesPath resolves dashboards/alerts.yml. Go tests run with the
// package dir as CWD (backend/app/internal/api), so ../../dashboards lands
// on backend/app/dashboards; a Getwd-based walk up to the go.mod root is the
// fallback for exotic runner setups.
func alertsRulesPath(t *testing.T) string {
	t.Helper()
	rel := filepath.Join("..", "..", "dashboards", "alerts.yml")
	if _, err := os.Stat(rel); err == nil {
		return rel
	}
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("os.Getwd: %v", err)
	}
	for dir := cwd; ; dir = filepath.Dir(dir) {
		candidate := filepath.Join(dir, "dashboards", "alerts.yml")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
	}
	t.Fatalf("dashboards/alerts.yml not found (tried %s and a walk up from %s)", rel, cwd)
	return ""
}

// parseAlertsRules is a minimal YAML-subset reader for the rules file: it
// understands the groups -> rules -> (labels/annotations) nesting of
// alerts.yml by line shape, ignoring comments and blank lines. It
// deliberately avoids gopkg.in/yaml.v3 (not in go.mod) while still failing
// loudly if a required rule field is missing. A real Prometheus load of the
// file remains the source of truth; this parser pins the drift-relevant
// parts only.
func parseAlertsRules(t *testing.T, path string) (groups []string, rules []alertRule) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read alerts.yml: %v", err)
	}
	var cur *alertRule
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		switch {
		case strings.HasPrefix(line, "- name:"):
			groups = append(groups, strings.TrimSpace(strings.TrimPrefix(line, "- name:")))
		case strings.HasPrefix(line, "- alert:"):
			rules = append(rules, alertRule{name: strings.TrimSpace(strings.TrimPrefix(line, "- alert:"))})
			cur = &rules[len(rules)-1]
		case cur == nil:
			continue
		case strings.HasPrefix(line, "expr:"):
			cur.expr = strings.TrimSpace(strings.TrimPrefix(line, "expr:"))
		case strings.HasPrefix(line, "for:"):
			cur.forDur = strings.TrimSpace(strings.TrimPrefix(line, "for:"))
		case strings.HasPrefix(line, "severity:"):
			cur.severity = strings.TrimSpace(strings.TrimPrefix(line, "severity:"))
		case strings.HasPrefix(line, "team:"):
			cur.team = strings.TrimSpace(strings.TrimPrefix(line, "team:"))
		case strings.HasPrefix(line, "runbook:"):
			cur.runbook = strings.TrimSpace(strings.TrimPrefix(line, "runbook:"))
		}
	}
	return groups, rules
}

// stripComments removes `#` comments (line-level: a `#` inside an expr or
// annotation value starts a comment in this file's convention). Commented
// placeholder rules for not-yet-existing metrics (queue_depth,
// payout_failures_total) must not count as metric references, so they are
// stripped here before the token scan.
func stripComments(content string) string {
	var out []string
	for _, line := range strings.Split(content, "\n") {
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = line[:i]
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

// TestAlertRulesReferenceLiveMetrics pins dashboards/alerts.yml to the
// metrics this package actually exports (metrics.go). It also verifies every
// rule carries the alerting essentials (expr, for, severity) so the file
// stays deployable to Prometheus without surprises.
func TestAlertRulesReferenceLiveMetrics(t *testing.T) {
	path := alertsRulesPath(t)
	groups, rules := parseAlertsRules(t, path)

	for _, want := range []string{"hudumika_api", "hudumika_platform"} {
		found := false
		for _, g := range groups {
			if g == want {
				found = true
			}
		}
		if !found {
			t.Errorf("alerts.yml missing group %q (have %v)", want, groups)
		}
	}

	if len(rules) == 0 {
		t.Fatal("alerts.yml declares no rules")
	}

	known := make(map[string]bool, len(liveMetrics))
	for _, m := range liveMetrics {
		known[m] = true
	}

	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read alerts.yml: %v", err)
	}
	seen := map[string]bool{}
	for _, m := range metricTokenRe.FindAllStringSubmatch(stripComments(string(content)), -1) {
		base := m[1]
		for _, suf := range histogramSuffixes {
			base = strings.TrimSuffix(base, suf)
		}
		seen[base] = true
		if !known[base] && !builtinMetrics[base] {
			t.Errorf("alerts.yml references metric %q which is neither exported by metrics.go nor a Prometheus built-in (%v)", m[1], builtinMetrics)
		}
	}
	if len(seen) == 0 {
		t.Fatal("no metric names detected in alerts.yml (parser regression?)")
	}

	for _, r := range rules {
		if r.expr == "" {
			t.Errorf("alert %q: missing expr", r.name)
		}
		if r.forDur == "" {
			t.Errorf("alert %q: missing for", r.name)
		}
		if r.severity == "" {
			t.Errorf("alert %q: missing severity label", r.name)
		}
		if r.team == "" {
			t.Errorf("alert %q: missing team label", r.name)
		}
		if r.runbook == "" {
			t.Errorf("alert %q: missing runbook annotation", r.name)
		}
	}
}

// TestDashboardJSONParseable verifies every Grafana dashboard JSON parses
// (json.Valid) and carries a non-empty panels list, so a broken edit to the
// dashboard artifacts is caught by the unit test rather than at import time.
func TestDashboardJSONParseable(t *testing.T) {
	grafanaDir := filepath.Join(filepath.Dir(alertsRulesPath(t)), "grafana")

	want := []string{
		"api-overview.json",
		"errors.json",
		"dispatch.json",
		"money.json",
		"mobile-otp.json",
	}
	for _, name := range want {
		path := filepath.Join(grafanaDir, name)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		if !json.Valid(data) {
			t.Errorf("%s: not valid JSON", name)
			continue
		}
		var doc map[string]any
		if err := json.Unmarshal(data, &doc); err != nil {
			t.Fatalf("%s: unmarshal: %v", name, err)
		}
		panels, ok := doc["panels"].([]any)
		if !ok {
			t.Errorf("%s: missing panels array", name)
			continue
		}
		if len(panels) == 0 {
			t.Errorf("%s: panels is empty", name)
		}
		for _, field := range []string{"uid", "title", "timezone"} {
			if _, ok := doc[field]; !ok {
				t.Errorf("%s: missing %q field", name, field)
			}
		}
		if v, ok := doc["schemaVersion"].(float64); !ok || v != 39 {
			t.Errorf("%s: schemaVersion = %v, want 39", name, doc["schemaVersion"])
		}
	}
}
