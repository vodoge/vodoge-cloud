package observe

import (
	"bufio"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"time"
)

// Metric names, declared in one place so a typo is a compile error at the call
// site rather than a silently missing series.
const (
	RequestsTotal    = "vodoge_http_requests_total"
	RequestSeconds   = "vodoge_http_request_seconds_total"
	SessionsActive   = "vodoge_device_sessions_active"
	IngressTotal     = "vodoge_ingress_records_total"
	CommandsTotal    = "vodoge_commands_enqueued_total"
	ViolationsTotal  = "vodoge_contract_violations_total"
	RateLimitedTotal = "vodoge_requests_rate_limited_total"
	IngressRejected  = "vodoge_ingress_rejected_total"
)

// Declare registers every metric this process reports.
func Declare(registry *Registry) {
	registry.Count(RequestsTotal, "HTTP requests served, by route and status.")
	registry.Count(RequestSeconds, "Total seconds spent serving HTTP requests, by route.")
	registry.Count(IngressTotal, "Uplink records accepted, by result.")
	registry.Count(CommandsTotal, "Commands enqueued, by kind.")
	registry.Count(ViolationsTotal, "Payloads that violated the contract, by kind.")
	registry.Count(RateLimitedTotal, "Requests refused by a rate limit, by route.")
	registry.Count(IngressRejected, "Uplink records dropped as unstorable, by kind.")
	registry.Gauge(SessionsActive, "Device sessions currently connected.")
}

// Middleware records and logs every request.
//
// The route pattern is used as the label, never the path: a label per device
// id would create an unbounded number of series, which is the standard way to
// destroy a metrics system with a single deployment.
func Middleware(registry *Registry, next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		started := time.Now()
		recorder := &statusRecorder{ResponseWriter: writer, status: http.StatusOK}
		next.ServeHTTP(recorder, request)

		route := routePattern(request)
		elapsed := time.Since(started)
		registry.Add(RequestsTotal, 1,
			"route", route,
			"status", statusClass(recorder.status))
		registry.Add(RequestSeconds, elapsed.Milliseconds(), "route", route)
		if recorder.status == http.StatusTooManyRequests {
			registry.Add(RateLimitedTotal, 1, "route", route)
		}

		// Logged at warn only when something went wrong. A line per request at
		// info would be the bulk of this host's disk writes and would bury the
		// entries anyone actually reads.
		if recorder.status >= 500 {
			slog.Warn("request failed",
				"method", request.Method, "route", route,
				"status", recorder.status, "ms", elapsed.Milliseconds())
		}
	})
}

// routePattern returns the matched pattern, or a placeholder.
//
// Go's ServeMux records which pattern matched, which is exactly the bounded
// label wanted here. An unmatched request reports "other" rather than its
// path, for the same reason.
func routePattern(request *http.Request) string {
	if pattern := request.Pattern; pattern != "" {
		return pattern
	}
	return "other"
}

// statusClass buckets a status into 2xx/4xx/5xx.
//
// The exact code belongs in the log line; as a label it multiplies the series
// count for a distinction nobody graphs.
func statusClass(status int) string {
	switch {
	case status >= 500:
		return "5xx"
	case status >= 400:
		return "4xx"
	case status >= 300:
		return "3xx"
	default:
		return "2xx"
	}
}

// statusRecorder remembers the status while passing everything else through.
//
// It must forward Hijack and Flush explicitly. Wrapping a ResponseWriter hides
// the interfaces the real one implements, and the two things this gateway does
// that are not plain request/response — the device WebSocket and the console's
// event stream — both depend on exactly those. The first version of this
// middleware wrapped without them and every device upgrade failed with a 500.
type statusRecorder struct {
	http.ResponseWriter
	status int
	wrote  bool
}

// Hijack lets the WebSocket upgrade take the connection.
func (recorder *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := recorder.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("the underlying writer cannot be hijacked")
	}
	// A hijacked connection writes its own status line, so nothing more
	// should be recorded for it. 101 is what the upgrade actually sends.
	recorder.wrote = true
	recorder.status = http.StatusSwitchingProtocols
	return hijacker.Hijack()
}

// Flush lets the event stream push each event as it happens.
func (recorder *statusRecorder) Flush() {
	if flusher, ok := recorder.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (recorder *statusRecorder) WriteHeader(status int) {
	if recorder.wrote {
		return
	}
	recorder.wrote = true
	recorder.status = status
	recorder.ResponseWriter.WriteHeader(status)
}

func (recorder *statusRecorder) Write(data []byte) (int, error) {
	recorder.wrote = true
	return recorder.ResponseWriter.Write(data)
}

// Handler exposes the registry.
func Handler(registry *Registry) http.HandlerFunc {
	return func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		_, _ = writer.Write([]byte(registry.Expose()))
	}
}
