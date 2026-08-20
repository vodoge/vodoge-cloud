package main

import (
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/catalog"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/directory"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/ingress"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/region"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/wakeup"
)

func TestHealthEndpointsAreNoStoreJSON(t *testing.T) {
	t.Parallel()

	for _, path := range []string{"/healthz", "/readyz"} {
		path := path
		t.Run(path, func(t *testing.T) {
			t.Parallel()

			request := httptest.NewRequest(http.MethodGet, path, nil)
			response := httptest.NewRecorder()
			healthHandler().ServeHTTP(response, request)

			if response.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", response.Code, http.StatusOK)
			}
			if got := response.Header().Get("Cache-Control"); got != "no-store" {
				t.Errorf("Cache-Control = %q, want no-store", got)
			}
			if got := response.Header().Get("X-Content-Type-Options"); got != "nosniff" {
				t.Errorf("X-Content-Type-Options = %q, want nosniff", got)
			}
		})
	}
}

func TestReadyzFailsWhenDatabaseIsUnreachable(t *testing.T) {
	t.Parallel()

	db, err := sql.Open("pgx", "postgres://vodoge_gateway:x@127.0.0.1:1/vodoge?connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	handler := newProcess("", &ingress.SQLStore{DB: db, Timeout: 500 * time.Millisecond}, nil, wakeup.Failing{}, nil).handler()

	request := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", response.Code)
	}

	live := httptest.NewRecorder()
	handler.ServeHTTP(live, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if live.Code != http.StatusOK {
		t.Fatalf("healthz = %d, want 200", live.Code)
	}
}

func TestReadyzIgnoresRedis(t *testing.T) {
	t.Parallel()

	handler := newProcess("", ingress.NewJournal(), nil, wakeup.Failing{}, nil).handler()
	request := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; redis must not gate uplink readiness", response.Code)
	}
}

func TestConnectWakeupUnsetURLIsNop(t *testing.T) {
	t.Parallel()

	publisher := connectWakeup("", "node-1", slog.New(slog.NewTextHandler(io.Discard, nil)))
	if _, ok := publisher.(wakeup.Nop); !ok {
		t.Fatalf("publisher type = %T, want wakeup.Nop", publisher)
	}
}

func TestConnectWakeupBadURLIsNop(t *testing.T) {
	t.Parallel()

	publisher := connectWakeup("://not-a-url", "node-1", slog.New(slog.NewTextHandler(io.Discard, nil)))
	if _, ok := publisher.(wakeup.Nop); !ok {
		t.Fatalf("publisher type = %T, want wakeup.Nop", publisher)
	}
}

func TestConnectWakeupPingFailureKeepsClient(t *testing.T) {
	t.Parallel()

	publisher := connectWakeup("redis://127.0.0.1:1/0", "node-1", slog.New(slog.NewTextHandler(io.Discard, nil)))
	if publisher == nil {
		t.Fatal("publisher is nil")
	}
	if _, ok := publisher.(wakeup.Nop); ok {
		t.Fatal("unreachable redis must keep the client so later recovery can publish")
	}
}

func TestUnknownTenantSlugIs404(t *testing.T) {
	t.Parallel()

	response := httptest.NewRecorder()
	healthHandler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/tenants/missing", nil))
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", response.Code)
	}

	apex := httptest.NewRecorder()
	apexReq := httptest.NewRequest(http.MethodGet, "/v1/tenant", nil)
	apexReq.Host = "vodoge.com"
	healthHandler().ServeHTTP(apex, apexReq)
	if apex.Code != http.StatusNotFound {
		t.Fatalf("apex host status = %d, want 404", apex.Code)
	}

	events := httptest.NewRecorder()
	eventReq := httptest.NewRequest(http.MethodGet, "/v1/events", nil)
	eventReq.Host = "vodoge.com"
	healthHandler().ServeHTTP(events, eventReq)
	if events.Code != http.StatusNotFound {
		t.Fatalf("sse on apex status = %d, want 404", events.Code)
	}
}

func TestEnrollRouteExistsWithoutClientCertificate(t *testing.T) {
	t.Parallel()

	response := httptest.NewRecorder()
	healthHandler().ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/enroll", http.NoBody))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 when device CA is not configured", response.Code)
	}
}

