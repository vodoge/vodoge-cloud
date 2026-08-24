// Package openapi renders an OpenAPI 3.1 document from a list of operations.
//
// It knows nothing about this gateway's routes, and that is deliberate. The
// operations are declared next to the code that registers them, in
// cmd/gateway, where a test compares the declared set against the mux
// registrations read out of the source. This package's job is the mechanical
// half: turn a list of operations into a document, and refuse to render one
// that is malformed.
//
// Two things are derived rather than written down, because both are places
// where a hand-written document goes quietly wrong:
//
//   - Path parameters come out of the path template. A route registered as
//     /v1/cards/{iccid}/policy documents an iccid parameter whether or not
//     anyone remembered, and a caller can add a description for one but
//     cannot invent a parameter the route does not have.
//   - Nothing is optional-by-omission. A missing summary, a duplicate
//     operation, an unknown method, a security scheme that was never declared
//     -- each is an error from Render, not a document that renders anyway and
//     is wrong somewhere in the middle.
package openapi

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// SpecVersion is the OpenAPI version this package emits.
const SpecVersion = "3.1.0"

// jsonSchemaDialect is the schema dialect 3.1 defaults to. Stated rather than
// left implicit so a reader does not have to guess.
const jsonSchemaDialect = "https://spec.openapis.org/oas/3.1/dialect/base"

// methods is every HTTP method that may appear in a path item. OpenAPI has a
// fixed set; a pattern registered with anything else is a mistake worth
// hearing about rather than a document that silently omits the route.
var methods = map[string]bool{
	"GET": true, "PUT": true, "POST": true, "DELETE": true,
	"OPTIONS": true, "HEAD": true, "PATCH": true, "TRACE": true,
}

// Document is a whole API description.
type Document struct {
	Title           string
	Version         string
	Summary         string
	Description     string
	Servers         []Server
	Tags            []Tag
	SecuritySchemes []SecurityScheme
	Operations      []Operation
}

// Server is one base URL the API is reachable at.
type Server struct {
	URL         string
	Description string
	// Variables must cover every {name} in URL and nothing else. A templated
	// server URL with an undeclared variable is not a valid document, and it
	// is the kind of thing only a validator catches.
	Variables []ServerVariable
}

// ServerVariable is one substitution in a templated server URL.
type ServerVariable struct {
	Name        string
	Default     string
	Description string
	Enum        []string
}

// Tag groups operations in a reader.
type Tag struct {
	Name        string
	Description string
}

// SecurityScheme is one way of authenticating, named so operations can refer
// to it.
type SecurityScheme struct {
	Name         string // the components.securitySchemes key
	Type         string // http | apiKey | mutualTLS
	Scheme       string // for type http, e.g. bearer
	BearerFormat string
	In           string // for type apiKey: header | query | cookie
	ParamName    string // for type apiKey: the header or parameter name
	Description  string
}

// Operation is one method on one path.
type Operation struct {
	Method      string
	Path        string
	Tag         string
	Summary     string
	Description string
	// Security names schemes declared on the document. Empty means the
	// operation is reachable without credentials, and it is written out as an
	// empty list so that reading the document cannot confuse "open on purpose"
	// with "nobody said".
	Security []string
	// PathParams describes parameters the path template already declares.
	// Names that are not in the template are an error; names in the template
	// that are not here get a plain required string.
	PathParams  []Parameter
	Query       []Parameter
	RequestBody *Body
	Responses   []Response
}

// Key identifies an operation the way a route table does.
func (operation Operation) Key() string {
	return operation.Method + " " + operation.Path
}

// Parameter is one path or query parameter.
type Parameter struct {
	Name        string
	Description string
	Required    bool
	Schema      Schema
}

// Body is a request body.
type Body struct {
	MediaType   string // defaults to application/json
	Description string
	Required    bool
	Schema      Schema
}

// Response is one status code the operation can answer with.
type Response struct {
	Status      int
	Description string
	MediaType   string  // empty means no content
	Schema      *Schema // optional even when a media type is given
}

// Schema is the subset of JSON Schema this API needs.
type Schema struct {
	Type        string // string | integer | number | boolean | array | object
	Format      string
	Description string
	Enum        []string
	Default     any
	Example     any
	Items       *Schema
	Fields      []Field
	// Free marks an object whose keys are not fixed -- a settings document, a
	// rule matcher, a device-reported payload. Rendering it as a bare object
	// would claim it has no properties, which is a different and wrong
	// statement.
	Free bool
}

// Field is one property of an object schema.
type Field struct {
	Name     string
	Required bool
	Schema   Schema
}

// template matches a {name} placeholder in a path.
var template = regexp.MustCompile(`\{([^{}]*)\}`)

