package proxy

import (
	"context"
	"net/url"
	"strings"
	"testing"
)

// The password used throughout. Every character in the tail is one a URL has
// to escape, and each of them has broken a hand-built connection string
// somewhere: "@" ends the userinfo, ":" splits it, "/" ends the authority,
// "?" starts a query and "#" starts a fragment.
const awkwardPassword = "p@ss:w/o?rd#1"

func exportFixture() ([]Instance, map[string]string) {
	instances := []Instance{
		{
			ID: "i-2", Name: "us-exit", DeviceID: "d-1",
			ModemIMEI: "867018069514820", Protocol: "socks5",
			ListenAddr: "0.0.0.0", ListenPort: 11080,
			AuthEnabled: true, Username: "vodoge", Enabled: true,
		},
		{
			ID: "i-1", Name: "hk-open", DeviceID: "d-1",
			ModemIMEI: "862547055142811", Protocol: "http",
			ListenAddr: "192.168.78.10", ListenPort: 18080,
			Enabled: false,
		},
	}
	return instances, map[string]string{"i-2": awkwardPassword}
}

func TestExportBuildsConnectionStringsAClientCanParse(t *testing.T) {
	t.Parallel()

	instances, secrets := exportFixture()
	endpoints, skipped, err := Export(instances, secrets, "edge-1.example.net")
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	if len(skipped) != 0 {
		t.Fatalf("skipped = %#v, want none once a host is given", skipped)
	}
	// Sorted by name so a diff between two exports is readable, which the
	// input order above is deliberately not.
	if endpoints[0].Name != "hk-open" || endpoints[1].Name != "us-exit" {
		t.Fatalf("order = %q, %q", endpoints[0].Name, endpoints[1].Name)
	}

	// Spelled out rather than rebuilt with net/url. An expected value produced
	// by the code under test is an expectation about nothing.
	if got, want := endpoints[1].URL,
		"socks5://vodoge:p%40ss%3Aw%2Fo%3Frd%231@edge-1.example.net:11080"; got != want {
		t.Errorf("url = %q, want %q", got, want)
	}
	// The escaping has to survive the trip back, because that is what a client
	// does with it.
	parsed, err := url.Parse(endpoints[1].URL)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	password, set := parsed.User.Password()
	if !set || password != awkwardPassword {
		t.Errorf("password round-tripped as %q (set=%v), want %q", password, set, awkwardPassword)
	}
	if parsed.User.Username() != "vodoge" || parsed.Host != "edge-1.example.net:11080" {
		t.Errorf("parsed = %#v", parsed)
	}

	// Auth disabled: no userinfo at all, rather than a colon with nothing
	// around it.
	if got, want := endpoints[0].URL, "http://edge-1.example.net:18080"; got != want {
		t.Errorf("url = %q, want %q", got, want)
	}
	// A stopped listener still exports. Whether it is running is a
	// device-reported fact the cloud does not have, and an operator who just
	// stopped one still wants its credential.
	if endpoints[0].Enabled {
		t.Error("enabled should report what was configured")
	}
	// The password of an instance with auth disabled is not attached, even
	// though one is stored for the other row.
	if endpoints[0].Password != "" {
		t.Error("a listener with auth disabled was given a password")
	}
}

// A listener bound to every interface has no address to hand out.
func TestExportRefusesToInventAnAddressForAWildcardListener(t *testing.T) {
	t.Parallel()

	instances, secrets := exportFixture()
	endpoints, skipped, err := Export(instances, secrets, "")
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	if len(endpoints) != 1 || endpoints[0].Name != "hk-open" {
		t.Fatalf("endpoints = %#v, want only the one with a concrete address", endpoints)
	}
	if len(skipped) != 1 || skipped[0].Name != "us-exit" {
		t.Fatalf("skipped = %#v", skipped)
	}
	// The reason has to carry the fix. "Not exportable" alone sends an
	// operator to read the source.
	if !strings.Contains(skipped[0].Reason, "?host=") {
		t.Errorf("reason = %q, want it to say how to get an export", skipped[0].Reason)
	}
	for _, endpoint := range endpoints {
		if strings.Contains(endpoint.URL, "0.0.0.0") {
			t.Errorf("emitted a wildcard address as something to dial: %q", endpoint.URL)
		}
	}
}

// The host lands in a URL an operator pastes without reading it, so anything
// that could redirect that paste somewhere else is refused.
func TestValidateExportHostRefusesAnythingThatIsNotAHost(t *testing.T) {
	t.Parallel()

	for _, host := range []string{
		"", "evil.example.net/redirect", "user@evil.example.net",
		"https://evil.example.net", "192.0.2.1:1080", "2001:db8::1",
		"has space", "a\nb", "%2fevil", "[not-an-ip]", "[2001:db8::1",
		strings.Repeat("a", 254),
	} {
		if err := ValidateExportHost(host); err == nil {
			t.Errorf("host %q was accepted", host)
		}
	}
	for _, host := range []string{
		"edge-1.example.net", "192.0.2.1", "127.0.0.1",
		"[2001:db8::1]", "localhost", "vm_edge", "example.net.",
	} {
		if err := ValidateExportHost(host); err != nil {
			t.Errorf("host %q was refused: %v", host, err)
		}
	}
	// And a bad host stops the whole export rather than producing a file with
	// some good lines and some redirecting ones.
	instances, secrets := exportFixture()
	if _, _, err := Export(instances, secrets, "evil.example.net/x"); err == nil {
		t.Error("export accepted a host with a path")
	}
}

