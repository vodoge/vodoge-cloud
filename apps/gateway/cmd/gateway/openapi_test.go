package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"testing"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/auth"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/enroll"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/openapi"
)

// ---------------------------------------------------------------------------
// The document against the route table.
//
// This is the test the OpenAPI document exists for. A description of an HTTP
// API is not documentation in the sense of prose that ages gracefully: it is a
// claim about what the server does, and a wrong claim is worse than none,
// because a client trusts it. Nothing here has ever caught that kind of
// wrongness by itself -- docs/feature-matrix said fifty-six routes long after
// there were sixty-six, and it said so confidently.
//
// So the set of documented operations is compared against the set of
// registered patterns, read out of this package's source by the same
// routesFromSource the read-only guard test uses. There is exactly one
// enumerator, and both tests fail if it ever stops enumerating.
// ---------------------------------------------------------------------------

func TestOpenAPIDescribesEveryRegisteredRoute(t *testing.T) {
	t.Parallel()

	registered := map[string]string{} // "METHOD /path" -> file it was registered in
	for _, route := range routesFromSource(t) {
		registered[route.method+" "+route.path] = route.source
	}
	if len(registered) < fewestRoutesEverRegistered {
		t.Fatalf("found %d routes, expected at least %d -- registration probably "+
			"moved and this test is now checking nothing",
			len(registered), fewestRoutesEverRegistered)
	}

	documented := map[string]bool{}
	for _, key := range apiDocument().Keys() {
		documented[key] = true
	}

	var undocumented, invented []string
	for key, source := range registered {
		if !documented[key] {
			undocumented = append(undocumented, key+"  (registered in "+source+")")
		}
	}
	for key := range documented {
		if _, ok := registered[key]; !ok {
			invented = append(invented, key)
		}
	}
	sort.Strings(undocumented)
	sort.Strings(invented)

	if len(undocumented) > 0 {
		t.Errorf("%d route(s) are registered but not described in openapi.go:\n  %s\n"+
			"Add an entry to apiOperations(). A route nobody described is a route "+
			"callers find by reading main.go, which is the state this document exists "+
			"to end.",
			len(undocumented), strings.Join(undocumented, "\n  "))
	}
	if len(invented) > 0 {
		t.Errorf("%d operation(s) are described in openapi.go but not registered:\n  %s\n"+
			"Either the route was removed and the entry was not, or a path was "+
			"mistyped. A document that describes routes the server does not have is "+
			"how a client ends up calling one.",
			len(invented), strings.Join(invented, "\n  "))
	}

	t.Logf("%d routes registered, %d described", len(registered), len(documented))
}

// The document has to render, and rendering is where it is validated: a
// missing summary, a duplicate operation, an undeclared tag or an undeclared
// security scheme are errors rather than a document that renders and is wrong
// somewhere in the middle.
func TestOpenAPIDocumentRenders(t *testing.T) {
	t.Parallel()

	body, err := openapi.Render(apiDocument())
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	var root struct {
		OpenAPI    string                    `json:"openapi"`
		Paths      map[string]map[string]any `json:"paths"`
		Components map[string]map[string]any `json:"components"`
	}
	if err := json.Unmarshal(body, &root); err != nil {
		t.Fatalf("the rendered document is not JSON: %v", err)
	}
	if root.OpenAPI != openapi.SpecVersion {
		t.Errorf("openapi = %q, want %q", root.OpenAPI, openapi.SpecVersion)
	}
	operations := 0
	for _, item := range root.Paths {
		operations += len(item)
	}
	if want := len(apiDocument().Keys()); operations != want {
		t.Errorf("rendered %d operations across %d paths, want %d",
			operations, len(root.Paths), want)
	}
	if len(root.Components["securitySchemes"]) == 0 {
		t.Error("no security schemes were rendered")
	}
}

// Which routes are reachable without a credential, pinned rather than trusted.
//
// The same reasoning as the read-only guard's exempt list. An endpoint quietly
// documented as open is a document that stops matching the server in the one
// direction that matters, and the fix has to be somebody deciding on purpose.
func TestOpenAPISecurityMatchesTheRoutesThatAreActuallyOpen(t *testing.T) {
	t.Parallel()

	var open []string
	for _, operation := range apiDocument().Operations {
		if len(operation.Security) == 0 {
			open = append(open, operation.Key())
		}
	}
	sort.Strings(open)
	want := []string{
		// The loopback listener. Not published beyond 127.0.0.1.
		"GET /healthz",
		"GET /metrics",
		"GET /readyz",
		// The uplink stream authenticates nothing today: it resolves the
		// tenant from the host and subscribes. Documented as it is rather
		// than as it ought to be -- a document that flattered the server here
		// would be the most dangerous line in it.
		"GET /v1/events",
		// Before there is a session: the console has to draw a sign-in page
		// and find out whether the subdomain exists at all.
		"GET /v1/tenant",
		"GET /v1/tenants/{slug}",
		"POST /v1/auth/login",
		// Signing out does not require a valid session; the caller wants it
		// gone either way.
		"POST /v1/auth/logout",
		// A device enrolling has no certificate yet. The one-time code is the
		// credential, and it is in the body.
		"POST " + enroll.Path,
	}
	if !equalStrings(open, want) {
		t.Errorf("operations documented as needing no credential =\n  %v\nwant\n  %v\n"+
			"Either a route became reachable without a credential, or one was "+
			"documented as open by accident. Neither should happen quietly.",
			open, want)
	}
}