// PathParameters returns the parameter names a path template declares, in the
// order they appear.
//
// Go's ServeMux allows two forms this cannot express as an OpenAPI parameter:
// a trailing {name...} wildcard and the {$} end-of-path anchor. Both are
// refused rather than dropped, because a route whose shape cannot be written
// down is a route the document would be lying about.
func PathParameters(path string) ([]string, error) {
	if !strings.HasPrefix(path, "/") {
		return nil, fmt.Errorf("path %q does not start with /", path)
	}
	var names []string
	seen := map[string]bool{}
	for _, match := range template.FindAllStringSubmatch(path, -1) {
		name := match[1]
		switch {
		case name == "$":
			return nil, fmt.Errorf("path %q uses the {$} anchor, which OpenAPI cannot express", path)
		case strings.HasSuffix(name, "..."):
			return nil, fmt.Errorf("path %q uses a {%s} wildcard, which OpenAPI cannot express", path, name)
		case name == "":
			return nil, fmt.Errorf("path %q has an empty placeholder", path)
		case seen[name]:
			return nil, fmt.Errorf("path %q declares {%s} twice", path, name)
		}
		seen[name] = true
		names = append(names, name)
	}
	return names, nil
}

// Keys lists every operation as "METHOD /path", sorted.
//
// This is what a drift check compares against the route table, so it lives
// here rather than being reconstructed by every caller.
func (document Document) Keys() []string {
	keys := make([]string, 0, len(document.Operations))
	for _, operation := range document.Operations {
		keys = append(keys, operation.Key())
	}
	sort.Strings(keys)
	return keys
}

// Render validates the document and returns it as indented JSON.
func Render(document Document) ([]byte, error) {
	root, err := build(document)
	if err != nil {
		return nil, err
	}
	encoded, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("encode document: %w", err)
	}
	return append(encoded, '\n'), nil
}

func build(document Document) (map[string]any, error) {
	if strings.TrimSpace(document.Title) == "" {
		return nil, fmt.Errorf("document has no title")
	}
	if strings.TrimSpace(document.Version) == "" {
		return nil, fmt.Errorf("document has no version")
	}

	schemes := map[string]any{}
	declared := map[string]bool{}
	for _, scheme := range document.SecuritySchemes {
		if scheme.Name == "" || scheme.Type == "" {
			return nil, fmt.Errorf("security scheme %q needs a name and a type", scheme.Name)
		}
		if declared[scheme.Name] {
			return nil, fmt.Errorf("security scheme %q is declared twice", scheme.Name)
		}
		declared[scheme.Name] = true
		rendered := map[string]any{"type": scheme.Type}
		put(rendered, "scheme", scheme.Scheme)
		put(rendered, "bearerFormat", scheme.BearerFormat)
		put(rendered, "in", scheme.In)
		put(rendered, "name", scheme.ParamName)
		put(rendered, "description", scheme.Description)
		schemes[scheme.Name] = rendered
	}

	tagged := map[string]bool{}
	tags := make([]any, 0, len(document.Tags))
	for _, tag := range document.Tags {
		if tagged[tag.Name] {
			return nil, fmt.Errorf("tag %q is declared twice", tag.Name)
		}
		tagged[tag.Name] = true
		rendered := map[string]any{"name": tag.Name}
		put(rendered, "description", tag.Description)
		tags = append(tags, rendered)
	}

	paths := map[string]any{}
	seen := map[string]bool{}
	operationIDs := map[string]bool{}
	for _, operation := range document.Operations {
		method := strings.ToUpper(strings.TrimSpace(operation.Method))
		if !methods[method] {
			return nil, fmt.Errorf("operation %q has an unusable method", operation.Key())
		}
		if seen[method+" "+operation.Path] {
			return nil, fmt.Errorf("operation %q is declared twice", operation.Key())
		}
		seen[method+" "+operation.Path] = true
		if strings.TrimSpace(operation.Summary) == "" {
			return nil, fmt.Errorf("operation %q has no summary", operation.Key())
		}
		if operation.Tag != "" && !tagged[operation.Tag] {
			return nil, fmt.Errorf("operation %q uses undeclared tag %q", operation.Key(), operation.Tag)
		}
		if len(operation.Responses) == 0 {
			return nil, fmt.Errorf("operation %q documents no responses", operation.Key())
		}
		for _, name := range operation.Security {
			if !declared[name] {
				return nil, fmt.Errorf("operation %q uses undeclared security scheme %q",
					operation.Key(), name)
			}
		}

		rendered, err := buildOperation(operation, method)
		if err != nil {
			return nil, err
		}
		id, _ := rendered["operationId"].(string)
		if operationIDs[id] {
			return nil, fmt.Errorf("operation %q collides on operationId %q", operation.Key(), id)
		}
		operationIDs[id] = true

		item, _ := paths[operation.Path].(map[string]any)
		if item == nil {
			item = map[string]any{}
			paths[operation.Path] = item
		}
		item[strings.ToLower(method)] = rendered
	}

	info := map[string]any{"title": document.Title, "version": document.Version}
	put(info, "summary", document.Summary)
	put(info, "description", document.Description)

	root := map[string]any{
		"openapi":           SpecVersion,
		"jsonSchemaDialect": jsonSchemaDialect,
		"info":              info,
		"paths":             paths,
	}
	if len(document.Servers) > 0 {
		servers := make([]any, 0, len(document.Servers))
		for _, server := range document.Servers {
			rendered, err := buildServer(server)
			if err != nil {
				return nil, err
			}
			servers = append(servers, rendered)
		}
		root["servers"] = servers
	}
	if len(tags) > 0 {
		root["tags"] = tags
	}
	if len(schemes) > 0 {
		root["components"] = map[string]any{"securitySchemes": schemes}
	}
	return root, nil
}

