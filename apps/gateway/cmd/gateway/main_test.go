package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/audit"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/auth"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/catalog"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/commands"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/directory"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/enroll"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/identity"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/ingress"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/messaging"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/notify"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/region"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/session"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/settings"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/wakeup"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/wss"
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
// token on purpose and watch it be refused. "readonly-<tenantID>" is the same
// session held by an account that may not change anything.
type testSessions struct{}

func (testSessions) Session(_ context.Context, fingerprint []byte) (auth.Session, bool, error) {
	for _, tenantID := range []string{"t-a", "t-b"} {
		if string(auth.Fingerprint("session-"+tenantID)) == string(fingerprint) {
			return auth.Session{
				UserID:    "user-" + tenantID,
				TenantID:  tenantID,
				Role:      auth.RoleAdmin,
				ExpiresAt: time.Now().Add(time.Hour),
			}, true, nil
		}
		if string(auth.Fingerprint("readonly-"+tenantID)) == string(fingerprint) {
			return auth.Session{
				UserID:    "viewer-" + tenantID,
				TenantID:  tenantID,
				Role:      auth.RoleReadOnly,
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

// A modem list is tenant data like any other, and it is the one that carries
// ICCIDs — so it must be behind the same boundary as the rest.
func TestModemsAreTenantScopedAndAuthenticated(t *testing.T) {
	t.Parallel()

	proc := tenantFixture(t)
	proc.catalog = &catalog.Memory{
		Modems: map[string][]catalog.Modem{
			"t-a": {{ID: "m-a", DeviceID: "d-a", IMEI: "862547055142811", Family: "EC20"}},
			"t-b": {{ID: "m-b", DeviceID: "d-b", IMEI: "867018069514820", Family: "EC20"}},
		},
	}
	handler := proc.handler()

	own := getJSON(t, handler, "http://a.vodoge.com/v1/modems")
	if got := stringSlice(own["modems"], "imei"); len(got) != 1 || got[0] != "862547055142811" {
		t.Fatalf("tenant a modems = %#v", own)
	}

	noCredential := httptest.NewRecorder()
	handler.ServeHTTP(
		noCredential,
		httptest.NewRequest(http.MethodGet, "http://a.vodoge.com/v1/modems", nil),
	)
	if noCredential.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", noCredential.Code)
	}

	crossTenant := httptest.NewRequest(http.MethodGet, "http://b.vodoge.com/v1/modems", nil)
	crossTenant.Header.Set("Authorization", "Bearer session-t-a")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, crossTenant)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", response.Code)
	}
	if strings.Contains(response.Body.String(), "867018069514820") {
		t.Fatal("another tenant's modem was served")
	}
}

// Offboarding sets status rather than deleting the tenant, because audit_log
// has a foreign key to tenants with no cascade. That only stops anything if
// the boundary reads the status — it did not, so a suspended tenant kept
// working until every one of its sessions expired on its own.
func TestASuspendedTenantIsRefused(t *testing.T) {
	t.Parallel()

	proc := tenantFixture(t)
	if !proc.tenants.Cache.Store(region.Entry{
		TenantID: "t-a", Slug: "a", Region: "cn", Status: "suspended",
	}) {
		t.Fatal("store suspended tenant")
	}
	handler := proc.handler()

	withSession := httptest.NewRequest(http.MethodGet, "http://a.vodoge.com/v1/devices", nil)
	withSession.Header.Set("Authorization", "Bearer session-t-a")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, withSession)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", response.Code)
	}
	if strings.Contains(response.Body.String(), "lab-a") {
		t.Fatal("a suspended tenant's data was served")
	}

	// And it must not be able to mint a new session either, which is the one
	// thing offboarding has to stop.
	body := strings.NewReader(`{"email":"someone@example.com","password":"whatever-it-is"}`)
	loginRequest := httptest.NewRequest(http.MethodPost, "http://a.vodoge.com/v1/auth/login", body)
	login := httptest.NewRecorder()
	handler.ServeHTTP(login, loginRequest)
	if login.Code != http.StatusForbidden {
		t.Fatalf("login status = %d, want 403", login.Code)
	}
}

// A tenant that is still active must be unaffected by the check above.
func TestAnActiveTenantIsUnaffected(t *testing.T) {
	t.Parallel()

	handler := tenantFixture(t).handler()
	request := httptest.NewRequest(http.MethodGet, "http://a.vodoge.com/v1/devices", nil)
	request.Header.Set("Authorization", "Bearer session-t-a")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
}

// Sign-in accepted passwords as fast as a client could send them, which makes
// a short password a matter of hours rather than years.
func TestSignInIsRateLimited(t *testing.T) {
	t.Parallel()

	handler := tenantFixture(t).handler()
	attempt := func() int {
		body := strings.NewReader(`{"email":"someone@example.com","password":"guess-again"}`)
		request := httptest.NewRequest(http.MethodPost, "http://a.vodoge.com/v1/auth/login", body)
		request.RemoteAddr = "203.0.113.7:44444"
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response.Code
	}

	var limited bool
	for i := 0; i < 12; i++ {
		if attempt() == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("a dozen password guesses from one address were all accepted")
	}
}

// Limiting by account would let anyone lock out a colleague by failing their
// password a few times, so a second address must be unaffected.
func TestOneAddressBeingLimitedDoesNotAffectAnother(t *testing.T) {
	t.Parallel()

	handler := tenantFixture(t).handler()
	attemptFrom := func(addr string) int {
		body := strings.NewReader(`{"email":"someone@example.com","password":"guess-again"}`)
		request := httptest.NewRequest(http.MethodPost, "http://a.vodoge.com/v1/auth/login", body)
		request.RemoteAddr = addr
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response.Code
	}

	for i := 0; i < 12; i++ {
		attemptFrom("203.0.113.9:1000")
	}
	if code := attemptFrom("198.51.100.4:1000"); code == http.StatusTooManyRequests {
		t.Fatal("a second address was limited by the first one's attempts")
	}
}