// The new route must not have changed what the read-only guard covers.
//
// It is a GET, so it should not be a write route at all -- but "should" is
// what this project keeps getting caught by, and that guard is the only thing
// proving thirty write routes refuse a read-only session.
func TestTheOpenAPIRouteIsNotAWriteRoute(t *testing.T) {
	t.Parallel()

	found := false
	for _, route := range routesFromSource(t) {
		if route.path != apiSpecPath {
			continue
		}
		found = true
		if auth.ChangesState(route.method) {
			t.Fatalf("%s %s changes state: serving a document must not be a write, "+
				"and this would have enlarged the read-only guard's list",
				route.method, route.path)
		}
	}
	if !found {
		t.Fatalf("%s is not registered anywhere routesFromSource can see it -- "+
			"either it moved out of a literal pattern, or it is gone", apiSpecPath)
	}
}

// Serving it end to end, which is also the proof that the runtime check passes
// on the real router: serveOpenAPI answers 500 unless the live mux resolves
// every documented operation, so a 200 here means it did.
//
// A read-only account is included because it is the account most likely to be
// handed to somebody who needs to know what the API does.
func TestOpenAPIIsServedToASession(t *testing.T) {
	t.Parallel()

	handler := tenantFixture(t).handler()
	for _, token := range []string{"session-t-a", "readonly-t-a"} {
		request := httptest.NewRequest(http.MethodGet, "http://a.vodoge.com"+apiSpecPath, nil)
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)

		if response.Code != http.StatusOK {
			t.Fatalf("%s: status = %d body = %s, want 200",
				token, response.Code, strings.TrimSpace(response.Body.String()))
		}
		var root struct {
			OpenAPI string                    `json:"openapi"`
			Paths   map[string]map[string]any `json:"paths"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &root); err != nil {
			t.Fatalf("%s: the served document is not JSON: %v", token, err)
		}
		if root.OpenAPI != openapi.SpecVersion {
			t.Errorf("%s: openapi = %q, want %q", token, root.OpenAPI, openapi.SpecVersion)
		}

		// The served bytes, not the in-process value: this is what a caller on
		// the far side of Caddy actually receives.
		var served []string
		for path, item := range root.Paths {
			for method := range item {
				served = append(served, strings.ToUpper(method)+" "+path)
			}
		}
		sort.Strings(served)
		if !equalStrings(served, apiDocument().Keys()) {
			t.Errorf("%s: the served document describes %d operations, this process "+
				"describes %d", token, len(served), len(apiDocument().Keys()))
		}
	}
}

// The document is a map of the whole attack surface, so it sits behind the
// same session gate as the routes it maps.
func TestOpenAPINeedsASession(t *testing.T) {
	t.Parallel()

	handler := tenantFixture(t).handler()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(
		http.MethodGet, "http://a.vodoge.com"+apiSpecPath, nil))

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d body = %s, want 401",
			response.Code, strings.TrimSpace(response.Body.String()))
	}
	if strings.Contains(response.Body.String(), "/v1/enrollment-codes") {
		t.Fatal("the route map was served without a session")
	}
}

// The drift test proves the document matches this source tree. It says nothing
// about the binary somebody deployed, which is why the binary also checks
// itself against its own router before serving.
func TestOpenAPIRefusesADocumentTheRouterDoesNotBack(t *testing.T) {
	t.Parallel()

	// An empty mux stands in for a binary whose registration has diverged from
	// its document: every documented route is missing at once.
	handler := tenantFixture(t).serveOpenAPI(http.NewServeMux())
	request := httptest.NewRequest(http.MethodGet, "http://a.vodoge.com"+apiSpecPath, nil)
	request.Header.Set("Authorization", "Bearer session-t-a")
	response := httptest.NewRecorder()
	handler(response, request)

	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 -- a document the router does not back must "+
			"not be served", response.Code)
	}
	body := strings.TrimSpace(response.Body.String())
	if !strings.Contains(body, "not registered") || !strings.Contains(body, apiSpecPath) {
		t.Errorf("body = %q, want it to name the routes that are missing", body)
	}
}

// A way to get the document onto disk for a validator that is not ours.
//
// Everything above checks the document against this repository's idea of what
// a document should be, which is the same trap as a test whose expected value
// and tested value come from the same place. Whether the result is actually
// OpenAPI 3.1 is a question only something that did not grow up here can
// answer -- run:
//
//	VODOGE_OPENAPI_OUT=/tmp/openapi.json go test -run TestWriteOpenAPIDocument ./cmd/gateway/
//	npx --yes @redocly/cli lint /tmp/openapi.json
func TestWriteOpenAPIDocument(t *testing.T) {
	path := strings.TrimSpace(os.Getenv("VODOGE_OPENAPI_OUT"))
	if path == "" {
		t.Skip("set VODOGE_OPENAPI_OUT to write the document out for an external validator")
	}
	body, err := openapi.Render(apiDocument())
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	t.Logf("wrote %d bytes to %s", len(body), path)
}

func equalStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}