// buildServer renders one server entry, holding its URL and its variables to
// each other.
//
// A templated URL whose variables are not declared is the one thing in this
// document a reader cannot work around: it cannot compute a base URL at all.
// Both directions are checked, because an unused variable means somebody
// edited the URL and left the declaration behind.
func buildServer(server Server) (map[string]any, error) {
	rendered := map[string]any{"url": server.URL}
	put(rendered, "description", server.Description)

	used := map[string]bool{}
	for _, match := range template.FindAllStringSubmatch(server.URL, -1) {
		used[match[1]] = true
	}
	if len(server.Variables) == 0 && len(used) == 0 {
		return rendered, nil
	}
	variables := map[string]any{}
	for _, variable := range server.Variables {
		if !used[variable.Name] {
			return nil, fmt.Errorf("server %q declares variable %q, which the URL does not use",
				server.URL, variable.Name)
		}
		if variable.Default == "" {
			return nil, fmt.Errorf("server variable %q has no default; OpenAPI requires one",
				variable.Name)
		}
		entry := map[string]any{"default": variable.Default}
		put(entry, "description", variable.Description)
		if len(variable.Enum) > 0 {
			values := make([]any, 0, len(variable.Enum))
			for _, value := range variable.Enum {
				values = append(values, value)
			}
			entry["enum"] = values
		}
		variables[variable.Name] = entry
		delete(used, variable.Name)
	}
	if len(used) > 0 {
		missing := make([]string, 0, len(used))
		for name := range used {
			missing = append(missing, name)
		}
		sort.Strings(missing)
		return nil, fmt.Errorf("server %q uses undeclared variable(s) %s",
			server.URL, strings.Join(missing, ", "))
	}
	rendered["variables"] = variables
	return rendered, nil
}

func buildOperation(operation Operation, method string) (map[string]any, error) {
	names, err := PathParameters(operation.Path)
	if err != nil {
		return nil, err
	}
	described := map[string]Parameter{}
	for _, parameter := range operation.PathParams {
		if !contains(names, parameter.Name) {
			return nil, fmt.Errorf("operation %q describes path parameter %q, "+
				"which the path template does not declare",
				operation.Key(), parameter.Name)
		}
		if _, twice := described[parameter.Name]; twice {
			return nil, fmt.Errorf("operation %q describes path parameter %q twice",
				operation.Key(), parameter.Name)
		}
		described[parameter.Name] = parameter
	}

	parameters := make([]any, 0, len(names)+len(operation.Query))
	// Path parameters first, in template order, so the document reads the way
	// the URL does.
	for _, name := range names {
		parameter, ok := described[name]
		if !ok {
			parameter = Parameter{Name: name, Schema: Schema{Type: "string"}}
		}
		if parameter.Schema.Type == "" {
			parameter.Schema.Type = "string"
		}
		// Path parameters are always required; OpenAPI says so, and letting a
		// caller mark one optional would produce a document no validator
		// accepts.
		parameter.Required = true
		parameters = append(parameters, buildParameter(parameter, "path"))
	}
	queryNames := map[string]bool{}
	for _, parameter := range operation.Query {
		if parameter.Name == "" {
			return nil, fmt.Errorf("operation %q has an unnamed query parameter", operation.Key())
		}
		if queryNames[parameter.Name] {
			return nil, fmt.Errorf("operation %q declares query parameter %q twice",
				operation.Key(), parameter.Name)
		}
		queryNames[parameter.Name] = true
		parameters = append(parameters, buildParameter(parameter, "query"))
	}

	responses := map[string]any{}
	for _, response := range operation.Responses {
		if response.Status < 100 || response.Status > 599 {
			return nil, fmt.Errorf("operation %q documents status %d", operation.Key(), response.Status)
		}
		status := fmt.Sprintf("%d", response.Status)
		if _, twice := responses[status]; twice {
			return nil, fmt.Errorf("operation %q documents status %s twice", operation.Key(), status)
		}
		if strings.TrimSpace(response.Description) == "" {
			return nil, fmt.Errorf("operation %q documents status %s with no description",
				operation.Key(), status)
		}
		rendered := map[string]any{"description": response.Description}
		if response.MediaType != "" {
			media := map[string]any{}
			if response.Schema != nil {
				media["schema"] = buildSchema(*response.Schema)
			}
			rendered["content"] = map[string]any{response.MediaType: media}
		}
		responses[status] = rendered
	}

	rendered := map[string]any{
		"operationId": operationID(method, operation.Path),
		"summary":     operation.Summary,
		"responses":   responses,
		// Always written, never omitted: an operation with no security entry
		// inherits the document's, and "inherits" is exactly the ambiguity
		// that lets an endpoint look protected in a document while being open.
		"security": buildSecurity(operation.Security),
	}
	put(rendered, "description", operation.Description)
	if operation.Tag != "" {
		rendered["tags"] = []any{operation.Tag}
	}
	if len(parameters) > 0 {
		rendered["parameters"] = parameters
	}
	if operation.RequestBody != nil {
		mediaType := operation.RequestBody.MediaType
		if mediaType == "" {
			mediaType = "application/json"
		}
		body := map[string]any{
			"required": operation.RequestBody.Required,
			"content": map[string]any{
				mediaType: map[string]any{"schema": buildSchema(operation.RequestBody.Schema)},
			},
		}
		put(body, "description", operation.RequestBody.Description)
		rendered["requestBody"] = body
	}
	return rendered, nil
}