// A refusal has to say when, or a client retries in a tight loop and the
// limit costs more than it saves.
func TestARefusalSaysWhenToRetry(t *testing.T) {
	t.Parallel()

	handler := tenantFixture(t).handler()
	var last *httptest.ResponseRecorder
	for i := 0; i < 12; i++ {
		body := strings.NewReader(`{"email":"someone@example.com","password":"guess-again"}`)
		request := httptest.NewRequest(http.MethodPost, "http://a.vodoge.com/v1/auth/login", body)
		request.RemoteAddr = "192.0.2.55:5000"
		last = httptest.NewRecorder()
		handler.ServeHTTP(last, request)
		if last.Code == http.StatusTooManyRequests {
			break
		}
	}
	if last.Code != http.StatusTooManyRequests {
		t.Fatal("never reached the limit")
	}
	if last.Header().Get("Retry-After") == "" {
		t.Fatal("a 429 with no Retry-After tells the client nothing")
	}
}

// The journal is the only record of what a device actually said. It must be
// behind the same boundary as everything else, and it must not leak payloads
// to a listing that did not ask for them.
func TestTheJournalIsScopedAndPayloadsAreOptIn(t *testing.T) {
	t.Parallel()

	proc := tenantFixture(t)
	proc.catalog = &catalog.Memory{
		Events: map[string][]catalog.EventRow{
			"t-a": {{Seq: 1, DeviceID: "d-a", Kind: "DeviceState", ReceivedAt: 1000,
				Payload: []byte(`{"secret":"tenant-a-only"}`)}},
			"t-b": {{Seq: 1, DeviceID: "d-b", Kind: "DeviceState", ReceivedAt: 1000,
				Payload: []byte(`{"secret":"tenant-b-only"}`)}},
		},
	}
	handler := proc.handler()

	// A listing without payload=1 must not carry the payload at all.
	body := getJSON(t, handler, "http://a.vodoge.com/v1/journal")
	encoded, _ := json.Marshal(body)
	if strings.Contains(string(encoded), "tenant-a-only") {
		t.Fatal("payloads were returned to a listing that did not ask for them")
	}

	withPayload := getJSON(t, handler, "http://a.vodoge.com/v1/journal?payload=1")
	encoded, _ = json.Marshal(withPayload)
	if !strings.Contains(string(encoded), "tenant-a-only") {
		t.Fatal("payload=1 did not return the payload")
	}
	if strings.Contains(string(encoded), "tenant-b-only") {
		t.Fatal("another tenant's journal was served")
	}

	crossTenant := httptest.NewRequest(http.MethodGet, "http://b.vodoge.com/v1/journal", nil)
	crossTenant.Header.Set("Authorization", "Bearer session-t-a")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, crossTenant)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", response.Code)
	}
}

// recordingNotifier captures what would have been delivered.
type recordingNotifier struct{ events []notify.Event }

func (r *recordingNotifier) Notify(event notify.Event) { r.events = append(r.events, event) }

func quietLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestReapingClosesAnIdleSessionAndNotifiesNothing(t *testing.T) {
	t.Parallel()

	now := time.Now()
	hub := session.NewHub()
	closed := false
	hub.Bind(session.Connection{
		ID:           "connection-1",
		Device:       identity.Device{TenantID: "tenant-1", DeviceID: "device-1", Region: "cn"},
		ConnectedAt:  now.Add(-time.Hour),
		LastPacketAt: now.Add(-session.IdleTimeout - time.Second),
		Close:        func() { closed = true },
	})

	if reaped := reapIdleSessions(hub, quietLogger(), now); reaped != 1 {
		t.Fatalf("reaped = %d, want 1", reaped)
	}
	if !closed {
		t.Error("the reaped connection was not closed")
	}
	if _, bound := hub.Lookup("device-1"); bound {
		t.Error("the reaped connection is still bound")
	}
}

func TestASessionStillWithinTheIdleTimeoutIsLeftAlone(t *testing.T) {
	t.Parallel()

	now := time.Now()
	hub := session.NewHub()
	hub.Bind(session.Connection{
		ID:           "connection-1",
		Device:       identity.Device{TenantID: "tenant-1", DeviceID: "device-1"},
		LastPacketAt: now.Add(-session.IdleTimeout + time.Second),
		Close:        func() { t.Error("a live connection was closed") },
	})

	if reaped := reapIdleSessions(hub, quietLogger(), now); reaped != 0 {
		t.Fatalf("reaped = %d, want 0", reaped)
	}
}

// The drill that motivated all of this: block the uplink, and the session ends
// on a read timeout long before anything sweeps. The absence is what has to be
// measured, not the reaping.
func TestADeviceThatStaysAwayIsReportedOffline(t *testing.T) {
	t.Parallel()

	start := time.Now()
	hub := session.NewHub()
	absent := newAbsentDevices()
	alerts := &recordingNotifier{}

	absent.Left(identity.Device{TenantID: "tenant-1", DeviceID: "device-1"}, start)

	if raised := absent.Report(hub, alerts, quietLogger(), start.Add(offlineGrace-time.Second)); raised != 0 {
		t.Fatalf("raised = %d before the grace period elapsed, want 0", raised)
	}
	if raised := absent.Report(hub, alerts, quietLogger(), start.Add(offlineGrace)); raised != 1 {
		t.Fatalf("raised = %d at the grace period, want 1", raised)
	}
	// Still gone a long time later, but already reported: silence, not a
	// notification every 45 seconds for as long as the device is switched off.
	if raised := absent.Report(hub, alerts, quietLogger(), start.Add(time.Hour)); raised != 0 {
		t.Fatalf("raised = %d on a later tick, want 0", raised)
	}

	if len(alerts.events) != 1 {
		t.Fatalf("notifications = %d, want 1", len(alerts.events))
	}
	event := alerts.events[0]
	if event.Kind != notify.KindDeviceOffline {
		t.Errorf("kind = %q, want %q", event.Kind, notify.KindDeviceOffline)
	}
	if event.TenantID != "tenant-1" {
		t.Errorf("tenant_id = %q, want tenant-1", event.TenantID)
	}
	if !strings.Contains(event.Body, "device-1") {
		t.Errorf("body = %q, want it to name the device", event.Body)
	}
}