func TestRenderLinesIsPasteable(t *testing.T) {
	t.Parallel()

	instances, secrets := exportFixture()
	endpoints, skipped, err := Export(instances, secrets, "")
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	body := RenderLines(endpoints, skipped)
	lines := strings.Split(strings.TrimRight(body, "\n"), "\n")
	if lines[0] != "http://192.168.78.10:18080" {
		t.Errorf("first line = %q, want a bare connection string", lines[0])
	}
	// Usable lines first, comments after: a consumer that stops at the first
	// line it does not understand still gets everything it can use.
	if !strings.HasPrefix(lines[1], "# us-exit:") {
		t.Errorf("second line = %q, want a comment naming the listener", lines[1])
	}
	if !strings.HasSuffix(body, "\n") {
		t.Error("the file does not end in a newline, which concatenating two of them needs")
	}
}

// A name is operator-supplied, and a newline in one would turn a comment into
// something that reads like another connection string.
func TestRenderLinesCannotBeBrokenByAName(t *testing.T) {
	t.Parallel()

	body := RenderLines(nil, []Unexportable{{
		Name:   "lab\nsocks5://attacker:pw@evil.example.net:1080",
		Reason: "no address\nsocks5://also-not-real:1080",
	}})
	for _, line := range strings.Split(strings.TrimRight(body, "\n"), "\n") {
		if !strings.HasPrefix(line, "# ") {
			t.Errorf("line %q escaped the comment", line)
		}
	}
}

func TestRenderCSVQuotesWhatItMust(t *testing.T) {
	t.Parallel()

	instances, secrets := exportFixture()
	endpoints, skipped, err := Export(instances, secrets, "edge-1.example.net")
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	body, err := RenderCSV(endpoints, skipped)
	if err != nil {
		t.Fatalf("csv: %v", err)
	}
	if !strings.HasPrefix(body, "name,protocol,host,port,username,password,url\n") {
		t.Fatalf("csv = %q", body)
	}
	// The raw password, not the percent-encoded one: a CSV cell is not a URL,
	// and a consumer building its own client config needs the real value.
	if !strings.Contains(body, awkwardPassword) {
		t.Errorf("csv does not carry the password: %q", body)
	}
}

// The audit detail identifies the export without reproducing it.
func TestAuditDetailNamesTheInstancesAndNotTheSecrets(t *testing.T) {
	t.Parallel()

	instances, secrets := exportFixture()
	endpoints, skipped, err := Export(instances, secrets, "")
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	detail := AuditDetail(endpoints, skipped, "lines")
	ids, _ := detail["instance_ids"].([]string)
	if len(ids) != 1 || ids[0] != "i-1" {
		t.Errorf("instance_ids = %#v", detail["instance_ids"])
	}
	if detail["exported"] != 1 || detail["unexportable"] != 1 || detail["format"] != "lines" {
		t.Errorf("detail = %#v", detail)
	}
	for key, value := range detail {
		if text, ok := value.(string); ok && strings.Contains(text, awkwardPassword) {
			t.Errorf("audit detail %q carries the password", key)
		}
	}
}

// The in-memory store has to answer the same question the SQL one does, or a
// gateway without a database exports nothing and nobody finds out until then.
func TestMemoryReturnsInstanceSecrets(t *testing.T) {
	t.Parallel()

	store := &Memory{}
	id, err := store.SaveInstance(context.Background(), "t-a", Instance{
		DeviceID: "d-1", Name: "one", ModemIMEI: "867018069514820",
		Protocol: "socks5", ListenAddr: "0.0.0.0", ListenPort: 11080,
		AuthEnabled: true, Username: "vodoge", Password: awkwardPassword,
	})
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	// The ordinary read still refuses to hand it over, which is the property
	// the export is an exception to rather than a repeal of.
	listed, err := store.Instances(context.Background(), "t-a", "")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if listed[0].Password != "" || !listed[0].HasPassword {
		t.Errorf("the ordinary list handed back a password: %#v", listed[0])
	}

	secrets, err := store.InstanceSecrets(context.Background(), "t-a")
	if err != nil {
		t.Fatalf("secrets: %v", err)
	}
	if secrets[id] != awkwardPassword {
		t.Errorf("secrets = %#v", secrets)
	}
	// Another tenant's context returns nothing, the same isolation every other
	// read in this package has.
	other, err := store.InstanceSecrets(context.Background(), "t-b")
	if err != nil {
		t.Fatalf("secrets: %v", err)
	}
	if len(other) != 0 {
		t.Errorf("tenant b saw tenant a's credentials: %#v", other)
	}
}
