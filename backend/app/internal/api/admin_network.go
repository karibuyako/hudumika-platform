package api

import (
	"net/http"
	"net/netip"
	"os"
	"strings"
	"sync"
)

// adminIPPolicy is the parsed ADMIN_ALLOWED_IPS allow-list. It is computed
// once per process: the environment must not change mid-run (DEPLOYMENT.md:
// the admin surface is reachable only via a protected hostname/network
// policy, and this is the in-app layer enforcing it).
type adminIPPolicy struct {
	allowAll bool
	entries  []netip.Prefix
}

var (
	adminIPOnce  sync.Once
	adminIPCache adminIPPolicy
)

// adminIPAllowed reports whether the request's client IP may reach the
// /admin/* surface. When ADMIN_ALLOWED_IPS is unset or empty the surface is
// unrestricted (development). Otherwise the comma-separated list (exact IPs
// or CIDRs) is parsed once and the client IP (clientIP, honoring
// X-Forwarded-For) must exactly match an entry or fall inside one of its
// CIDRs. Requests that do not match — or whose client IP cannot be parsed —
// are denied, so the policy fails closed when restricted.
func (s *Server) adminIPAllowed(r *http.Request) bool {
	raw := strings.TrimSpace(os.Getenv("ADMIN_ALLOWED_IPS"))
	if raw == "" {
		return true
	}
	adminIPOnce.Do(func() {
		p := adminIPPolicy{allowAll: false}
		for _, part := range strings.Split(raw, ",") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			if strings.Contains(part, "/") {
				prefix, err := netip.ParsePrefix(part)
				if err != nil {
					s.logger.Warn("admin IP allow-list: skipping invalid CIDR", "entry", part, "error", err)
					continue
				}
				p.entries = append(p.entries, prefix)
				continue
			}
			addr, err := netip.ParseAddr(part)
			if err != nil {
				s.logger.Warn("admin IP allow-list: skipping invalid IP", "entry", part, "error", err)
				continue
			}
			p.entries = append(p.entries, netip.PrefixFrom(addr, addr.BitLen()))
		}
		adminIPCache = p
	})
	addr, err := netip.ParseAddr(clientIP(r))
	if err != nil {
		// clientIP falls back to RemoteAddr, which may carry a port.
		if ap, aerr := netip.ParseAddrPort(clientIP(r)); aerr == nil {
			addr = ap.Addr()
		} else {
			return false
		}
	}
	for _, e := range adminIPCache.entries {
		if e.Contains(addr) {
			return true
		}
	}
	return false
}