// Deploying the edge ends a session and the device is back in seconds. That
// must be silent, or the notification is worthless.
func TestADeviceThatComesStraightBackIsNotReported(t *testing.T) {
	t.Parallel()

	start := time.Now()
	hub := session.NewHub()
	absent := newAbsentDevices()
	alerts := &recordingNotifier{}

	device := identity.Device{TenantID: "tenant-1", DeviceID: "device-1"}
	absent.Left(device, start)
	hub.Bind(session.Connection{ID: "connection-2", Device: device, LastPacketAt: start.Add(20 * time.Second)})

	if raised := absent.Report(hub, alerts, quietLogger(), start.Add(offlineGrace*2)); raised != 0 {
		t.Fatalf("raised = %d for a device that reconnected, want 0", raised)
	}
	if len(alerts.events) != 0 {
		t.Fatalf("notifications = %d, want 0", len(alerts.events))
	}
}

// A device flapping through short sessions is away the whole time. Resetting
// the clock on each attempt would let it flap forever without ever being
// reported.
func TestFlappingDoesNotResetTheAbsenceClock(t *testing.T) {
	t.Parallel()

	start := time.Now()
	hub := session.NewHub()
	absent := newAbsentDevices()
	alerts := &recordingNotifier{}

	device := identity.Device{TenantID: "tenant-1", DeviceID: "device-1"}
	absent.Left(device, start)
	absent.Left(device, start.Add(30*time.Second))
	absent.Left(device, start.Add(60*time.Second))

	if raised := absent.Report(hub, alerts, quietLogger(), start.Add(offlineGrace)); raised != 1 {
		t.Fatalf("raised = %d, want 1 measured from the first departure", raised)
	}
}

// A gateway without a dispatcher still serves.
func TestReportingWithoutANotifierDoesNotPanic(t *testing.T) {
	t.Parallel()

	start := time.Now()
	absent := newAbsentDevices()
	absent.Left(identity.Device{TenantID: "tenant-1", DeviceID: "device-1"}, start)
	if raised := absent.Report(session.NewHub(), nil, quietLogger(), start.Add(offlineGrace)); raised != 1 {
		t.Fatalf("raised = %d, want 1", raised)
	}
}

// A wrong enum value is a property of the build, not of one payload, so the
// same fault arrives every few seconds per modem. Reporting each one turns a
// single regression into hundreds of notifications an hour.
func TestTheSameContractViolationIsReportedOncePerCooldown(t *testing.T) {
	t.Parallel()

	start := time.Now()
	offences := newContractViolations()
	alerts := &recordingNotifier{}
	device := identity.Device{TenantID: "tenant-1", DeviceID: "device-1"}

	if !offences.Raise(alerts, device, "device_state", []string{"state=weird"}, start) {
		t.Fatal("the first violation was not reported")
	}
	for _, after := range []time.Duration{time.Second, time.Minute, violationCooldown - time.Second} {
		if offences.Raise(alerts, device, "device_state", []string{"state=weird"}, start.Add(after)) {
			t.Fatalf("the same violation was reported again after %s", after)
		}
	}
	if offences.Raise(alerts, device, "device_state", []string{"state=weird"}, start.Add(violationCooldown)); len(alerts.events) != 2 {
		t.Fatalf("notifications = %d, want 2 once the cooldown elapsed", len(alerts.events))
	}

	event := alerts.events[0]
	if event.Kind != notify.KindContractViolation {
		t.Errorf("kind = %q, want %q", event.Kind, notify.KindContractViolation)
	}
	if event.TenantID != "tenant-1" {
		t.Errorf("tenant_id = %q, want tenant-1", event.TenantID)
	}
	if !strings.Contains(event.Body, "state=weird") {
		t.Errorf("body = %q, want it to name the offending field", event.Body)
	}
}

// Swallowing a second, different fault inside the first one's cooldown would
// make this worse than having no notification at all.
func TestADifferentViolationIsNotSwallowedByTheCooldown(t *testing.T) {
	t.Parallel()

	start := time.Now()
	offences := newContractViolations()
	alerts := &recordingNotifier{}
	device := identity.Device{TenantID: "tenant-1", DeviceID: "device-1"}

	offences.Raise(alerts, device, "device_state", []string{"state=weird"}, start)
	for _, other := range []struct {
		name  string
		kind  string
		found []string
	}{
		{"a different field", "device_state", []string{"bearer=weird"}},
		{"a different kind", "sms_received", []string{"state=weird"}},
	} {
		if !offences.Raise(alerts, device, other.kind, other.found, start.Add(time.Second)) {
			t.Errorf("%s was swallowed by the first violation's cooldown", other.name)
		}
	}
}

// Two tenants sharing a gateway must not silence each other.
func TestOneTenantsViolationDoesNotSilenceAnothers(t *testing.T) {
	t.Parallel()

	start := time.Now()
	offences := newContractViolations()
	alerts := &recordingNotifier{}

	offences.Raise(alerts, identity.Device{TenantID: "tenant-1", DeviceID: "d1"}, "device_state", []string{"state=weird"}, start)
	if !offences.Raise(alerts, identity.Device{TenantID: "tenant-2", DeviceID: "d2"}, "device_state", []string{"state=weird"}, start.Add(time.Second)) {
		t.Fatal("tenant-2 was silenced by tenant-1's cooldown")
	}
	if alerts.events[1].TenantID != "tenant-2" {
		t.Errorf("second notification went to %q, want tenant-2", alerts.events[1].TenantID)
	}
}

