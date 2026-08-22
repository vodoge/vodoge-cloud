package observe

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A metric that is absent and one that is zero look very different on a graph,
// and only one of them is the truth. Declared metrics must appear before
// anything has happened.
func TestADeclaredCounterReadsZeroBeforeAnythingHappens(t *testing.T) {
	t.Parallel()

	registry := New()
	registry.Count("vodoge_test_total", "help")
	exposed := registry.Expose()

	if !strings.Contains(exposed, "vodoge_test_total 0") {
		t.Fatalf("a declared counter should read zero:\n%s", exposed)
	}
}

// The same labels given in a different order are one series, not two.
func TestLabelOrderDoesNotSplitASeries(t *testing.T) {
	t.Parallel()

	registry := New()
	registry.Count("vodoge_test_total", "help")
	registry.Add("vodoge_test_total", 1, "a", "1", "b", "2")
	registry.Add("vodoge_test_total", 1, "b", "2", "a", "1")

	exposed := registry.Expose()
	if strings.Count(exposed, "vodoge_test_total{") != 1 {
		t.Fatalf("expected one series:\n%s", exposed)
	}
	if !strings.Contains(exposed, `{a="1",b="2"} 2`) {
		t.Fatalf("counts were not combined:\n%s", exposed)
	}
}

// A label value that could close its own quote would corrupt every metric
// after it in the scrape.
func TestALabelValueCannotBreakTheFormat(t *testing.T) {
	t.Parallel()

	registry := New()
	registry.Count("vodoge_test_total", "help")
	registry.Add("vodoge_test_total", 1, "route", `GET /"; evil`)

	// Asserted as the whole line: a substring check cannot tell an escaped
	// quote from a raw one, since the escaped form contains the raw form.
	exposed := strings.TrimSpace(registry.Expose())
	want := `vodoge_test_total{route="GET /\"; evil"} 1`
	if !strings.HasSuffix(exposed, want) {
		t.Fatalf("exposed:\n%s\nwant the last line to be:\n%s", exposed, want)
	}

	// And a backslash in the value must survive as an escaped backslash
	// rather than swallowing the character after it.
	registry.Add("vodoge_test_total", 1, "route", `back\slash`)
	if !strings.Contains(registry.Expose(), `back\\slash`) {
		t.Fatalf("a backslash was not escaped:\n%s", registry.Expose())
	}
}

// Route patterns, never paths. A label per device id is an unbounded number of
// series, which is how a metrics system gets destroyed by one deployment.
func TestTheRouteLabelIsThePatternNotThePath(t *testing.T) {
	t.Parallel()

	registry := New()
	Declare(registry)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/devices/{id}", func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusOK)
	})
	handler := Middleware(registry, mux)

	for _, id := range []string{"aaa", "bbb", "ccc"} {
		request := httptest.NewRequest(http.MethodGet, "/v1/devices/"+id, nil)
		handler.ServeHTTP(httptest.NewRecorder(), request)
	}

	exposed := registry.Expose()
	if strings.Contains(exposed, "aaa") {
		t.Fatalf("a device id reached a label:\n%s", exposed)
	}
	if !strings.Contains(exposed, `route="GET /v1/devices/{id}"`) {
		t.Fatalf("expected the route pattern:\n%s", exposed)
	}
	// Three requests, one series.
	if strings.Count(exposed, "vodoge_http_requests_total{") != 1 {
		t.Fatalf("expected one series for three requests:\n%s", exposed)
	}
}

func TestStatusesAreBucketedAndRateLimitsCounted(t *testing.T) {
	t.Parallel()

	registry := New()
	Declare(registry)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/thing", func(writer http.ResponseWriter, _ *http.Request) {
		http.Error(writer, "too many", http.StatusTooManyRequests)
	})
	handler := Middleware(registry, mux)
	handler.ServeHTTP(httptest.NewRecorder(),
		httptest.NewRequest(http.MethodPost, "/v1/thing", nil))

	exposed := registry.Expose()
	if !strings.Contains(exposed, `status="4xx"`) {
		t.Fatalf("expected a bucketed status:\n%s", exposed)
	}
	if !strings.Contains(exposed, "vodoge_requests_rate_limited_total{") {
		t.Fatalf("a 429 should be counted as rate limited:\n%s", exposed)
	}
}

// A typo in a metric name must not take down the thing being measured.
func TestAnUnknownMetricIsIgnored(t *testing.T) {
	t.Parallel()

	registry := New()
	registry.Add("vodoge_typo_total", 1, "a", "b")
	registry.Set("vodoge_typo_gauge", 5)
	if exposed := registry.Expose(); exposed != "" {
		t.Fatalf("expected nothing:\n%s", exposed)
	}
}

// Wrapping a ResponseWriter hides the interfaces the real one implements. The
// two things this gateway does that are not plain request/response — the
// device WebSocket and the console's event stream — both depend on exactly
// those, and the first version of this middleware broke every device upgrade
// with a 500.
func TestTheWrapperStillSupportsHijackAndFlush(t *testing.T) {
	t.Parallel()

	registry := New()
	Declare(registry)

	var hijackable, flushable bool
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/edge", func(writer http.ResponseWriter, _ *http.Request) {
		_, hijackable = writer.(http.Hijacker)
		_, flushable = writer.(http.Flusher)
	})

	handler := Middleware(registry, mux)
	handler.ServeHTTP(httptest.NewRecorder(),
		httptest.NewRequest(http.MethodGet, "/v1/edge", nil))

	if !hijackable {
		t.Fatal("the WebSocket upgrade cannot hijack the connection")
	}
	if !flushable {
		t.Fatal("the event stream cannot flush")
	}
}
