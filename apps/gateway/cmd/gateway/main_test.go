package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/audit"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/auth"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/catalog"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/commands"
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

	proc := signedIn(newProcess("", nil, tenants, nil, nil))
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
	authorize(fwd)
	handler.ServeHTTP(forwarded, fwd)
	if forwarded.Code != http.StatusOK {
		t.Fatalf("forwarded host status = %d body=%s", forwarded.Code, forwarded.Body.String())
	}
}

func TestCapabilityMatrixPutQueuesPerDevice(t *testing.T) {
	t.Parallel()

	tenants := directory.New(nil)
	_ = tenants.Cache.Store(region.Entry{TenantID: "t-a", Slug: "a", Region: "cn", Status: "active"})
	_ = tenants.Cache.Store(region.Entry{TenantID: "t-b", Slug: "b", Region: "intl", Status: "active"})
	proc := signedIn(newProcess("", nil, tenants, nil, nil))
	proc.catalog = &catalog.Memory{
		Devices: map[string][]catalog.Device{
			"t-a": {{ID: "d-a", Name: "lab-a", State: "online"}},
			"t-b": {{ID: "d-b", Name: "lab-b", State: "offline"}},
		},
	}
	handler := proc.handler()

	req := authorize(httptest.NewRequest(http.MethodPut, "http://a.vodoge.com/v1/capability-matrix", strings.NewReader(`{"matrix":{"version":"hot-1","rule":[]}}`)))
	req.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["version"] != "hot-1" {
		t.Fatalf("body = %#v", body)
	}
	if queued, _ := body["queued"].(float64); queued != 1 {
		t.Fatalf("queued = %#v", body["queued"])
	}

	queue := proc.queue.(*commands.Memory)
	if len(queue.Items) != 1 || queue.Items[0].DeviceID != "d-a" || queue.Items[0].Kind != "update_capability_matrix" {
		t.Fatalf("queue = %+v", queue.Items)
	}
	events := proc.audit.(*audit.Memory).ForTenant("t-a")
	if len(events) != 1 || events[0].Action != "update_capability_matrix" {
		t.Fatalf("audit = %+v", events)
	}
	if len(proc.audit.(*audit.Memory).ForTenant("t-b")) != 0 {
		t.Fatal("tenant b saw tenant a audit")
	}

	missing := httptest.NewRecorder()
	handler.ServeHTTP(missing, authorize(httptest.NewRequest(http.MethodGet, "http://b.vodoge.com/v1/capability-matrix", nil)))
	if missing.Code != http.StatusNotFound {
		t.Fatalf("tenant b matrix status = %d", missing.Code)
	}
}

func TestEnrollmentCodesAndRulesAreTenantScoped(t *testing.T) {
	t.Parallel()

	tenants := directory.New(nil)
	_ = tenants.Cache.Store(region.Entry{TenantID: "t-a", Slug: "a", Region: "cn", Status: "active"})
	_ = tenants.Cache.Store(region.Entry{TenantID: "t-b", Slug: "b", Region: "intl", Status: "active"})
	proc := signedIn(newProcess("", nil, tenants, nil, nil))
	handler := proc.handler()

	create := authorize(httptest.NewRequest(http.MethodPost, "http://a.vodoge.com/v1/enrollment-codes", strings.NewReader(`{"ttl_hours":2}`)))
	create.Header.Set("Content-Type", "application/json")
	created := httptest.NewRecorder()
	handler.ServeHTTP(created, create)
	if created.Code != http.StatusCreated {
		t.Fatalf("create code status = %d body=%s", created.Code, created.Body.String())
	}

	listed := getJSON(t, handler, "http://a.vodoge.com/v1/enrollment-codes")
	if got := stringSlice(listed["codes"], "code"); len(got) != 1 {
		t.Fatalf("tenant a codes = %#v", listed)
	}
	other := getJSON(t, handler, "http://b.vodoge.com/v1/enrollment-codes")
	if got := stringSlice(other["codes"], "code"); len(got) != 0 {
		t.Fatalf("tenant b saw tenant a codes: %#v", other)
	}

	ruleReq := authorize(httptest.NewRequest(http.MethodPost, "http://a.vodoge.com/v1/rules", strings.NewReader(`{"name":"otp","matcher":{"body":"PIN[:\\s]+(\\d{4})"},"enabled":true}`)))
	ruleReq.Header.Set("Content-Type", "application/json")
	ruleRes := httptest.NewRecorder()
	handler.ServeHTTP(ruleRes, ruleReq)
	if ruleRes.Code != http.StatusCreated {
		t.Fatalf("create rule status = %d body=%s", ruleRes.Code, ruleRes.Body.String())
	}
	rulesBody := getJSON(t, handler, "http://a.vodoge.com/v1/rules")
	if got := stringSlice(rulesBody["rules"], "name"); len(got) != 1 || got[0] != "otp" {
		t.Fatalf("tenant a rules = %#v", rulesBody)
	}
}

// testSessions authenticates the fixtures without a database.
//
// A token is "session-<tenantID>", so a test can present the wrong tenant's
// token on purpose and watch it be refused.
type testSessions struct{}

func (testSessions) Session(_ context.Context, fingerprint []byte) (auth.Session, bool, error) {
	for _, tenantID := range []string{"t-a", "t-b"} {
		if string(auth.Fingerprint("session-"+tenantID)) == string(fingerprint) {
			return auth.Session{
				UserID:    "user-" + tenantID,
				TenantID:  tenantID,
				ExpiresAt: time.Now().Add(time.Hour),
			}, true, nil
		}
	}
	return auth.Session{}, false, nil
}