// opsSettings turns one channel on for every tenant.
type opsSettings struct{}

func (opsSettings) Get(context.Context, string, string) (map[string]any, error) {
	return map[string]any{"recorder": map[string]any{}}, nil
}

// opsChannel records what it was asked to deliver.
type opsChannel struct {
	delivered chan notify.Event
}

func (opsChannel) Name() string                   { return "recorder" }
func (opsChannel) Configured(map[string]any) bool { return true }
func (c opsChannel) Send(_ context.Context, _ map[string]any, event notify.Event) error {
	c.delivered <- event
	return nil
}

func opsTenants(t *testing.T) *directory.Resolver {
	t.Helper()
	tenants := directory.New(nil)
	if !tenants.Cache.Store(region.Entry{TenantID: "t-ops", Slug: "ops", Region: "cn", Status: "active"}) {
		t.Fatal("store the ops tenant")
	}
	return tenants
}

// The dump runs from a timer with no tenant context, and nothing may enumerate
// tenants, so an unconfigured gateway has no one to tell and must say so rather
// than accept reports it will drop.
func TestBackupFailureReportingIsOffUntilConfigured(t *testing.T) {
	t.Setenv("VODOGE_OPS_TOKEN", "")
	t.Setenv("VODOGE_OPS_TENANT", "")

	handler := newProcess("", ingress.NewJournal(), opsTenants(t), nil, nil).handler()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/ops/backup-failed", strings.NewReader(`{}`)))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", response.Code)
	}
}

// The route lives on the mux that also answers on the public device port, so a
// missing or wrong token must not reach the dispatcher.
func TestBackupFailureReportingRejectsABadToken(t *testing.T) {
	t.Setenv("VODOGE_OPS_TOKEN", "correct-token")
	t.Setenv("VODOGE_OPS_TENANT", "ops")

	handler := newProcess("", ingress.NewJournal(), opsTenants(t), nil, nil).handler()
	for _, presented := range []string{"", "wrong-token"} {
		request := httptest.NewRequest(http.MethodPost, "/v1/ops/backup-failed", strings.NewReader(`{}`))
		if presented != "" {
			request.Header.Set("X-VoDoge-Ops-Token", presented)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusForbidden {
			t.Errorf("token %q: status = %d, want 403", presented, response.Code)
		}
	}
}

func TestBackupFailureReachesTheConfiguredTenant(t *testing.T) {
	t.Setenv("VODOGE_OPS_TOKEN", "correct-token")
	t.Setenv("VODOGE_OPS_TENANT", "ops")

	delivered := make(chan notify.Event, 1)
	proc := newProcess("", ingress.NewJournal(), opsTenants(t), nil, nil)
	proc.notify = notify.New(opsSettings{}, []notify.Channel{opsChannel{delivered: delivered}}, notify.Options{})
	t.Cleanup(proc.notify.Close)
	handler := proc.handler()

	request := httptest.NewRequest(http.MethodPost, "/v1/ops/backup-failed",
		strings.NewReader(`{"detail":"pg_dump exited 1"}`))
	request.Header.Set("X-VoDoge-Ops-Token", "correct-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", response.Code)
	}

	select {
	case event := <-delivered:
		if event.Kind != notify.KindBackupFailed {
			t.Errorf("kind = %q, want %q", event.Kind, notify.KindBackupFailed)
		}
		if event.TenantID != "t-ops" {
			t.Errorf("tenant_id = %q, want t-ops", event.TenantID)
		}
		if !strings.Contains(event.Body, "pg_dump exited 1") {
			t.Errorf("body = %q, want the reported detail", event.Body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no notification was delivered")
	}
}

// hourly_limit was validated and stored from the day the settings page
// existed, and read by nobody: a tenant could set 2 and send two hundred.
func TestTheHourlySendLimitIsEnforced(t *testing.T) {
	t.Parallel()

	tenants := directory.New(nil)
	_ = tenants.Cache.Store(region.Entry{TenantID: "t-a", Slug: "a", Region: "cn", Status: "active"})
	proc := signedIn(newProcess("", nil, tenants, nil, nil))
	proc.catalog = &catalog.Memory{
		Devices: map[string][]catalog.Device{"t-a": {{ID: "d-a", Name: "lab-a", State: "online"}}},
	}
	proc.inbox = &messaging.Memory{}
	config := &settings.Memory{}
	if err := config.Put(context.Background(), "t-a", settings.SectionSMS,
		map[string]any{"hourly_limit": 2}); err != nil {
		t.Fatal(err)
	}
	proc.config = config
	handler := proc.handler()

	send := func() int {
		request := authorize(httptest.NewRequest(http.MethodPost,
			"http://a.vodoge.com/v1/commands",
			strings.NewReader(`{"device_id":"d-a","kind":"send_sms","modem_imei":"862547055142811","to":"+15551212","body":"hi"}`)))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response.Code
	}

	for i := 1; i <= 2; i++ {
		if code := send(); code != http.StatusOK {
			t.Fatalf("send %d: status = %d, want 200", i, code)
		}
	}
	if code := send(); code != http.StatusTooManyRequests {
		t.Fatalf("third send: status = %d, want 429", code)
	}

	// The refused one must not have been queued, or the limit would only be
	// changing the status code the console sees.
	queue := proc.queue.(*commands.Memory)
	if len(queue.Items) != 2 {
		t.Fatalf("queued = %d, want 2", len(queue.Items))
	}
}

// Zero means no limit, and so does an unset field. Reading an absent value as
// a limit of zero-allowed would silently stop every tenant from sending.
func TestNoConfiguredLimitDoesNotStopSending(t *testing.T) {
	t.Parallel()

	for _, document := range []map[string]any{
		{},
		{"hourly_limit": 0},
	} {
		tenants := directory.New(nil)
		_ = tenants.Cache.Store(region.Entry{TenantID: "t-a", Slug: "a", Region: "cn", Status: "active"})
		proc := signedIn(newProcess("", nil, tenants, nil, nil))
		proc.catalog = &catalog.Memory{
			Devices: map[string][]catalog.Device{"t-a": {{ID: "d-a", Name: "lab-a", State: "online"}}},
		}
		proc.inbox = &messaging.Memory{}
		config := &settings.Memory{}
		if err := config.Put(context.Background(), "t-a", settings.SectionSMS, document); err != nil {
			t.Fatal(err)
		}
		proc.config = config
		handler := proc.handler()

		for i := 1; i <= 5; i++ {
			request := authorize(httptest.NewRequest(http.MethodPost,
				"http://a.vodoge.com/v1/commands",
				strings.NewReader(`{"device_id":"d-a","kind":"send_sms","modem_imei":"862547055142811","to":"+15551212","body":"hi"}`)))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("config %v send %d: status = %d body=%s",
					document, i, response.Code, response.Body.String())
			}
		}
	}
}

// Two commands issued back to back must not share an idempotency key.
//
// The key was built from time.Now().UnixNano(), which names a unit and
// promises nothing about resolution -- on Windows successive calls return the
// same value, and this test failed against that within three requests.
// app.enqueue_command treats a repeated key as the same command, so in
// production the second send was dropped with a 200 carrying the first
// command's id, or raised when the bodies differed.
func TestCommandsIssuedBackToBackGetDistinctKeys(t *testing.T) {
	t.Parallel()

	tenants := directory.New(nil)
	_ = tenants.Cache.Store(region.Entry{TenantID: "t-a", Slug: "a", Region: "cn", Status: "active"})
	proc := signedIn(newProcess("", nil, tenants, nil, nil))
	proc.catalog = &catalog.Memory{
		Devices: map[string][]catalog.Device{"t-a": {{ID: "d-a", Name: "lab-a", State: "online"}}},
	}
	handler := proc.handler()

	const sends = 20
	for i := 0; i < sends; i++ {
		request := authorize(httptest.NewRequest(http.MethodPost,
			"http://a.vodoge.com/v1/commands",
			strings.NewReader(`{"device_id":"d-a","kind":"restart_modem","modem_imei":"862547055142811"}`)))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("send %d: status = %d body=%s", i, response.Code, response.Body.String())
		}
	}

	seen := map[string]bool{}
	for _, item := range proc.queue.(*commands.Memory).Items {
		if seen[item.IdempotencyKey] {
			t.Fatalf("idempotency key %q was reused; the database would treat these as one command",
				item.IdempotencyKey)
		}
		seen[item.IdempotencyKey] = true
	}
	if len(seen) != sends {
		t.Fatalf("distinct keys = %d, want %d", len(seen), sends)
	}
}