func TestEdgePathRequiresMutualTLS(t *testing.T) {
	t.Parallel()

	request := httptest.NewRequest(http.MethodGet, "/v1/edge", nil)
	request.Header.Set("Sec-WebSocket-Protocol", "vodoge.edge.v1")
	response := httptest.NewRecorder()
	healthHandler().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.Code)
	}
}

func TestCatalogRoutesAreTenantScoped(t *testing.T) {
	t.Parallel()

	tenants := directory.New(nil)
	if !tenants.Cache.Store(region.Entry{
		TenantID: "t-a",
		Slug:     "a",
		Region:   "cn",
		Status:   "active",
	}) {
		t.Fatal("store tenant a")
	}
	if !tenants.Cache.Store(region.Entry{
		TenantID: "t-b",
		Slug:     "b",
		Region:   "intl",
		Status:   "active",
	}) {
		t.Fatal("store tenant b")
	}

	proc := newProcess("", nil, tenants, nil, nil)
	proc.catalog = &catalog.Memory{
		Devices: map[string][]catalog.Device{
			"t-a": {{ID: "d-a", Name: "lab-a", State: "online"}},
			"t-b": {{ID: "d-b", Name: "lab-b", State: "offline"}},
		},
		Messages: map[string][]catalog.Message{
			"t-a": {{
				ID: "m-a", DeviceID: "d-a", Direction: "inbound",
				Peer: "10086", Body: "hello-a", Bearer: "cellular",
				ReceivedAt: 1_700_000_000_000, Seq: 1,
			}},
			"t-b": {{
				ID: "m-b", DeviceID: "d-b", Direction: "inbound",
				Peer: "10086", Body: "hello-b", Bearer: "cellular",
				ReceivedAt: 1_700_000_000_001, Seq: 1,
			}},
		},
	}
	handler := proc.handler()

	devices := getJSON(t, handler, "http://a.vodoge.com/v1/devices")
	if got := stringSlice(devices["devices"], "id"); len(got) != 1 || got[0] != "d-a" {
		t.Fatalf("tenant a devices = %#v", devices)
	}

	messages := getJSON(t, handler, "http://a.vodoge.com/v1/messages")
	if got := stringSlice(messages["messages"], "body"); len(got) != 1 || got[0] != "hello-a" {
		t.Fatalf("tenant a messages = %#v", messages)
	}

	sessions := getJSON(t, handler, "http://a.vodoge.com/v1/sessions")
	if got := stringSlice(sessions["sessions"], "last_body"); len(got) != 1 || got[0] != "hello-a" {
		t.Fatalf("tenant a sessions = %#v", sessions)
	}

	other := getJSON(t, handler, "http://b.vodoge.com/v1/devices")
	if got := stringSlice(other["devices"], "id"); len(got) != 1 || got[0] != "d-b" {
		t.Fatalf("tenant b devices = %#v", other)
	}

	unknown := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/devices", nil)
	req.Host = "missing.vodoge.com"
	handler.ServeHTTP(unknown, req)
	if unknown.Code != http.StatusNotFound {
		t.Fatalf("unknown tenant status = %d, want 404", unknown.Code)
	}

	forwarded := httptest.NewRecorder()
	fwd := httptest.NewRequest(http.MethodGet, "/v1/devices", nil)
	fwd.Host = "127.0.0.1:18080"
	fwd.Header.Set("X-Forwarded-Host", "a.vodoge.com")
	handler.ServeHTTP(forwarded, fwd)
	if forwarded.Code != http.StatusOK {
		t.Fatalf("forwarded host status = %d body=%s", forwarded.Code, forwarded.Body.String())
	}
}

func getJSON(t *testing.T, handler http.Handler, rawURL string) map[string]any {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, rawURL, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("%s status = %d body=%s", rawURL, response.Code, response.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %s: %v", rawURL, err)
	}
	return body
}

func stringSlice(value any, field string) []string {
	list, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(list))
	for _, item := range list {
		record, ok := item.(map[string]any)
		if !ok {
			continue
		}
		text, _ := record[field].(string)
		out = append(out, text)
	}
	return out
}
