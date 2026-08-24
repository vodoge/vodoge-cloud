package openapi

import (
	"encoding/json"
	"strings"
	"testing"
)

// minimal is a document that renders, so each test can break exactly one thing.
func minimal() Document {
	return Document{
		Title:   "Test",
		Version: "1.0.0",
		Tags:    []Tag{{Name: "things"}},
		SecuritySchemes: []SecurityScheme{
			{Name: "session", Type: "http", Scheme: "bearer"},
		},
		Operations: []Operation{{
			Method: "GET", Path: "/v1/things", Tag: "things",
			Summary:  "List things.",
			Security: []string{"session"},
			Responses: []Response{{
				Status: 200, Description: "The things.",
				MediaType: "application/json",
				Schema:    &Schema{Type: "object", Fields: []Field{{Name: "things", Required: true, Schema: Schema{Type: "array", Items: &Schema{Type: "object", Free: true}}}}},
			}},
		}},
	}
}

func render(t *testing.T, document Document) map[string]any {
	t.Helper()
	body, err := Render(document)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	var root map[string]any
	if err := json.Unmarshal(body, &root); err != nil {
		t.Fatalf("rendered document is not JSON: %v", err)
	}
	return root
}

func mustFail(t *testing.T, document Document, want string) {
	t.Helper()
	if _, err := Render(document); err == nil {
		t.Fatalf("rendered a document that should have been refused (%s)", want)
	} else if !strings.Contains(err.Error(), want) {
		t.Fatalf("error = %q, want it to mention %q", err, want)
	}
}

func TestRenderProducesA31Document(t *testing.T) {
	root := render(t, minimal())
	if root["openapi"] != SpecVersion {
		t.Errorf("openapi = %v, want %v", root["openapi"], SpecVersion)
	}
	if root["jsonSchemaDialect"] == nil {
		t.Error("no jsonSchemaDialect: a 3.1 document that does not state its dialect " +
			"makes every reader guess")
	}
	if _, ok := root["paths"].(map[string]any)["/v1/things"]; !ok {
		t.Errorf("paths = %v, want /v1/things", root["paths"])
	}
}

// Path parameters are the half of a hand-written document that is wrong most
// often, so they are not hand-written: they come out of the template.
func TestPathParametersComeFromTheTemplate(t *testing.T) {
	document := minimal()
	document.Operations[0].Path = "/v1/cards/{iccid}/policy"
	root := render(t, document)

	item := root["paths"].(map[string]any)["/v1/cards/{iccid}/policy"].(map[string]any)
	parameters := item["get"].(map[string]any)["parameters"].([]any)
	if len(parameters) != 1 {
		t.Fatalf("got %d parameters, want 1 derived from the template", len(parameters))
	}
	parameter := parameters[0].(map[string]any)
	if parameter["name"] != "iccid" || parameter["in"] != "path" {
		t.Errorf("parameter = %v, want iccid in path", parameter)
	}
	// OpenAPI has no optional path parameters, and a document that claimed one
	// would be refused by every validator.
	if parameter["required"] != true {
		t.Errorf("iccid is not required; path parameters always are")
	}
}

// A description can be attached to a parameter the template declares, but a
// parameter the template does not declare cannot be invented -- that is a
// document describing a route shape the router does not have.
func TestAPathParameterCannotBeInvented(t *testing.T) {
	document := minimal()
	document.Operations[0].Path = "/v1/cards/{iccid}/policy"
	document.Operations[0].PathParams = []Parameter{{Name: "imei", Description: "no such thing"}}
	mustFail(t, document, "the path template does not declare")
}

// Go's ServeMux can express two path shapes OpenAPI cannot. Refused rather
// than dropped: a route whose shape cannot be written down is a route the
// document would be lying about.
func TestPatternsOpenAPICannotExpressAreRefused(t *testing.T) {
	for _, path := range []string{"/v1/files/{rest...}", "/v1/exact/{$}"} {
		document := minimal()
		document.Operations[0].Path = path
		mustFail(t, document, "OpenAPI cannot express")
	}
}

func TestADuplicateOperationIsRefused(t *testing.T) {
	document := minimal()
	document.Operations = append(document.Operations, document.Operations[0])
	mustFail(t, document, "declared twice")
}

func TestAnOperationWithoutASummaryIsRefused(t *testing.T) {
	document := minimal()
	document.Operations[0].Summary = "  "
	mustFail(t, document, "no summary")
}

func TestAnOperationWithoutResponsesIsRefused(t *testing.T) {
	document := minimal()
	document.Operations[0].Responses = nil
	mustFail(t, document, "documents no responses")
}

func TestAnUnknownMethodIsRefused(t *testing.T) {
	document := minimal()
	document.Operations[0].Method = "FETCH"
	mustFail(t, document, "unusable method")
}