// The reference is the whole point of a send reporting details.
//
// A delivery report names the message it is about by TP-MR and by nothing
// else, so a send whose reference was dropped can be observed to arrive and
// never matched to the row on the operator's screen.
func TestTheMessageReferenceIsTakenFromASendsDetails(t *testing.T) {
	t.Parallel()

	if got := messageReference([]byte(`{"message_reference":42}`)); got == nil || *got != 42 {
		t.Fatalf("reference = %v, want 42", got)
	}
	// Zero is a real reference. Returning nil for it would leave the first
	// message of every wrap unmatched.
	if got := messageReference([]byte(`{"message_reference":0}`)); got == nil || *got != 0 {
		t.Fatalf("reference = %v, want 0", got)
	}
	for name, details := range map[string]string{
		"absent":       `{"port":"/dev/ttyUSB6"}`,
		"empty":        ``,
		"not json":     `+CSQ: 31,99`,
		"wrong type":   `{"message_reference":"42"}`,
		"another kind": `{"lines":["OK"]}`,
	} {
		if got := messageReference([]byte(details)); got != nil {
			t.Fatalf("%s: reference = %v, want nil rather than a guess", name, *got)
		}
	}
}

// Unread state and contact names have to survive the round trip through the
// routes, not just the store: the console reads them from this JSON.
func TestTheInboxReportsUnreadAndContactNames(t *testing.T) {
	t.Parallel()

	tenants := directory.New(nil)
	_ = tenants.Cache.Store(region.Entry{TenantID: "t-a", Slug: "a", Region: "cn", Status: "active"})
	proc := signedIn(newProcess("", nil, tenants, nil, nil))
	inbox := &messaging.Memory{}
	inbox.Seed("t-a", messaging.Message{
		DeviceID: "d-a", Direction: "inbound", Peer: "10086",
		Body: "余额 12.34 元", Status: "received", ReceivedAt: 1000,
	})
	proc.inbox = inbox
	handler := proc.handler()

	get := func(path string) map[string]any {
		request := authorize(httptest.NewRequest(http.MethodGet, "http://a.vodoge.com"+path, nil))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("GET %s: status = %d body=%s", path, response.Code, response.Body.String())
		}
		var body map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body
	}
	send := func(method, path, payload string) int {
		request := authorize(httptest.NewRequest(method, "http://a.vodoge.com"+path,
			strings.NewReader(payload)))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response.Code
	}

	threads := get("/v1/messages/threads")["threads"].([]any)
	first := threads[0].(map[string]any)
	if first["unread"] != float64(1) {
		t.Fatalf("unread = %v, want 1", first["unread"])
	}
	if first["name"] != "" {
		t.Fatalf("name = %v, want empty for an unnamed number", first["name"])
	}

	if code := send(http.MethodPut, "/v1/messages/contact",
		`{"peer":"10086","name":"中国移动","note":"运营商"}`); code != http.StatusOK {
		t.Fatalf("save contact: status = %d", code)
	}
	// A name with nothing in it would render as a blank cell where the number
	// used to be, so it is refused before it reaches the table constraint.
	if code := send(http.MethodPut, "/v1/messages/contact",
		`{"peer":"10086","name":"   "}`); code != http.StatusBadRequest {
		t.Fatalf("blank name: status = %d, want 400", code)
	}

	if code := send(http.MethodPost, "/v1/messages/thread/read",
		`{"peer":"10086"}`); code != http.StatusOK {
		t.Fatalf("mark read: status = %d", code)
	}

	threads = get("/v1/messages/threads")["threads"].([]any)
	first = threads[0].(map[string]any)
	if first["unread"] != float64(0) {
		t.Fatalf("unread = %v after reading, want 0", first["unread"])
	}
	if first["name"] != "中国移动" {
		t.Fatalf("name = %v", first["name"])
	}

	contacts := get("/v1/messages/contacts")["contacts"].([]any)
	if len(contacts) != 1 {
		t.Fatalf("contacts = %v, want one", contacts)
	}
}