func buildSecurity(names []string) []any {
	requirements := make([]any, 0, len(names))
	for _, name := range names {
		requirements = append(requirements, map[string]any{name: []any{}})
	}
	return requirements
}

func buildParameter(parameter Parameter, in string) map[string]any {
	rendered := map[string]any{
		"name":     parameter.Name,
		"in":       in,
		"required": parameter.Required,
		"schema":   buildSchema(parameter.Schema),
	}
	put(rendered, "description", parameter.Description)
	return rendered
}

func buildSchema(schema Schema) map[string]any {
	rendered := map[string]any{}
	if schema.Type != "" {
		rendered["type"] = schema.Type
	}
	put(rendered, "format", schema.Format)
	put(rendered, "description", schema.Description)
	if len(schema.Enum) > 0 {
		values := make([]any, 0, len(schema.Enum))
		for _, value := range schema.Enum {
			values = append(values, value)
		}
		rendered["enum"] = values
	}
	if schema.Default != nil {
		rendered["default"] = schema.Default
	}
	if schema.Example != nil {
		rendered["examples"] = []any{schema.Example}
	}
	if schema.Items != nil {
		rendered["items"] = buildSchema(*schema.Items)
	}
	if len(schema.Fields) > 0 {
		properties := map[string]any{}
		required := make([]string, 0, len(schema.Fields))
		for _, field := range schema.Fields {
			properties[field.Name] = buildSchema(field.Schema)
			if field.Required {
				required = append(required, field.Name)
			}
		}
		if rendered["type"] == nil {
			rendered["type"] = "object"
		}
		rendered["properties"] = properties
		if len(required) > 0 {
			sort.Strings(required)
			rendered["required"] = required
		}
	}
	if schema.Free {
		if rendered["type"] == nil {
			rendered["type"] = "object"
		}
		rendered["additionalProperties"] = true
	}
	return rendered
}

// operationID is derived from the method and path rather than written down.
//
// A hand-written identifier is one more thing that can disagree with the route
// it names, and nothing would notice: an operationId is not checked against
// anything. Derived, it cannot drift, and Render rejects the collision if two
// paths ever reduce to the same name.
func operationID(method, path string) string {
	parts := []string{strings.ToLower(method)}
	for _, segment := range strings.Split(strings.Trim(path, "/"), "/") {
		if segment == "" {
			continue
		}
		if strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}") {
			parts = append(parts, "by", identifier(strings.Trim(segment, "{}")))
			continue
		}
		parts = append(parts, identifier(segment))
	}
	return strings.Join(parts, "_")
}

// identifier reduces a path segment to something usable in a name.
func identifier(segment string) string {
	var builder strings.Builder
	for _, letter := range segment {
		switch {
		case letter >= 'a' && letter <= 'z', letter >= '0' && letter <= '9':
			builder.WriteRune(letter)
		case letter >= 'A' && letter <= 'Z':
			builder.WriteRune(letter + ('a' - 'A'))
		default:
			builder.WriteByte('_')
		}
	}
	return builder.String()
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func put(target map[string]any, key, value string) {
	if value != "" {
		target[key] = value
	}
}
