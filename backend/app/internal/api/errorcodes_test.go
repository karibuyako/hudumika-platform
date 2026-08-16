package api

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// catalogPath resolves backend/ERROR-CODES.md by walking up from the test
// working directory. Go tests run with CWD set to the package dir
// (backend/app/internal/api), and the catalog lives one level above the Go
// module at backend/ERROR-CODES.md, so the walk-up is the only reliable
// resolution (mirroring alertsRulesPath's fallback).
func catalogPath(t *testing.T) string {
	t.Helper()
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("os.Getwd: %v", err)
	}
	for dir := cwd; ; dir = filepath.Dir(dir) {
		candidate := filepath.Join(dir, "ERROR-CODES.md")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
	}
	t.Fatalf("ERROR-CODES.md not found walking up from %s", cwd)
	return ""
}

// moduleRoot walks up from the test working directory until it finds go.mod
// (the module root, whose internal/ tree the drift scan covers).
func moduleRoot(t *testing.T) string {
	t.Helper()
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("os.Getwd: %v", err)
	}
	for dir := cwd; ; dir = filepath.Dir(dir) {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
	}
	t.Fatalf("go.mod not found walking up from %s", cwd)
	return ""
}

// catalogCodeRe matches a catalog code token: a backticked all-caps
// identifier. Most codes carry an underscore (VALIDATION_FAILED), but the
// Global table also lists underscore-less ones (UNAUTHORIZED, FORBIDDEN,
// CONFLICT), so no underscore is required. (Double-quoted because
// backticks are the regex delimiters' subject.)
var catalogCodeRe = regexp.MustCompile("`([A-Z][A-Z0-9_]+)`")

// codeShapeRe matches an error-code-shaped string literal: all-caps with
// underscores, at least four characters (the ERROR-CODES.md convention).
var codeShapeRe = regexp.MustCompile(`"([A-Z][A-Z0-9_]{3,})"`)

// writeErrorCodeRe finds writeError/writeErrorWithRetry invocations and
// captures their third argument — the code. (?s) lets the argument list
// span lines; each of the first two arguments is matched as a comma-free
// span, which holds for the (w, status) pair used across this module.
var writeErrorCodeRe = regexp.MustCompile(`(?s)writeError(?:WithRetry)?\(\s*[^,]+,\s*[^,]+,\s*"([A-Z][A-Z0-9_]{3,})"`)

// errorResponseCodeRe finds `Code: "..."` struct fields: gen.ErrorResponse
// literals and per-item batch entries. The \b keeps OTPDevCode: and
// VoucherCode: (unrelated field names) out of the scan.
var errorResponseCodeRe = regexp.MustCompile(`(?m)\bCode:\s*"([A-Z][A-Z0-9_]{3,})"`)

// nonEnvelopeCodes are Code: fields that are not error-envelope codes and
// therefore must not be in the catalog. syncBatchRejectedEntry (rider sync
// batch acknowledgment) carries per-event outcome markers, not envelope
// codes: SKIPPED means "event type not applicable to this rider".
var nonEnvelopeCodes = map[string]bool{"SKIPPED": true}

// catalogCodes parses every backticked code token out of ERROR-CODES.md.
func catalogCodes(t *testing.T, path string) map[string]bool {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read ERROR-CODES.md: %v", err)
	}
	codes := make(map[string]bool)
	for _, m := range catalogCodeRe.FindAllStringSubmatch(string(data), -1) {
		codes[m[1]] = true
	}
	return codes
}

// usedCodes scans the module's Go sources (internal/**/*.go, excluding
// _test.go and internal/gen) for error-code-shaped literals in envelope
// positions, returning code -> "path:line" locations. Only the
// writeError/writeErrorWithRetry code argument and `Code:` struct fields
// count; errors.New sentinels and log lines are out of scope.
func usedCodes(t *testing.T, root string) map[string][]string {
	t.Helper()
	used := map[string][]string{}
	internalDir := filepath.Join(root, "internal")
	err := filepath.WalkDir(internalDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "gen" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".go") || strings.HasSuffix(d.Name(), "_test.go") {
			return nil
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		content := string(src)
		record := func(code string, index int) {
			line := strings.Count(content[:index], "\n") + 1
			rel, err := filepath.Rel(root, path)
			if err != nil {
				rel = path
			}
			loc := fmt.Sprintf("%s:%d", rel, line)
			for _, existing := range used[code] {
				if existing == loc {
					return
				}
			}
			used[code] = append(used[code], loc)
		}
		for _, m := range writeErrorCodeRe.FindAllStringSubmatchIndex(content, -1) {
			record(content[m[2]:m[3]], m[0])
		}
		for _, m := range errorResponseCodeRe.FindAllStringSubmatchIndex(content, -1) {
			code := content[m[2]:m[3]]
			if !nonEnvelopeCodes[code] {
				record(code, m[0])
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", internalDir, err)
	}
	return used
}

// TestErrorCodesUsedExistInCatalog pins the ERROR-CODES.md catalog to the
// codes the service actually emits: every envelope code used in this
// module's Go sources must exist in the catalog, or the test reports the
// file:line of each offender. New codes are added to the catalog in the
// same PR that introduces them (INSTRUCTIONS.md).
func TestErrorCodesUsedExistInCatalog(t *testing.T) {
	path := catalogPath(t)
	catalog := catalogCodes(t, path)
	used := usedCodes(t, moduleRoot(t))
	if len(used) == 0 {
		t.Fatal("no error-code literals detected in module sources (parser regression?)")
	}
	for code, locs := range used {
		if !catalog[code] {
			t.Errorf("envelope code %q used but missing from ERROR-CODES.md (%s)", code, strings.Join(locs, ", "))
		}
	}
}

// TestErrorCodesCatalogIsStable spot-checks the platform-critical codes:
// "Codes are stable strings; adding is allowed, repurposing is not", so
// these must never disappear from the catalog.
func TestErrorCodesCatalogIsStable(t *testing.T) {
	path := catalogPath(t)
	catalog := catalogCodes(t, path)
	if len(catalog) < 400 {
		t.Errorf("ERROR-CODES.md catalog holds %d codes, want >= 400 (a section was likely dropped)", len(catalog))
	}
	for _, want := range []string{
		"UNAUTHORIZED",
		"FORBIDDEN",
		"VALIDATION_FAILED",
		"NOT_FOUND",
		"CONFLICT",
		"RATE_LIMITED",
		"INTERNAL_ERROR",
		"NOT_IMPLEMENTED",
		"ORDER_STATUS_CONFLICT",
		"PAYMENT_SIGNATURE_INVALID",
		"OTP_MAX_ATTEMPTS",
		"VOUCHER_EXPIRED",
		"BOOKING_NOT_FOUND",
		"WALLET_INSUFFICIENT_BALANCE",
		"INVENTORY_NEGATIVE_STOCK",
		"SHIPMENT_FROZEN",
		"APPROVAL_ALREADY_DECIDED",
		"RISK_ALREADY_REVIEWED",
		"SYNC_SEQUENCE_GAP",
		"MESSAGE_RATE_LIMITED",
	} {
		if !catalog[want] {
			t.Errorf("platform-critical code %q missing from ERROR-CODES.md", want)
		}
	}
}