// The schedule endpoints are tenant scoped like everything else, and a task is
// refused at creation when it cannot succeed rather than failing quietly on a
// cadence nobody is watching.
func TestScheduleRoutesAreTenantScopedAndValidateOnCreate(t *testing.T) {
	t.Parallel()

	tenants := directory.New(nil)
	_ = tenants.Cache.Store(region.Entry{TenantID: "t-a", Slug: "a", Region: "cn", Status: "active"})
	_ = tenants.Cache.Store(region.Entry{TenantID: "t-b", Slug: "b", Region: "intl", Status: "active"})
	proc := signedIn(newProcess("", nil, tenants, nil, nil))
	handler := proc.handler()

	create := authorize(httptest.NewRequest(http.MethodPost,
		"http://a.vodoge.com/v1/schedules",
		strings.NewReader(`{"name":"keepalive","command_kind":"send_sms",`+
			`"selector":{"mode":"card","iccid":"8986003031401770106"},`+
			`"request":{"to":"10086","body":"1"},"interval_seconds":3600}`)))
	create.Header.Set("Content-Type", "application/json")
	created := httptest.NewRecorder()
	handler.ServeHTTP(created, create)
	if created.Code != http.StatusCreated {
		t.Fatalf("create schedule status = %d body=%s", created.Code, created.Body.String())
	}

	listed := getJSON(t, handler, "http://a.vodoge.com/v1/schedules")
	names := stringSlice(listed["schedules"], "name")
	if len(names) != 1 || names[0] != "keepalive" {
		t.Fatalf("tenant a schedules = %#v", listed)
	}
	other := getJSON(t, handler, "http://b.vodoge.com/v1/schedules")
	if got := stringSlice(other["schedules"], "name"); len(got) != 0 {
		t.Fatalf("tenant b saw tenant a schedules: %#v", other)
	}

	// An SMS with no body cannot ever succeed, so it is refused now rather
	// than at 03:00 with nobody looking.
	bad := authorize(httptest.NewRequest(http.MethodPost,
		"http://a.vodoge.com/v1/schedules",
		strings.NewReader(`{"name":"broken","command_kind":"send_sms",`+
			`"selector":{"mode":"card","iccid":"1"},"request":{"to":"10086"},`+
			`"interval_seconds":3600}`)))
	bad.Header.Set("Content-Type", "application/json")
	refused := httptest.NewRecorder()
	handler.ServeHTTP(refused, bad)
	if refused.Code != http.StatusBadRequest {
		t.Fatalf("empty-body schedule status = %d body=%s", refused.Code, refused.Body.String())
	}
	if !strings.Contains(refused.Body.String(), "body") {
		t.Fatalf("refusal does not say what is wrong: %s", refused.Body.String())
	}

	// A cadence the tick cannot serve is refused too.
	fast := authorize(httptest.NewRequest(http.MethodPost,
		"http://a.vodoge.com/v1/schedules",
		strings.NewReader(`{"name":"toofast","command_kind":"send_sms",`+
			`"selector":{"mode":"card","iccid":"1"},`+
			`"request":{"to":"10086","body":"1"},"interval_seconds":5}`)))
	fast.Header.Set("Content-Type", "application/json")
	tooFast := httptest.NewRecorder()
	handler.ServeHTTP(tooFast, fast)
	if tooFast.Code != http.StatusBadRequest {
		t.Fatalf("5-second cadence status = %d", tooFast.Code)
	}
}

// The scheduler's whole answer to tenant enumeration is this tracker, so it has
// to hold what a Resume gave it and let go of what the hub no longer holds.
func TestLiveDevicesReportsTenantsAndForgetsDisconnected(t *testing.T) {
	t.Parallel()

	hub := session.NewHub()
	live := newLiveDevices()
	now := time.Now()
	for _, pair := range [][2]string{{"t-a", "d1"}, {"t-a", "d2"}, {"t-b", "d3"}} {
		hub.Bind(session.Connection{
			ID:           "c-" + pair[1],
			Device:       identity.Device{TenantID: pair[0], DeviceID: pair[1], Region: "cn"},
			ConnectedAt:  now,
			LastPacketAt: now,
		})
		live.Seen(pair[0], pair[1])
	}
	tenants := live.Tenants(hub)
	if len(tenants) != 2 || len(tenants["t-a"]) != 2 || len(tenants["t-b"]) != 1 {
		t.Fatalf("tenants = %#v", tenants)
	}

	hub.Unbind("c-d3")
	tenants = live.Tenants(hub)
	if _, still := tenants["t-b"]; still {
		t.Fatalf("a tenant with no live device is still ticking: %#v", tenants)
	}
	if len(tenants["t-a"]) != 2 {
		t.Fatalf("tenant a lost devices it still has: %#v", tenants)
	}

	// A device that reconnects comes back without anything having to notice it
	// left, because the tracker is read through the hub rather than trusted.
	hub.Bind(session.Connection{
		ID:           "c-d3-again",
		Device:       identity.Device{TenantID: "t-b", DeviceID: "d3", Region: "cn"},
		ConnectedAt:  now,
		LastPacketAt: now,
	})
	live.Seen("t-b", "d3")
	if got := live.Tenants(hub); len(got["t-b"]) != 1 {
		t.Fatalf("reconnected device did not return: %#v", got)
	}
}