func (testSessions) CreateSession(context.Context, []byte, auth.Session) error { return nil }
func (testSessions) DeleteSession(context.Context, []byte) error               { return nil }

// signedIn installs the fixture session store so tenant-scoped routes can be
// reached at all.
func signedIn(proc *process) *process {
	proc.authSessions = testSessions{}
	return proc
}

// bearerFor returns the fixture token for the tenant behind a host label.
func bearerFor(host string) string {
	label, _, found := strings.Cut(host, ".")
	if !found {
		return ""
	}
	return "Bearer session-t-" + label
}

// authorize attaches the fixture credential for the request's own host.
func authorize(request *http.Request) *http.Request {
	host := request.Host
	if forwarded := request.Header.Get("X-Forwarded-Host"); forwarded != "" {
		host = forwarded
	}
	if token := bearerFor(host); token != "" {
		request.Header.Set("Authorization", token)
	}
	return request
}

func getJSON(t *testing.T, handler http.Handler, rawURL string) map[string]any {
	t.Helper()
	request := authorize(httptest.NewRequest(http.MethodGet, rawURL, nil))
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

// tenantFixture is two tenants with one device each, the shape every
// cross-tenant check needs.
func tenantFixture(t *testing.T) *process {
	t.Helper()
	tenants := directory.New(nil)
	for _, entry := range []region.Entry{
		{TenantID: "t-a", Slug: "a", Region: "cn", Status: "active"},
		{TenantID: "t-b", Slug: "b", Region: "intl", Status: "active"},
	} {
		if !tenants.Cache.Store(entry) {
			t.Fatalf("store tenant %s", entry.Slug)
		}
	}
	proc := signedIn(newProcess("", nil, tenants, nil, nil))
	proc.catalog = &catalog.Memory{
		Devices: map[string][]catalog.Device{
			"t-a": {{ID: "d-a", Name: "lab-a", State: "online"}},
			"t-b": {{ID: "d-b", Name: "lab-b", State: "offline"}},
		},
	}
	return proc
}

// Until this change the Host header alone decided the tenant, so anything that
// could reach the port could read any tenant's devices.
func TestTenantDataRequiresASession(t *testing.T) {
	t.Parallel()

	handler := tenantFixture(t).handler()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "http://a.vodoge.com/v1/devices", nil))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d body=%s, want 401", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "d-a") {
		t.Fatal("device data was served without a session")
	}
}

// The other half of the boundary: a real session must not become a key to every
// tenant just by changing which host it is presented to.
func TestASessionCannotReadAnotherTenant(t *testing.T) {
	t.Parallel()

	handler := tenantFixture(t).handler()
	request := httptest.NewRequest(http.MethodGet, "http://b.vodoge.com/v1/devices", nil)
	request.Header.Set("Authorization", "Bearer session-t-a")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d body=%s, want 403", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "d-b") {
		t.Fatal("tenant b data was served to a tenant a session")
	}
}

// A forged X-Forwarded-Host is the same attack through the header the console
// legitimately sets.
func TestAForwardedHostCannotRetargetASession(t *testing.T) {
	t.Parallel()

	handler := tenantFixture(t).handler()
	request := httptest.NewRequest(http.MethodGet, "/v1/devices", nil)
	request.Host = "127.0.0.1:18080"
	request.Header.Set("X-Forwarded-Host", "b.vodoge.com")
	request.Header.Set("Authorization", "Bearer session-t-a")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", response.Code)
	}
}

// An unknown subdomain stays unknown even for a caller holding a real session,
// so a valid credential cannot be used to enumerate which tenants exist.
func TestAnUnknownHostIsNotFoundEvenWithASession(t *testing.T) {
	t.Parallel()

	handler := tenantFixture(t).handler()
	request := httptest.NewRequest(http.MethodGet, "http://missing.vodoge.com/v1/devices", nil)
	request.Header.Set("Authorization", "Bearer session-t-a")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", response.Code)
	}
}

// A gateway started without a session store must refuse rather than quietly
// fall back to trusting the Host header, which is what it used to do.
func TestWithoutASessionStoreTenantDataIsRefused(t *testing.T) {
	t.Parallel()

	proc := tenantFixture(t)
	proc.authSessions = nil
	handler := proc.handler()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "http://a.vodoge.com/v1/devices", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", response.Code)
	}
	if strings.Contains(response.Body.String(), "d-a") {
		t.Fatal("device data was served with no way to authenticate")
	}
}

// An expired session is refused the same way an unknown one is, so a leaked
// cookie stops working on its own.
func TestAnExpiredSessionIsRefused(t *testing.T) {
	t.Parallel()

	proc := tenantFixture(t)
	proc.authSessions = expiredSessions{}
	handler := proc.handler()
	request := httptest.NewRequest(http.MethodGet, "http://a.vodoge.com/v1/devices", nil)
	request.Header.Set("Authorization", "Bearer session-t-a")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.Code)
	}
}

type expiredSessions struct{}

func (expiredSessions) Session(context.Context, []byte) (auth.Session, bool, error) {
	return auth.Session{
		UserID:    "user-t-a",
		TenantID:  "t-a",
		ExpiresAt: time.Now().Add(-time.Minute),
	}, true, nil
}

func (expiredSessions) CreateSession(context.Context, []byte, auth.Session) error { return nil }
func (expiredSessions) DeleteSession(context.Context, []byte) error               { return nil }
