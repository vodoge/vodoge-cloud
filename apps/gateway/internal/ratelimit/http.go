package ratelimit

import (
	"net"
	"net/http"
	"strconv"
	"time"
)

// ClientKey identifies the caller for limiting purposes.
//
// The remote address, not a header. `X-Forwarded-For` is set by whoever is
// upstream, and if that includes the internet then the caller chooses their
// own limit bucket — which is the same as having no limit. A deployment
// behind a trusted proxy should pass a KeyFunc that reads the header the proxy
// actually sets, once it is known which one that is.
func ClientKey(request *http.Request) string {
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		return request.RemoteAddr
	}
	return host
}

// Guard wraps a handler, refusing callers that are over their limit.
//
// The key function decides what is being limited: per-IP for sign-in, per
// tenant for work that costs a device something.
func Guard(limiter *Limiter, key func(*http.Request) string, next http.HandlerFunc) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		id := key(request)
		if limiter.Allow(id) {
			next(writer, request)
			return
		}
		wait := limiter.RetryAfter(id)
		if wait < time.Second {
			wait = time.Second
		}
		// Saying when turns a client that retries in a tight loop into one
		// that waits, which is most of the point.
		writer.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds()+0.5)))
		http.Error(writer, "too many requests", http.StatusTooManyRequests)
	}
}