// Two gateway processes must not share a lease owner, or the lease stops being
// able to tell them apart -- which is the situation it exists to handle.
func TestSchedulerOwnersAreDistinctPerProcess(t *testing.T) {
	if a, b := schedulerOwner(), schedulerOwner(); a == b {
		t.Fatalf("two processes would claim leases as %q", a)
	}
}

// ---------------------------------------------------------------------------
// Read-only accounts, checked against the route table rather than a list.
//
// The list is the whole problem. A hand-written set of "the dangerous routes"
// is correct until the next route is added, and nothing fails when it is not
// updated -- the account simply gains a power nobody meant to give it, and it
// stays invisible until it is used. So the routes come out of the source that
// registers them: add one and it is exercised here on the next run, and if the
// guard does not cover it this test fails.
// ---------------------------------------------------------------------------

// route is one registered mux pattern.
type route struct {
	method string
	path   string
	source string
}

// packageRouteConstants resolves the route patterns that are not written out
// as literals.
//
// Only two exist. Anything else that appears makes routesFromSource fail
// loudly rather than skip the route: a pattern this test cannot read is a
// pattern it cannot check, and skipping it quietly is exactly the hole the
// whole exercise is here to close.
var packageRouteConstants = map[string]string{
	"enroll.Path": enroll.Path,
	"wss.Path":    wss.Path,
}

// routesFromSource reads every mux registration in this package.
//
// Parsing the source rather than asking the ServeMux, because http.ServeMux
// does not enumerate what has been registered; and rather than keeping a
// second list, because a second list is the thing that goes stale.
func routesFromSource(t *testing.T) []route {
	t.Helper()

	fileSet := token.NewFileSet()
	packages, err := parser.ParseDir(fileSet, ".", func(info os.FileInfo) bool {
		return !strings.HasSuffix(info.Name(), "_test.go")
	}, parser.SkipObjectResolution)
	if err != nil {
		t.Fatalf("parse package source: %v", err)
	}

	seen := map[string]bool{}
	var routes []route
	for _, pkg := range packages {
		for name, file := range pkg.Files {
			ast.Inspect(file, func(node ast.Node) bool {
				call, ok := node.(*ast.CallExpr)
				if !ok || len(call.Args) == 0 {
					return true
				}
				selector, ok := call.Fun.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				// Any receiver, not only one named `mux`: a second router
				// introduced later should be enumerated too rather than
				// silently left out of the count.
				if _, ok := selector.X.(*ast.Ident); !ok {
					return true
				}
				if selector.Sel.Name != "Handle" && selector.Sel.Name != "HandleFunc" {
					return true
				}
				pattern, ok := routePattern(call.Args[0])
				if !ok {
					t.Fatalf("%s: cannot read the route pattern at %s. Add it to "+
						"packageRouteConstants -- a route this test cannot read "+
						"is a route it cannot check.",
						name, fileSet.Position(call.Args[0].Pos()))
				}
				method, path, found := strings.Cut(pattern, " ")
				if !found {
					t.Fatalf("%s: route %q has no method", name, pattern)
				}
				if seen[pattern] {
					// Registered twice behind an if/else: the configured and
					// unconfigured forms of the same endpoint.
					return true
				}
				seen[pattern] = true
				routes = append(routes, route{
					method: method,
					path:   path,
					source: filepath.Base(name),
				})
				return true
			})
		}
	}
	sort.Slice(routes, func(i, j int) bool {
		if routes[i].path != routes[j].path {
			return routes[i].path < routes[j].path
		}
		return routes[i].method < routes[j].method
	})
	return routes
}

// routePattern evaluates the first argument of a mux registration.
func routePattern(expr ast.Expr) (string, bool) {
	switch node := expr.(type) {
	case *ast.BasicLit:
		if node.Kind != token.STRING {
			return "", false
		}
		value, err := strconv.Unquote(node.Value)
		if err != nil {
			return "", false
		}
		return value, true
	case *ast.BinaryExpr:
		if node.Op != token.ADD {
			return "", false
		}
		left, leftOK := routePattern(node.X)
		right, rightOK := routePattern(node.Y)
		if !leftOK || !rightOK {
			return "", false
		}
		return left + right, true
	case *ast.SelectorExpr:
		pkg, ok := node.X.(*ast.Ident)
		if !ok {
			return "", false
		}
		value, known := packageRouteConstants[pkg.Name+"."+node.Sel.Name]
		return value, known
	}
	return "", false
}

// wildcards is every {name} placeholder in a mux pattern.
var wildcards = regexp.MustCompile(`\{[^}]*\}`)

// requestPath turns a registered pattern into a path that can be requested.
// The value substituted does not matter: the refusal happens before any
// handler looks at it.
func requestPath(pattern string) string {
	return wildcards.ReplaceAllString(pattern, "sample")
}

// The floor exists so that a refactor moving registration off mux.HandleFunc
// cannot turn this suite into one that enumerates nothing and passes. It is a
// floor, not the count: removing a route is allowed, quietly finding none is
// not.
const fewestRoutesEverRegistered = 60

