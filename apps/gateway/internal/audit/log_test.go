package audit

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestMemoryLogIsTenantScoped(t *testing.T) {
	t.Parallel()
	log := &Memory{}
	if err := log.Append(context.Background(), "t-a", Event{Actor: "gateway", Action: "update_capability_matrix", Target: "matrix"}); err != nil {
		t.Fatal(err)
	}
	if err := log.Append(context.Background(), "t-b", Event{Actor: "gateway", Action: "update_rule", Target: "rule"}); err != nil {
		t.Fatal(err)
	}
	a := log.ForTenant("t-a")
	if len(a) != 1 || a[0].Action != "update_capability_matrix" {
		t.Fatalf("tenant a = %+v", a)
	}
	if len(log.ForTenant("t-missing")) != 0 {
		t.Fatal("missing tenant saw events")
	}
}

// Event is a response body, so its field names are wire format.
//
// It shipped with no struct tags at all -- the only response-shaped struct in
// this gateway that had none -- so encoding/json used the Go field names and
// /v1/audit answered {"Actor":...}. The console read row.action, got undefined,
// dropped every row and drew an empty audit log over a populated one, without
// throwing and without a wrong status code anywhere.
//
// The whole byte string is compared rather than key-by-key, because the failure
// mode is a key that is nearly right, and reading "actor" out of a map cannot
// tell you the encoder also emitted "Detail".
func TestEventMarshalsUnderTheKeysTheConsoleReads(t *testing.T) {
	t.Parallel()

	body, err := json.Marshal(Event{
		Actor:  "console",
		Action: "auth.login",
		Target: "operator@example.com",
		Detail: json.RawMessage(`{"ip":"203.0.113.7"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	const want = `{"actor":"console","action":"auth.login",` +
		`"target":"operator@example.com","detail":{"ip":"203.0.113.7"}}`
	if string(body) != want {
		t.Fatalf("marshalled Event =\n  %s\nwant\n  %s", body, want)
	}
}

// The rule, rather than one example of it.
//
// The test above pins today's four fields. This one holds the fifth: a field
// added later without a tag would encode under its Go name, and it would go out
// on a shipped endpoint with nothing to say so. The tag is not decoration here,
// it is the only thing that names the field for every reader.
func TestEveryEventFieldIsNamedForTheWire(t *testing.T) {
	t.Parallel()

	structure := reflect.TypeOf(Event{})
	for index := 0; index < structure.NumField(); index++ {
		field := structure.Field(index)
		if field.PkgPath != "" {
			continue // unexported: encoding/json never sees it
		}
		tag, ok := field.Tag.Lookup("json")
		if !ok {
			t.Errorf("Event.%s carries no json tag, so it goes out on /v1/audit "+
				"as %q -- the Go field name is not a wire name anybody agreed to",
				field.Name, field.Name)
			continue
		}
		name, _, _ := strings.Cut(tag, ",")
		switch {
		case name == "":
			t.Errorf("Event.%s has an empty json name, so it still encodes as %q",
				field.Name, field.Name)
		case name != strings.ToLower(name):
			t.Errorf("Event.%s encodes as %q; every other response struct in this "+
				"gateway is lowercase and the console reads lowercase",
				field.Name, name)
		}
	}
}