// A security scheme that was never declared renders as a requirement no reader
// can resolve, which reads as "protected" and means nothing.
func TestAnUndeclaredSecuritySchemeIsRefused(t *testing.T) {
	document := minimal()
	document.Operations[0].Security = []string{"mtls"}
	mustFail(t, document, "undeclared security scheme")
}

func TestAnUndeclaredTagIsRefused(t *testing.T) {
	document := minimal()
	document.Operations[0].Tag = "widgets"
	mustFail(t, document, "undeclared tag")
}

// An operation with no security is written out as an empty requirement list
// rather than left off. Leaving it off means "inherit", and inheriting is how
// an endpoint looks protected in a document while being open.
func TestNoSecurityIsWrittenDownRatherThanOmitted(t *testing.T) {
	document := minimal()
	document.Operations[0].Security = nil
	root := render(t, document)

	operation := root["paths"].(map[string]any)["/v1/things"].(map[string]any)["get"].(map[string]any)
	security, ok := operation["security"].([]any)
	if !ok {
		t.Fatalf("security = %v, want an empty list", operation["security"])
	}
	if len(security) != 0 {
		t.Errorf("security = %v, want it empty", security)
	}
}

// Identifiers are derived, so they cannot disagree with the route they name.
// Two routes that reduce to the same name would make them ambiguous instead,
// which is worse than a collision nobody sees.
func TestOperationIdentifiersAreDerivedAndUnique(t *testing.T) {
	document := minimal()
	document.Operations[0].Path = "/v1/proxy/instances/{id}/{action}"
	root := render(t, document)

	operation := root["paths"].(map[string]any)["/v1/proxy/instances/{id}/{action}"].(map[string]any)["get"].(map[string]any)
	if got := operation["operationId"]; got != "get_v1_proxy_instances_by_id_by_action" {
		t.Errorf("operationId = %v", got)
	}

	// Two distinct paths that reduce to the same identifier. Refused, because
	// an ambiguous operationId is worse than a hand-written one: tooling picks
	// whichever it saw last, silently.
	collide := minimal()
	collide.Operations[0].Path = "/v1/country-rules"
	collide.Operations = append(collide.Operations, Operation{
		Method: "GET", Path: "/v1/country_rules", Tag: "things",
		Summary:   "Same identifier, different path.",
		Security:  []string{"session"},
		Responses: []Response{{Status: 200, Description: "ok"}},
	})
	mustFail(t, collide, "collides on operationId")
}

// Keys is what a drift check compares against the route table.
func TestKeysAreSortedRouteTableEntries(t *testing.T) {
	document := minimal()
	document.Operations = append(document.Operations, Operation{
		Method: "DELETE", Path: "/v1/a", Tag: "things",
		Summary:   "First alphabetically.",
		Security:  []string{"session"},
		Responses: []Response{{Status: 204, Description: "gone"}},
	})
	keys := document.Keys()
	if len(keys) != 2 || keys[0] != "DELETE /v1/a" || keys[1] != "GET /v1/things" {
		t.Errorf("Keys() = %v", keys)
	}
}

// A templated server URL whose variables are not declared is not a valid
// document, and the failure is one a reader cannot work around: it cannot
// compute a base URL at all. Caught here because it was caught by an external
// validator first, which is the point of running one.
func TestServerVariablesAreHeldToTheURL(t *testing.T) {
	undeclared := minimal()
	undeclared.Servers = []Server{{URL: "https://{tenant}.example.com"}}
	mustFail(t, undeclared, "undeclared variable")

	unused := minimal()
	unused.Servers = []Server{{
		URL:       "https://example.com",
		Variables: []ServerVariable{{Name: "tenant", Default: "a"}},
	}}
	mustFail(t, unused, "which the URL does not use")

	noDefault := minimal()
	noDefault.Servers = []Server{{
		URL:       "https://{tenant}.example.com",
		Variables: []ServerVariable{{Name: "tenant"}},
	}}
	mustFail(t, noDefault, "no default")

	good := minimal()
	good.Servers = []Server{{
		URL:       "https://{tenant}.example.com",
		Variables: []ServerVariable{{Name: "tenant", Default: "a", Enum: []string{"a", "b"}}},
	}}
	root := render(t, good)
	server := root["servers"].([]any)[0].(map[string]any)
	variable := server["variables"].(map[string]any)["tenant"].(map[string]any)
	if variable["default"] != "a" {
		t.Errorf("variables.tenant = %v", variable)
	}
}

func TestPathParametersRejectsAPathThatIsNotOne(t *testing.T) {
	if _, err := PathParameters("v1/things"); err == nil {
		t.Fatal("accepted a path that does not start with /")
	}
}