// Every write route, one request each, with a read-only session.
//
// Not a sample. The tempting version of this rule is "the console does not
// draw the dangerous buttons", which is not a permission check at all: /v1 is
// reachable with curl and a token.
//
// What this holds, precisely. The guard wraps the mux rather than sitting
// inside it, so coverage of a route added tomorrow is structural — that is the
// point of putting it there, and main() serves exactly what handler() returns
// on both listeners. This test is what keeps that structure honest: it fails
// if the guard is removed, moved inside the mux, or narrowed; if a write route
// appears under the exempt prefix; if a registration appears that it cannot
// read; or if registrations stop looking like registrations. What it cannot
// see is a handler served from somewhere other than handler() — there is no
// such handler today, and the two http.Server values in main() are where to
// look if that ever changes.
func TestEveryWriteRouteRefusesAReadOnlySession(t *testing.T) {
	t.Parallel()

	routes := routesFromSource(t)
	if len(routes) < fewestRoutesEverRegistered {
		t.Fatalf("found %d routes, expected at least %d -- registration probably "+
			"moved and this test is now checking nothing",
			len(routes), fewestRoutesEverRegistered)
	}

	handler := tenantFixture(t).handler()
	var checked, exempt []string
	for _, registered := range routes {
		if !auth.ChangesState(registered.method) {
			continue
		}
		if auth.OwnCredential(registered.path) {
			exempt = append(exempt, registered.method+" "+registered.path)
			continue
		}
		checked = append(checked, registered.method+" "+registered.path)

		request := httptest.NewRequest(
			registered.method,
			"http://a.vodoge.com"+requestPath(registered.path),
			strings.NewReader("{}"),
		)
		request.Header.Set("Authorization", "Bearer readonly-t-a")
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)

		if response.Code != http.StatusForbidden {
			t.Errorf("%s %s (%s): status = %d, want 403 -- a read-only account "+
				"can reach this route", registered.method, registered.path,
				registered.source, response.Code)
			continue
		}
		// A 403 for some other reason would pass a status-only check even with
		// the guard missing entirely.
		if !strings.Contains(response.Body.String(), "read-only") {
			t.Errorf("%s %s: 403 body = %q, want the read-only refusal",
				registered.method, registered.path,
				strings.TrimSpace(response.Body.String()))
		}
	}

	if len(checked) == 0 {
		t.Fatal("no write routes were exercised")
	}
	t.Logf("%d write routes refused, %d exempt, %d routes registered",
		len(checked), len(exempt), len(routes))

	// The exemptions are pinned rather than trusted. auth.OwnCredential lets a
	// path through; if a write route appears that it also lets through, this
	// fails and someone has to decide on purpose.
	sort.Strings(exempt)
	want := []string{
		"POST /v1/auth/login",
		"POST /v1/auth/logout",
		"POST /v1/auth/password",
	}
	if !slices.Equal(exempt, want) {
		t.Errorf("exempt write routes = %v, want %v -- either a new route under "+
			"/v1/auth/ became exempt by accident, or an exemption was removed",
			exempt, want)
	}
}

// The other half: refusing writes must not turn into refusing the account.
func TestAReadOnlySessionCanStillRead(t *testing.T) {
	t.Parallel()

	handler := tenantFixture(t).handler()
	for _, registered := range routesFromSource(t) {
		if auth.ChangesState(registered.method) {
			continue
		}
		// The device WebSocket is not a console route: it authenticates with a
		// client certificate and answers an upgrade, not a body.
		if registered.path == wss.Path {
			continue
		}
		// Bounded, because /v1/events is a stream: it answers and then holds
		// the connection open until the caller goes away, and a recorder never
		// does. The deadline is the caller going away.
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		request := httptest.NewRequest(
			registered.method,
			"http://a.vodoge.com"+requestPath(registered.path),
			nil,
		).WithContext(ctx)
		request.Header.Set("Authorization", "Bearer readonly-t-a")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		cancel()
		if response.Code == http.StatusForbidden {
			t.Errorf("%s %s: read-only session refused a read (%s)",
				registered.method, registered.path,
				strings.TrimSpace(response.Body.String()))
		}
	}
}

// Signing out and rotating your own password are not tenant writes, and an
// account that can do neither is worse off with nobody safer.
func TestAReadOnlySessionKeepsItsOwnCredential(t *testing.T) {
	t.Parallel()

	handler := tenantFixture(t).handler()
	for _, path := range []string{"/v1/auth/logout", "/v1/auth/password"} {
		request := httptest.NewRequest(http.MethodPost, "http://a.vodoge.com"+path,
			strings.NewReader("{}"))
		request.Header.Set("Authorization", "Bearer readonly-t-a")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code == http.StatusForbidden {
			t.Errorf("%s: a read-only session was locked out of its own credential", path)
		}
	}
}

// An admin session is unaffected. Without this the guard could refuse
// everyone and every other assertion here would still pass.
func TestAnAdminSessionIsNotRefusedByTheReadOnlyGuard(t *testing.T) {
	t.Parallel()

	handler := tenantFixture(t).handler()
	request := httptest.NewRequest(http.MethodPost, "http://a.vodoge.com/v1/rules",
		strings.NewReader(`{"name":"r","event":"device.offline","channel":"webhook"}`))
	request.Header.Set("Authorization", "Bearer session-t-a")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code == http.StatusForbidden {
		t.Fatalf("admin write refused: %s", strings.TrimSpace(response.Body.String()))
	}
}

// The console renders by this, so it has to be there and it has to be right.
func TestTheSessionEndpointReportsTheRole(t *testing.T) {
	t.Parallel()

	handler := tenantFixture(t).handler()
	for token, want := range map[string]string{
		"session-t-a":  auth.RoleAdmin,
		"readonly-t-a": auth.RoleReadOnly,
	} {
		request := httptest.NewRequest(http.MethodGet, "http://a.vodoge.com/v1/auth/session", nil)
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("%s: status = %d", token, response.Code)
		}
		var body struct {
			Role string `json:"role"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Role != want {
			t.Errorf("%s: role = %q, want %q", token, body.Role, want)
		}
	}
}
