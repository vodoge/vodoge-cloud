package directory

import (
	"net"
	"net/http"
	"strings"
)

const (
	// DefaultBaseDomain is the SaaS parent domain. Tenant a is a.vodoge.com.
	DefaultBaseDomain = "vodoge.com"
	// OperatorSlug is the first-party tenant at a.vodoge.com.
	OperatorSlug = "a"
	// OperatorTenantID is the seeded id for slug a. Certificates and docs may use it.
	OperatorTenantID = "a0000000-0000-4000-8000-00000000000a"
)

// SlugFromHost extracts the single-label tenant subdomain.
//
//	a.vodoge.com       → "a", true
//	vodoge.com         → "", false  (apex is not a tenant)
//	www.vodoge.com     → "", false
//	foo.bar.vodoge.com → "", false
func SlugFromHost(host, baseDomain string) (string, bool) {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" {
		return "", false
	}
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	baseDomain = strings.ToLower(strings.TrimSpace(baseDomain))
	if baseDomain == "" {
		baseDomain = DefaultBaseDomain
	}
	if host == baseDomain || host == "www."+baseDomain {
		return "", false
	}
	suffix := "." + baseDomain
	if !strings.HasSuffix(host, suffix) {
		return "", false
	}
	slug := strings.TrimSuffix(host, suffix)
	if slug == "" || strings.Contains(slug, ".") {
		return "", false
	}
	return slug, true
}

func requestHost(request *http.Request) string {
	if request == nil {
		return ""
	}
	if forwarded := request.Header.Get("X-Forwarded-Host"); forwarded != "" {
		host, _, _ := strings.Cut(forwarded, ",")
		return strings.TrimSpace(host)
	}
	return request.Host
}
