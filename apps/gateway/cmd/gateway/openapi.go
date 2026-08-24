package main

// The machine-readable description of this gateway's HTTP surface.
//
// Why this file is shaped the way it is. A hand-written OpenAPI file is
// correct on the day it is written and wrong the first time a route is added,
// and nothing anywhere says so -- the same failure that left docs/feature-matrix
// claiming fifty-six routes long after there were sixty-six. So the document is
// held to the route table two ways, neither of which anyone has to remember:
//
//   - TestOpenAPIDescribesEveryRegisteredRoute reads every mux registration out
//     of this package's source and fails unless the set matches the operations
//     declared here exactly, in both directions. Add a route and the build is
//     red until it is described; describe a route that does not exist and it is
//     red as well.
//   - At runtime, serveOpenAPI asks the live mux to resolve every documented
//     operation before serving the document. A binary whose document disagrees
//     with its own router answers 500 and says which route, rather than handing
//     out a map of an API it does not have.
//
// Everything that can be derived is derived rather than typed: path parameters
// come out of the pattern, operation identifiers come out of the method and
// path, the command kinds come out of the command catalogue, the settings
// sections and notification channels come out of the settings package, and the
// 401/403/404 answers come out of the same auth predicates the guard enforces
// with. What is left is prose, which is the only part a person can actually
// contribute.

import (
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/auth"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/commands"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/enroll"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/openapi"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/settings"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/wss"
)

// apiSpecPath is where the document is served.
//
// Behind the session guard, like every other tenant route. The argument for
// leaving it open is that a spec is documentation; the argument against is that
// this particular document is a complete map of the attack surface -- every
// path, every method, which ones are exempt from the read-only guard, which one
// takes an ops token in a header, where enrollment codes are minted. None of
// that is secret in the sense that it protects anything, but publishing it costs
// a real reader nothing (the console and its operators all hold sessions) and
// saves an unauthenticated scanner the work of guessing. The only caller that
// cannot hold a session is a build-time tool, and a build-time tool can read the
// operations out of this file directly.
const apiSpecPath = "/v1/openapi.json"

const (
	schemeSession = "consoleSession"
	schemeDevice  = "deviceCertificate"
	schemeOps     = "opsToken"
)

// Tag names, spelled once so a typo is a compile error rather than an
// undeclared-tag failure at render time.
const (
	tagMeta       = "meta"
	tagHealth     = "health"
	tagAuth       = "auth"
	tagTenants    = "tenants"
	tagEdge       = "edge"
	tagOps        = "ops"
	tagEvents     = "events"
	tagFleet      = "fleet"
	tagMessages   = "messages"
	tagCommands   = "commands"
	tagCapability = "capability"
	tagSettings   = "settings"
	tagAudit      = "audit"
	tagRules      = "rules"
	tagEnrollment = "enrollment"
	tagCards      = "cards"
	tagProxy      = "proxy"
	tagSchedules  = "schedules"
)

// apiDocument assembles the description of every route this package registers.
func apiDocument() openapi.Document {
	return openapi.Document{
		Title:   "VoDoge cloud gateway",
		Version: "1.0.0",
		Summary: "Fleet, messaging, proxy and eSIM control plane for VoDoge edge deployments.",
		Description: "Every route the gateway registers.\n\n" +
			"Tenancy is resolved from the request host (a.vodoge.com is tenant \"a\"), " +
			"and a session is only accepted for the tenant it was issued to, so the host " +
			"is a cross-check rather than a selector. Session tokens are presented as " +
			"`Authorization: Bearer <token>` and come from POST /v1/auth/login.\n\n" +
			"Read-only accounts are refused at one chokepoint wrapping the whole route " +
			"table: any method other than GET, HEAD, OPTIONS or TRACE answers 403, except " +
			"for the three routes that act on the caller's own credential. The 403 " +
			"documented on every write route below is that refusal, and it is derived " +
			"from the same predicates the guard uses rather than written down twice.\n\n" +
			"Timestamps in responses are Unix milliseconds unless stated otherwise. " +
			"Error bodies are `text/plain` sentences, not JSON.",
		Servers: []openapi.Server{{
			URL:         "https://{tenant}.vodoge.com",
			Description: "One tenant's console origin. The subdomain selects the tenant.",
			Variables: []openapi.ServerVariable{{
				Name:        "tenant",
				Default:     "a",
				Description: "The tenant slug, as returned by GET /v1/tenant.",
			}},
		}},
		Tags: []openapi.Tag{
			{Name: tagMeta, Description: "The description of this API."},
			{Name: tagHealth, Description: "Liveness, readiness and metrics. Served on the loopback listener only."},
			{Name: tagAuth, Description: "Signing in, signing out and the current session."},
			{Name: tagTenants, Description: "Tenant lookup, used before there is a session."},
			{Name: tagEdge, Description: "What edge devices themselves call. Not console routes."},
			{Name: tagOps, Description: "Operational reports from jobs on the host, authenticated by a shared token."},
			{Name: tagEvents, Description: "The live uplink stream the console subscribes to."},
			{Name: tagFleet, Description: "Devices, modems, sessions and eSIM inventory."},
			{Name: tagMessages, Description: "The SMS inbox: conversations, contacts and individual messages."},
			{Name: tagCommands, Description: "Queueing work for a device and reading what came back."},
			{Name: tagCapability, Description: "The capability matrix pushed to every device."},
			{Name: tagSettings, Description: "Per-tenant configuration, including notification channels."},
			{Name: tagAudit, Description: "The record of who changed what."},
			{Name: tagRules, Description: "Automation rules evaluated against uplink."},
			{Name: tagEnrollment, Description: "One-time codes that let a new device obtain a certificate."},
			{Name: tagCards, Description: "Per-ICCID policy pushed to the fleet."},
			{Name: tagProxy, Description: "Proxy upstreams, listener instances, country rules and traffic."},
			{Name: tagSchedules, Description: "Recurring tasks the gateway runs on the fleet."},
		},
		SecuritySchemes: []openapi.SecurityScheme{
			{
				Name: schemeSession, Type: "http", Scheme: "bearer", BearerFormat: "opaque",
				Description: "A console session token from POST /v1/auth/login. Valid only " +
					"for the tenant it was issued to.",
			},
			{
				Name: schemeDevice, Type: "mutualTLS",
				Description: "A device client certificate, issued through enrollment. " +
					"Presented on the device listener, which is a separate port.",
			},
			{
				Name: schemeOps, Type: "apiKey", In: "header", ParamName: "X-VoDoge-Ops-Token",
				Description: "The shared secret configured as VODOGE_OPS_TOKEN. Compared in " +
					"constant time. Without it this route would be an unauthenticated way " +
					"to make a tenant's notification channels fire.",
			},
		},
		Operations: apiOperations(),
	}
}

// apiOperations is the prose half: one entry per registered route.
//
// The set is checked against the mux registrations, so this list cannot go
// stale silently -- but nothing checks the sentences, and a wrong sentence is
// worse than none. Describe what the route does and what it answers with; do
// not restate the guard behaviour, which is derived below.
func apiOperations() []openapi.Operation {
	operations := []openapi.Operation{
		// ── meta ──────────────────────────────────────────────────────────
		{
			Method: "GET", Path: apiSpecPath, Tag: tagMeta,
			Summary: "This document.",
			Description: "The OpenAPI 3.1 description of every route the gateway registers. " +
				"Generated from the route table at build time and checked against the live " +
				"router before it is served, so it cannot describe an API this binary does " +
				"not have.",
			Security: []string{schemeSession},
			Responses: []openapi.Response{
				jsonOK("The OpenAPI document.", openapi.Schema{Free: true}),
				{
					Status: 500, MediaType: "text/plain", Schema: &plainText,
					Description: "The document and the router disagree. The body names the routes.",
				},
			},
		},

		// ── health ────────────────────────────────────────────────────────
		{
			Method: "GET", Path: "/metrics", Tag: tagHealth,
			Summary: "Prometheus metrics.",
			Description: "Served on the plain HTTP listener, which is published to 127.0.0.1 " +
				"only: operational numbers should not be reachable from the internet.",
			Responses: []openapi.Response{
				{Status: 200, Description: "Metrics in the Prometheus text exposition format.",
					MediaType: "text/plain", Schema: &plainText},
			},
		},
		{
			Method: "GET", Path: "/healthz", Tag: tagHealth,
			Summary:     "Liveness. Answers as long as the process is running.",
			Description: "Says nothing about whether the database or Redis are reachable; that is /readyz.",
			Responses: []openapi.Response{
				jsonOK("The process is up.", object(
					field("status", true, str("Always \"healthy\".")),
				)),
			},
		},
		{
			Method: "GET", Path: "/readyz", Tag: tagHealth,
			Summary: "Readiness: whether the dependencies this gateway needs are reachable.",
			Responses: []openapi.Response{
				jsonOK("Every dependency answered.", object(
					field("status", true, str("\"ready\".")),
				)),
				{Status: 503, Description: "A dependency is not reachable. The body names it.",
					MediaType: "application/json", Schema: &freeObject},
			},
		},

		// ── auth ──────────────────────────────────────────────────────────
		{
			Method: "POST", Path: "/v1/auth/login", Tag: tagAuth,
			Summary: "Exchange an email and password for a session token.",
			Description: "Rate limited per client address rather than per account: limiting by " +
				"account would let anyone lock out a colleague. Five attempts, then one " +
				"every twelve seconds.",
			RequestBody: jsonBody("", true, object(
				field("email", true, str("")),
				field("password", true, str("")),
			)),
			Responses: []openapi.Response{
				jsonOK("Signed in.", object(
					field("token", true, str("Present as Authorization: Bearer <token>.")),
					field("expires_at", true, openapi.Schema{Type: "string", Format: "date-time"}),
					field("tenant_id", true, str("")),
					field("user_id", true, str("")),
					field("role", true, openapi.Schema{Type: "string", Enum: []string{"admin", "readonly"}}),
				)),
				plain(400, "The body is not readable JSON."),
				plain(401, "Wrong email or password, or the account is disabled. One message for both, because saying which would tell an attacker whether an address is registered."),
				plain(403, "The tenant is not active."),
				plain(404, "The host does not name a known tenant."),
				plain(429, "Too many attempts from this address."),
				plain(503, "Authentication is not configured on this gateway."),
			},
		},
		{
			Method: "POST", Path: "/v1/auth/logout", Tag: tagAuth,
			Summary: "Drop the presented session.",
			Description: "Does not require the session to be valid: the caller wants it gone " +
				"either way. Acts on the caller's own credential, so a read-only account may " +
				"call it.",
			Responses: []openapi.Response{noContent("The session is gone.")},
		},
		{
			Method: "GET", Path: "/v1/auth/session", Tag: tagAuth,
			Summary: "Who the presented session belongs to, and what it may do.",
			Description: "The one call the console makes to find out whether the account it is " +
				"drawing for may change anything.",
			Security: []string{schemeSession},
			Responses: []openapi.Response{
				jsonOK("The current session.", object(
					field("role", true, openapi.Schema{Type: "string", Enum: []string{"admin", "readonly"}}),
					field("tenant_id", true, str("")),
					field("slug", true, str("")),
					field("region", true, str("")),
				)),
			},
		},
		{
			Method: "POST", Path: "/v1/auth/password", Tag: tagAuth,
			Summary: "Rotate the caller's own password.",
			Description: "Requires the current password, so it is a credential guess like " +
				"sign-in and is rate limited the same way. Acts on the caller's own " +
				"credential, so a read-only account may call it.",
			Security: []string{schemeSession},
			RequestBody: jsonBody("", true, object(
				field("current_password", true, str("")),
				field("new_password", true, str("")),
			)),
			Responses: []openapi.Response{
				noContent("The password was changed. Other sessions are unaffected unless the gateway says otherwise."),
				plain(400, "The new password does not meet the policy, or the body is unreadable."),
				plain(429, "Too many attempts from this address."),
			},
		},

		// ── tenants ───────────────────────────────────────────────────────
		{
			Method: "GET", Path: "/v1/tenant", Tag: tagTenants,
			Summary: "Resolve the tenant named by the request host.",
			Description: "Open, because the console needs it before anyone has signed in. " +
				"Returns no tenant data beyond the identifiers needed to render a sign-in page.",
			Responses: []openapi.Response{
				jsonOK("The tenant.", tenantSchema()),
				jsonError(404, "The host does not name a known tenant."),
				jsonError(500, "The tenant directory could not be read."),
			},
		},
		{
			Method: "GET", Path: "/v1/tenants/{slug}", Tag: tagTenants,
			Summary: "Resolve a tenant by slug.",
			PathParams: []openapi.Parameter{
				{Name: "slug", Description: "The subdomain label, e.g. \"a\" for a.vodoge.com."},
			},
			Responses: []openapi.Response{
				jsonOK("The tenant.", tenantSchema()),
				jsonError(404, "No such tenant."),
				jsonError(500, "The tenant directory could not be read."),
			},
		},

		// ── edge ──────────────────────────────────────────────────────────
		{
			Method: "POST", Path: enroll.Path, Tag: tagEdge,
			Summary: "Exchange a one-time enrollment code and a CSR for a device certificate.",
			Description: "Called by a device that has no certificate yet, so it carries no " +
				"session and no client certificate; the code is the credential and it is " +
				"consumed on use. The certificate returned is the device's identity from " +
				"then on.",
			RequestBody: jsonBody("", true, object(
				field("tenant_id", true, str("")),
				field("code", true, str("A code from POST /v1/enrollment-codes.")),
				field("csr", true, str("A PEM certificate signing request.")),
			)),
			Responses: []openapi.Response{
				jsonOK("Enrolled.", object(
					field("device_id", true, str("")),
					field("certificate", true, str("The signed certificate, PEM encoded.")),
				)),
				plain(400, "The body or the CSR is unusable."),
				plain(403, "The code is unknown, expired or already used."),
				plain(503, "Enrollment is not configured on this gateway."),
			},
		},
		{
			Method: "GET", Path: wss.Path, Tag: tagEdge,
			Summary: "The device WebSocket: uplink envelopes up, commands down.",
			Description: "An upgrade, not a JSON endpoint. Served on the device listener, which " +
				"requires a client certificate; there is no bearer token on this route. The " +
				"envelope shapes are the edge-cloud contract, not this document.",
			Security: []string{schemeDevice},
			Responses: []openapi.Response{
				{Status: 101, Description: "Upgraded. The connection is a WebSocket from here on."},
				plain(400, "Not an upgrade request."),
				plain(401, "No usable client certificate."),
			},
		},
		{
			Method: "POST", Path: "/v1/ops/backup-failed", Tag: tagOps,
			Summary: "Report that the database backup failed, so the configured tenant is alerted.",
			Description: "A dump covers the whole database and belongs to no tenant, while every " +
				"notification must be addressed to one -- and nothing may enumerate tenants. " +
				"So the recipient is configuration (VODOGE_OPS_TENANT) and the route is inert " +
				"until an operator names one.",
			Security: []string{schemeOps},
			RequestBody: jsonBody("A report with no readable body still means the backup failed, "+
				"which is the part worth passing on.", false, object(
				field("detail", false, str("Why it failed, in one sentence.")),
			)),
			Responses: []openapi.Response{
				noContent("The alert was handed to the notification dispatcher."),
				plain(403, "The ops token is missing or wrong."),
				plain(503, "No ops tenant is configured, or it could not be resolved."),
			},
		},

		// ── events ────────────────────────────────────────────────────────
		{
			Method: "GET", Path: "/v1/events", Tag: tagEvents,
			Summary: "Server-sent events: one message per uplink envelope for this tenant.",
			Description: "Opens with a `hello` event carrying the tenant slug, then `uplink` " +
				"events until the caller goes away. The stream is scoped to the tenant the " +
				"session was issued for; the host is a cross-check, not a selector.\n\n" +
				"The credential is the same bearer token as every other route here. A browser " +
				"cannot put a header on an EventSource, so the console relies on its own " +
				"middleware to turn the session cookie into one on the way through -- the " +
				"same path that lets a page POST /v1/commands. A caller that is not a browser " +
				"sets the header itself.",
			Security: []string{schemeSession},
			Responses: []openapi.Response{
				{Status: 200, Description: "The stream. Held open until the client disconnects.",
					MediaType: "text/event-stream", Schema: &plainText},
				plain(404, "The host does not name a known tenant."),
				plain(500, "The connection cannot be streamed."),
			},
		},

		// ── fleet ─────────────────────────────────────────────────────────
		{
			Method: "GET", Path: "/v1/devices", Tag: tagFleet,
			Summary:  "Every device this tenant has, with its last reported state.",
			Security: []string{schemeSession},
			Responses: []openapi.Response{
				jsonOK("The devices.", wrap("devices", "One device.")),
				plain(500, "The catalog could not be read."),
			},
		},
		{
			Method: "PATCH", Path: "/v1/devices/{id}", Tag: tagFleet,
			Summary: "Rename a device.",
			Description: "Only the name is editable. Everything else -- IMEI, region, what it is " +
				"running -- is reported by the device, and a console that could edit those " +
				"would be inviting someone to write down what they wish were true.",
			Security: []string{schemeSession},
			RequestBody: jsonBody("", true, object(
				field("name", true, openapi.Schema{Type: "string",
					Description: "1 to 128 characters after trimming."}),
			)),
			Responses: []openapi.Response{
				jsonOK("Renamed.", object(
					field("id", true, str("")),
					field("name", true, str("")),
				)),
				plain(400, "The name is empty or longer than 128 characters."),
				plain(500, "The device could not be renamed."),
			},
		},
		{
			Method: "DELETE", Path: "/v1/devices/{id}", Tag: tagFleet,
			Summary: "Remove a device and everything that hangs off it.",
			Description: "This destroys the device's whole journal, which is the record of " +
				"everything it ever reported. The audit row is written first, because it " +
				"references the tenant rather than the device and is the only thing that " +
				"survives.",
			Security:  []string{schemeSession},
			Responses: []openapi.Response{noContent("Removed."), plain(404, "No such device."), plain(500, "The device could not be removed.")},
		},
		{
			Method: "GET", Path: "/v1/modems", Tag: tagFleet,
			Summary: "Every modem the fleet has reported.",
			Description: "What says whether a device's hardware is actually usable: a device can " +
				"be online while every module on it has lost its network.",
			Security: []string{schemeSession},
			Responses: []openapi.Response{
				jsonOK("The modems.", wrap("modems", "One modem, as last reported.")),
				plain(500, "The catalog could not be read."),
			},
		},
		{
			Method: "GET", Path: "/v1/sessions", Tag: tagFleet,
			Summary:  "Which devices are connected right now, and since when.",
			Security: []string{schemeSession},
			Responses: []openapi.Response{
				jsonOK("The live device sessions.", wrap("sessions", "One connected device.")),
				plain(500, "The catalog could not be read."),
			},
		},
		{
			Method: "GET", Path: "/v1/esim/profiles", Tag: tagFleet,
			Summary: "What each eUICC last reported it holds.",
			Description: "Inventory as the card reported it, not as anything configured it. " +
				"A profile appears here only after a device has read it off the card.",
			Security: []string{schemeSession},
			Query: []openapi.Parameter{
				{Name: "device_id", Description: "Only this device's cards. Omit for all."},
			},
			Responses: []openapi.Response{
				jsonOK("The profiles.", wrap("profiles", "One eSIM profile as reported by a card.")),
				plain(500, "The eSIM inventory could not be read."),
			},
		},

		// ── messages ──────────────────────────────────────────────────────
		{
			Method: "GET", Path: "/v1/messages", Tag: tagMessages,
			Summary:  "Recent messages across the whole tenant, newest first.",
			Security: []string{schemeSession},
			Responses: []openapi.Response{
				jsonOK("The messages.", wrap("messages", "One message.")),
				plain(500, "The catalog could not be read."),
			},
		},
		{
			Method: "GET", Path: "/v1/messages/threads", Tag: tagMessages,
			Summary:  "The inbox: one row per conversation, most recent first.",
			Security: []string{schemeSession},
			Responses: []openapi.Response{
				jsonOK("The conversations.", wrap("threads", "One conversation, with its unread count.")),
				plain(500, "Messages could not be read."),
			},
		},
		{
			Method: "GET", Path: "/v1/messages/thread", Tag: tagMessages,
			Summary:  "One conversation.",
			Security: []string{schemeSession},
			Query: []openapi.Parameter{
				{Name: "peer", Required: true, Description: "The other number."},
				{Name: "limit", Description: "How many messages, newest first.",
					Schema: openapi.Schema{Type: "integer", Default: 200}},
			},
			Responses: []openapi.Response{
				jsonOK("The conversation.", object(
					field("peer", true, str("")),
					field("messages", true, arrayOf("One message.")),
				)),
				plain(400, "peer is required."),
				plain(500, "Messages could not be read."),
			},
		},
		{
			Method: "DELETE", Path: "/v1/messages/thread", Tag: tagMessages,
			Summary: "Delete a whole conversation.",
			Description: "The peer travels in the body rather than the path: a phone number in a " +
				"URL ends up in every access log and proxy cache between here and the browser, " +
				"and a conversation is exactly the sort of thing that should not. Not " +
				"recoverable, so it is audited with the count.",
			Security:    []string{schemeSession},
			RequestBody: jsonBody("", true, object(field("peer", true, str("The other number.")))),
			Responses: []openapi.Response{
				jsonOK("Deleted.", object(field("removed", true, integer("How many messages went.")))),
				plain(400, "peer is required, or the body is unreadable."),
				plain(500, "Messages could not be read."),
			},
		},
		{
			Method: "POST", Path: "/v1/messages/thread/read", Tag: tagMessages,
			Summary: "Clear the unread badge for one conversation.",
			Description: "A write, so it is a POST rather than something the thread GET does on " +
				"the way past: a page that marked messages read by being rendered would clear " +
				"them on a link preview, a prefetch, or the second render Next.js does of " +
				"every server component.",
			Security:    []string{schemeSession},
			RequestBody: jsonBody("", true, object(field("peer", true, str("The other number.")))),
			Responses: []openapi.Response{
				jsonOK("Marked.", object(field("marked", true, integer("How many messages were unread.")))),
				plain(400, "peer is required, or the body is unreadable."),
				plain(500, "Messages could not be read."),
			},
		},
		{
			Method: "GET", Path: "/v1/messages/contacts", Tag: tagMessages,
			Summary:  "Every named number.",
			Security: []string{schemeSession},
			Responses: []openapi.Response{
				jsonOK("The contacts.", wrap("contacts", "One contact.")),
				plain(500, "Messages could not be read."),
			},
		},
		{
			Method: "PUT", Path: "/v1/messages/contact", Tag: tagMessages,
			Summary: "Name a number.",
			Description: "PUT because it is an upsert on the number: the caller does not know or " +
				"care whether this contact already existed.",
			Security: []string{schemeSession},
			RequestBody: jsonBody("", true, object(
				field("peer", true, openapi.Schema{Type: "string", Description: "Up to 64 characters."}),
				field("name", true, openapi.Schema{Type: "string", Description: "Up to 128 characters."}),
				field("note", false, openapi.Schema{Type: "string", Description: "Up to 512 characters."}),
			)),
			Responses: []openapi.Response{
				jsonOK("Saved.", object(field("contact", true, openapi.Schema{Free: true}))),
				plain(400, "peer and name are required, or a field is too long."),
				plain(500, "Messages could not be read."),
			},
		},
		{
			Method: "DELETE", Path: "/v1/messages/contact", Tag: tagMessages,
			Summary:     "Forget a contact. The messages stay.",
			Security:    []string{schemeSession},
			RequestBody: jsonBody("", true, object(field("peer", true, str("The other number.")))),
			Responses: []openapi.Response{
				noContent("Forgotten."),
				plain(400, "peer is required, or the body is unreadable."),
				plain(500, "Messages could not be read."),
			},
		},
		{
			Method: "DELETE", Path: "/v1/messages/{id}", Tag: tagMessages,
			Summary:   "Delete one message.",
			Security:  []string{schemeSession},
			Responses: []openapi.Response{noContent("Deleted."), plain(500, "Messages could not be read.")},
		},

		// ── commands ──────────────────────────────────────────────────────
		{
			Method: "POST", Path: "/v1/commands", Tag: tagCommands,
			Summary: "Queue one command for a device.",
			Description: "Asynchronous by construction: the device picks the command up over its " +
				"WebSocket and reports a result later. Rate limited per tenant rather than per " +
				"caller, because commands cost a device real time -- an operator scan takes the " +
				"radio away for over a minute -- and two operators in one tenant should not be " +
				"able to queue twice as much work for the same hardware.",
			Security: []string{schemeSession},
			RequestBody: jsonBody("The fields other than device_id and kind depend on the kind; "+
				"GET /v1/commands/kinds lists what each one needs.", true, object(
				field("device_id", true, str("")),
				field("kind", true, openapi.Schema{
					Type: "string", Enum: commands.Kinds(),
					Description: "Read from the command catalogue, so this list is whatever this build supports.",
				}),
				field("modem_imei", false, str("Required for kinds that act on a specific module.")),
			)),
			Responses: []openapi.Response{
				jsonOK("Queued.", object(
					field("id", true, str("The command id, for GET /v1/commands.")),
				)),
				plain(400, "The kind is unknown, or a field the kind needs is missing. The body says which."),
				plain(429, "The tenant's hourly send limit or command rate limit was reached."),
				plain(500, "The command queue is unavailable. Worth checking whether app.command_kind knows this kind."),
			},
		},
		{
			Method: "GET", Path: "/v1/commands", Tag: tagCommands,
			Summary:  "Commands and their results, newest first.",
			Security: []string{schemeSession},
			Query: []openapi.Parameter{
				{Name: "device_id", Description: "Only this device's commands. Omit for all."},
				{Name: "limit", Description: "How many.", Schema: openapi.Schema{Type: "integer", Default: 50}},
			},
			Responses: []openapi.Response{
				jsonOK("The commands.", wrap("commands", "One command with its result, if it has one yet.")),
				plain(500, "The catalog could not be read."),
			},
		},
		{
			Method: "GET", Path: "/v1/commands/kinds", Tag: tagCommands,
			Summary: "Every command kind this build supports.",
			Description: "The catalogue the enqueue route validates against, so a client can " +
				"render a form without guessing.",
			Security: []string{schemeSession},
			Responses: []openapi.Response{
				jsonOK("The catalogue.", object(field("commands", true, openapi.Schema{
					Type: "array",
					Items: &openapi.Schema{Type: "object", Fields: []openapi.Field{
						{Name: "kind", Required: true, Schema: openapi.Schema{Type: "string"}},
						{Name: "needs_modem", Required: true, Schema: openapi.Schema{Type: "boolean"}},
						{Name: "mutating", Required: true, Schema: openapi.Schema{Type: "boolean"}},
					}},
				}))),
			},
		},
		{
			Method: "GET", Path: "/v1/journal", Tag: tagCommands,
			Summary: "What devices actually said, as opposed to what the projections made of it.",
			Description: "When something looks wrong on a page the question is always whether the " +
				"device reported it that way or the projection mangled it. This is the raw " +
				"envelope stream that answers it.",
			Security: []string{schemeSession},
			Query: []openapi.Parameter{
				{Name: "device_id", Description: "Only this device."},
				{Name: "kind", Description: "Only this envelope kind."},
				{Name: "payload", Description: "\"1\" to include payloads. Opt-in, because a page of DeviceState envelopes is a megabyte of JSON the list view does not show.",
					Schema: openapi.Schema{Type: "string", Enum: []string{"1"}}},
				{Name: "before", Description: "Cursor: only envelopes received before this Unix millisecond timestamp.",
					Schema: openapi.Schema{Type: "integer", Format: "int64"}},
				{Name: "limit", Description: "How many.", Schema: openapi.Schema{Type: "integer"}},
			},
			Responses: []openapi.Response{
				jsonOK("A page of envelopes.", object(
					field("events", true, arrayOf("One received envelope.")),
					field("next_before", true, integer("Pass as `before` for the next page. Zero when the page was empty.")),
				)),
				plain(500, "The journal could not be read."),
			},
		},

		// ── capability matrix ─────────────────────────────────────────────
		{
			Method: "GET", Path: "/v1/capability-matrix", Tag: tagCapability,
			Summary:  "The capability matrix overlay currently in force for this tenant.",
			Security: []string{schemeSession},
			Responses: []openapi.Response{
				jsonOK("The overlay, with its version and digest.", openapi.Schema{Free: true}),
				plain(404, "This tenant has no overlay; the built-in matrix applies."),
				plain(500, "The overlay could not be read."),
			},
		},
		{
			Method: "PUT", Path: "/v1/capability-matrix", Tag: tagCapability,
			Summary: "Replace the overlay and push it to every device.",
			Description: "Queues one update_capability_matrix command per device, keyed on the " +
				"overlay version so a repeated save does not queue twice.",
			Security: []string{schemeSession},
			RequestBody: jsonBody("", true, object(
				field("matrix", true, openapi.Schema{Free: true, Description: "The overlay document."}),
			)),
			Responses: []openapi.Response{
				jsonOK("Stored and queued.", object(
					field("version", true, str("")),
					field("sha256", true, str("")),
					field("queued", true, integer("How many devices were given the update.")),
				)),
				plain(400, "The overlay is missing or does not parse. The body says why."),
				plain(500, "The overlay could not be stored, or the command queue is unavailable."),
			},
		},

		// ── settings ──────────────────────────────────────────────────────
		{
			Method: "GET", Path: "/v1/settings", Tag: tagSettings,
			Summary: "Every settings section, secrets replaced by a placeholder.",
			Description: "The console never receives a webhook secret or an SMTP password: it " +
				"would otherwise sit in a page's HTML on every visit so that it could be " +
				"posted back unchanged. Sending the placeholder back means \"leave it alone\".",
			Security: []string{schemeSession},
			Responses: []openapi.Response{
				jsonOK("The sections.", object(
					field("settings", true, openapi.Schema{Free: true,
						Description: "Keyed by section name: " + strings.Join(settings.Sections(), ", ") + "."}),
				)),
				plain(500, "Settings could not be read."),
			},
		},
		{
			Method: "PUT", Path: "/v1/settings/{section}", Tag: tagSettings,
			Summary: "Replace one settings section.",
			Description: "Merged with what is stored before validation, so a channel whose only " +
				"missing field is the secret it never received stays valid.",
			Security: []string{schemeSession},
			PathParams: []openapi.Parameter{
				{Name: "section", Description: "Which section. Read from the settings package, so this is what this build accepts.",
					Schema: openapi.Schema{Type: "string", Enum: settings.Sections()}},
			},
			RequestBody: jsonBody("The section document. Secrets left at the redaction placeholder are kept.",
				true, openapi.Schema{Free: true}),
			Responses: []openapi.Response{
				jsonOK("Saved. The stored section, redacted.", openapi.Schema{Free: true}),
				plain(400, "Unknown section, unreadable document, or a validation failure. The body is the sentence to act on."),
				plain(500, "Settings could not be stored."),
			},
		},
		{
			Method: "POST", Path: "/v1/settings/notifications/{channel}/test", Tag: tagSettings,
			Summary: "Send one test notification through a single channel and report what happened.",
			Description: "Synchronous, unlike every other notification: the point of the button is " +
				"that whoever pressed it sees the result, including the failure and why.",
			Security: []string{schemeSession},
			PathParams: []openapi.Parameter{
				{Name: "channel", Description: "Which channel. Read from the settings package, so this is what this build can send through.",
					Schema: openapi.Schema{Type: "string", Enum: settings.NotificationChannels()}},
			},
			Responses: []openapi.Response{
				noContent("Delivered."),
				plain(400, "The channel is not configured or not enabled."),
				plain(502, "The channel refused it. The body is the channel's own error, because \"connection refused\" and \"authentication failed\" need completely different fixes."),
				plain(503, "Notifications are not configured on this gateway."),
			},
		},

		// ── audit ─────────────────────────────────────────────────────────
		{
			Method: "GET", Path: "/v1/audit", Tag: tagAudit,
			Summary:  "Who changed what, newest first.",
			Security: []string{schemeSession},
			Responses: []openapi.Response{
				jsonOK("The events.", wrap("events", "One audited action.")),
				plain(500, "The audit log could not be read."),
			},
		},

		// ── rules ─────────────────────────────────────────────────────────
		{
			Method: "GET", Path: "/v1/rules", Tag: tagRules,
			Summary:  "Every automation rule.",
			Security: []string{schemeSession},
			Responses: []openapi.Response{
				jsonOK("The rules.", wrap("rules", "One rule.")),
				plain(500, "Rules could not be read."),
			},
		},
		{
			Method: "POST", Path: "/v1/rules", Tag: tagRules,
			Summary:  "Create an automation rule.",
			Security: []string{schemeSession},
			RequestBody: jsonBody("", true, object(
				field("name", true, str("")),
				field("matcher", false, openapi.Schema{Free: true, Description: "What uplink the rule fires on."}),
				field("action", false, openapi.Schema{Free: true, Description: "What it does when it fires."}),
				field("enabled", false, openapi.Schema{Type: "boolean", Default: true}),
			)),
			Responses: []openapi.Response{
				{Status: 201, Description: "Created. The stored rule.",
					MediaType: "application/json", Schema: &freeObject},
				plain(400, "The body is unreadable or the name is empty."),
				plain(500, "The rule could not be stored."),
			},
		},

		// ── enrollment codes ──────────────────────────────────────────────
		{
			Method: "GET", Path: "/v1/enrollment-codes", Tag: tagEnrollment,
			Summary:  "Outstanding enrollment codes.",
			Security: []string{schemeSession},
			Responses: []openapi.Response{
				jsonOK("The codes.", wrap("codes", "One code, with its expiry and whether it has been used.")),
				plain(500, "Enrollment state could not be read."),
			},
		},
		{
			Method: "POST", Path: "/v1/enrollment-codes", Tag: tagEnrollment,
			Summary: "Mint a one-time enrollment code.",
			Description: "The code is how a device with no certificate gets one. It is returned " +
				"once here and is the only credential POST /v1/enroll accepts.",
			Security: []string{schemeSession},
			RequestBody: jsonBody("", false, object(
				field("ttl_hours", false, openapi.Schema{Type: "integer", Default: 24,
					Description: "How long the code stays usable. Non-positive values fall back to 24."}),
			)),
			Responses: []openapi.Response{
				{Status: 201, Description: "Created. The code, in full, for the only time.",
					MediaType: "application/json", Schema: &freeObject},
				plain(500, "The code could not be stored."),
			},
		},

		// ── cards ─────────────────────────────────────────────────────────
		{
			Method: "GET", Path: "/v1/cards/policies", Tag: tagCards,
			Summary:  "Every per-card policy, with the version the fleet was last given.",
			Security: []string{schemeSession},
			Responses: []openapi.Response{
				jsonOK("The policies.", object(
					field("policies", true, arrayOf("One card policy.")),
					field("version", true, str("The version pushed to devices.")),
				)),
				plain(500, "Policies could not be read."),
			},
		},
		{
			Method: "GET", Path: "/v1/cards/{iccid}/policy", Tag: tagCards,
			Summary:  "One card's policy.",
			Security: []string{schemeSession},
			PathParams: []openapi.Parameter{
				{Name: "iccid", Description: "The card's ICCID."},
			},
			Responses: []openapi.Response{
				jsonOK("The policy.", openapi.Schema{Free: true}),
				plain(404, "No policy for that card."),
				plain(500, "Policies could not be read."),
			},
		},
		{
			Method: "PUT", Path: "/v1/cards/{iccid}/policy", Tag: tagCards,
			Summary: "Save one card's policy and push the whole set to every device.",
			Description: "The ICCID in the path wins over any in the body: two sources for the " +
				"same identifier is how a policy ends up saved against a different card than " +
				"the one being edited. Every device gets the full set, because a policy is " +
				"keyed by ICCID and any device might be holding that card.",
			Security: []string{schemeSession},
			PathParams: []openapi.Parameter{
				{Name: "iccid", Description: "The card's ICCID. Overwrites any iccid in the body."},
			},
			RequestBody: jsonBody("", true, openapi.Schema{Free: true}),
			Responses: []openapi.Response{
				jsonOK("Saved. The stored policy, re-read so its timestamp is real.", openapi.Schema{Free: true}),
				plain(400, "The policy is unreadable or fails validation. The body says which field."),
				plain(500, "The policy could not be stored."),
			},
		},
		{
			Method: "DELETE", Path: "/v1/cards/{iccid}/policy", Tag: tagCards,
			Summary: "Remove one card's policy.",
			Description: "An emptied set sends nothing to the fleet: a device keeps its last set " +
				"until told otherwise, which is the safer of the two wrong answers. The other " +
				"reading of \"no policies\" is \"deny everything\", and applying that to a " +
				"fleet by deleting a row would be a spectacular way to take every card offline.",
			Security: []string{schemeSession},
			PathParams: []openapi.Parameter{
				{Name: "iccid", Description: "The card's ICCID."},
			},
			Responses: []openapi.Response{noContent("Removed."), plain(500, "The policy could not be removed.")},
		},

		// ── proxy ─────────────────────────────────────────────────────────
		{
			Method: "GET", Path: "/v1/proxy/upstreams", Tag: tagProxy,
			Summary:  "Every configured upstream.",
			Security: []string{schemeSession},
			Responses: []openapi.Response{
				jsonOK("The upstreams.", wrap("upstreams", "One upstream.")),
				plain(500, "Proxy configuration could not be read."),
			},
		},
		{
			Method: "POST", Path: "/v1/proxy/upstreams", Tag: tagProxy,
			Summary:     "Create an upstream.",
			Security:    []string{schemeSession},
			RequestBody: jsonBody("", true, openapi.Schema{Free: true}),
			Responses: []openapi.Response{
				jsonOK("Saved.", openapi.Schema{Free: true}),
				plain(400, "The upstream is unreadable or fails validation."),
				plain(500, "The upstream could not be stored."),
			},
		},
		{
			Method: "PUT", Path: "/v1/proxy/upstreams/{id}", Tag: tagProxy,
			Summary:     "Replace an upstream.",
			Security:    []string{schemeSession},
			RequestBody: jsonBody("", true, openapi.Schema{Free: true}),
			Responses: []openapi.Response{
				jsonOK("Saved.", openapi.Schema{Free: true}),
				plain(400, "The upstream is unreadable or fails validation."),
				plain(404, "No such upstream."),
				plain(500, "The upstream could not be stored."),
			},
		},
		{
			Method: "DELETE", Path: "/v1/proxy/upstreams/{id}", Tag: tagProxy,
			Summary:   "Remove an upstream.",
			Security:  []string{schemeSession},
			Responses: []openapi.Response{noContent("Removed."), plain(404, "No such upstream."), plain(500, "The upstream could not be removed.")},
		},
		{
			Method: "POST", Path: "/v1/proxy/upstreams/{id}/probe", Tag: tagProxy,
			Summary: "Ask a device to test whether this upstream works.",
			Description: "Queues a command; the answer arrives as a command result, not in this " +
				"response. The cloud host has no cellular interface and cannot test it itself.",
			Security: []string{schemeSession},
			Responses: []openapi.Response{
				jsonOK("Queued.", object(
					field("id", true, str("The command id.")),
					field("status", true, openapi.Schema{Type: "string", Enum: []string{"queued"}}),
				)),
				plain(404, "No such upstream."),
				plain(500, "The command queue is unavailable."),
			},
		},
		{
			Method: "GET", Path: "/v1/proxy/instances", Tag: tagProxy,
			Summary: "Every proxy listener the fleet should be running.",
			Description: "Desired state. The listeners run on the edge, bound to a modem's " +
				"interface so traffic leaves over that SIM; what is actually listening is " +
				"whatever the device last reported.",
			Security: []string{schemeSession},
			Query: []openapi.Parameter{
				{Name: "device_id", Description: "Only this device's instances. Omit for all."},
			},
			Responses: []openapi.Response{
				jsonOK("The instances.", wrap("instances", "One proxy listener.")),
				plain(500, "Proxy configuration could not be read."),
			},
		},
		{
			Method: "POST", Path: "/v1/proxy/instances", Tag: tagProxy,
			Summary:     "Create a proxy listener and push the device its new configuration.",
			Security:    []string{schemeSession},
			RequestBody: jsonBody("", true, openapi.Schema{Free: true}),
			Responses: []openapi.Response{
				jsonOK("Saved.", openapi.Schema{Free: true}),
				plain(400, "The instance is unreadable or fails validation."),
				plain(500, "The instance could not be stored."),
			},
		},
		{
			Method: "PUT", Path: "/v1/proxy/instances/{id}", Tag: tagProxy,
			Summary:     "Replace a proxy listener and push the device its new configuration.",
			Security:    []string{schemeSession},
			RequestBody: jsonBody("", true, openapi.Schema{Free: true}),
			Responses: []openapi.Response{
				jsonOK("Saved.", openapi.Schema{Free: true}),
				plain(400, "The instance is unreadable or fails validation."),
				plain(404, "No such instance."),
				plain(500, "The instance could not be stored."),
			},
		},
		{
			Method: "DELETE", Path: "/v1/proxy/instances/{id}", Tag: tagProxy,
			Summary:   "Remove a proxy listener and push the device its new configuration.",
			Security:  []string{schemeSession},
			Responses: []openapi.Response{noContent("Removed."), plain(404, "No such instance."), plain(500, "The instance could not be removed.")},
		},
		{
			Method: "POST", Path: "/v1/proxy/instances/{id}/{action}", Tag: tagProxy,
			Summary: "Start, stop or restart a listener on the device holding it.",
			Description: "Queues a command; the listener state that comes back later is what the " +
				"device reports, not what this response says.",
			Security: []string{schemeSession},
			PathParams: []openapi.Parameter{
				{Name: "action", Schema: openapi.Schema{Type: "string", Enum: []string{"start", "stop", "restart"}}},
			},
			Responses: []openapi.Response{
				jsonOK("Queued.", object(
					field("id", true, str("The command id.")),
					field("status", true, openapi.Schema{Type: "string", Enum: []string{"queued"}}),
				)),
				plain(400, "The action must be start, stop or restart."),
				plain(404, "No such instance."),
				plain(500, "The command queue is unavailable."),
			},
		},
		{
			Method: "GET", Path: "/v1/proxy/country-rules", Tag: tagProxy,
			Summary:  "Per-country routing rules.",
			Security: []string{schemeSession},
			Responses: []openapi.Response{
				jsonOK("The rules.", wrap("country_rules", "One country rule.")),
				plain(500, "Proxy configuration could not be read."),
			},
		},
		{
			Method: "PUT", Path: "/v1/proxy/country-rules/{code}", Tag: tagProxy,
			Summary:  "Save one country rule.",
			Security: []string{schemeSession},
			PathParams: []openapi.Parameter{
				{Name: "code", Description: "The country code. Overwrites any country_code in the body."},
			},
			RequestBody: jsonBody("", true, openapi.Schema{Free: true}),
			Responses: []openapi.Response{
				jsonOK("Saved.", object(field("country_code", true, str("")))),
				plain(400, "The rule is unreadable or fails validation."),
				plain(500, "The rule could not be stored."),
			},
		},
		{
			Method: "DELETE", Path: "/v1/proxy/country-rules/{code}", Tag: tagProxy,
			Summary:  "Remove one country rule.",
			Security: []string{schemeSession},
			PathParams: []openapi.Parameter{
				{Name: "code", Description: "The country code."},
			},
			Responses: []openapi.Response{noContent("Removed."), plain(500, "The rule could not be removed.")},
		},
		{
			Method: "GET", Path: "/v1/proxy/traffic", Tag: tagProxy,
			Summary:  "Hourly proxy traffic totals.",
			Security: []string{schemeSession},
			Query: []openapi.Parameter{
				{Name: "hours", Description: "How far back, 1 to 2160. A week by default: long enough to show a pattern, short enough that the response stays a page rather than a download.",
					Schema: openapi.Schema{Type: "integer", Default: 168}},
			},
			Responses: []openapi.Response{
				jsonOK("The series.", object(
					field("traffic", true, arrayOf("One hourly bucket.")),
					field("since", true, integer("The start of the window, Unix milliseconds.")),
				)),
				plain(500, "Traffic could not be read."),
			},
		},

		// ── schedules ─────────────────────────────────────────────────────
		{
			Method: "GET", Path: "/v1/schedules", Tag: tagSchedules,
			Summary:  "Every recurring task, with when it last ran and when it is next due.",
			Security: []string{schemeSession},
			Responses: []openapi.Response{
				jsonOK("The schedules.", wrap("schedules", "One recurring task.")),
				plain(500, "Schedules could not be read."),
				plain(503, "Schedules are not available on this gateway."),
			},
		},
		{
			Method: "POST", Path: "/v1/schedules", Tag: tagSchedules,
			Summary: "Create a recurring task.",
			Description: "anchor_at exists because an interval alone says nothing about phase: " +
				"\"on the hour\" is an anchor at the top of some hour, not a cadence.",
			Security: []string{schemeSession},
			RequestBody: jsonBody("", true, object(
				field("name", true, str("")),
				field("action", true, str("What the task does.")),
				field("command_kind", false, str("For command actions, which kind to queue.")),
				field("selector", false, openapi.Schema{Free: true, Description: "Which devices or modems it applies to."}),
				field("request", false, openapi.Schema{Free: true, Description: "The command request template."}),
				field("interval_seconds", true, integer("How often.")),
				field("anchor_at", false, integer("Unix milliseconds. Fixes the phase of the interval.")),
				field("enabled", false, openapi.Schema{Type: "boolean", Default: true}),
			)),
			Responses: []openapi.Response{
				{Status: 201, Description: "Created. The stored task.",
					MediaType: "application/json", Schema: &freeObject},
				plain(400, "The body is unreadable or fails validation. The body says which field."),
				plain(500, "The task could not be stored."),
				plain(503, "Schedules are not available on this gateway."),
			},
		},
		{
			Method: "PATCH", Path: "/v1/schedules/{id}", Tag: tagSchedules,
			Summary:     "Change part of a recurring task.",
			Security:    []string{schemeSession},
			RequestBody: jsonBody("Only the fields present are changed.", true, openapi.Schema{Free: true}),
			Responses: []openapi.Response{
				jsonOK("Updated. The stored task.", openapi.Schema{Free: true}),
				plain(400, "The body is unreadable or fails validation."),
				plain(404, "No such task."),
				plain(500, "The task could not be stored."),
				plain(503, "Schedules are not available on this gateway."),
			},
		},
		{
			Method: "DELETE", Path: "/v1/schedules/{id}", Tag: tagSchedules,
			Summary:  "Remove a recurring task.",
			Security: []string{schemeSession},
			Responses: []openapi.Response{
				noContent("Removed."),
				plain(404, "No such task."),
				plain(500, "The task could not be removed."),
				plain(503, "Schedules are not available on this gateway."),
			},
		},
	}

	for index := range operations {
		operations[index].Responses = withGuardResponses(operations[index])
	}
	return operations
}

// withGuardResponses adds the answers the session guard produces, using the
// same predicates the guard itself uses.
//
// Written this way rather than repeated on sixty-odd operations because the
// repetition is what rots: change auth.OwnCredential and every hand-written
// 403 in the document is wrong, with nothing to say so. An operation that
// already documents a status keeps its own wording -- sign-in has its own
// meaning for 401 and it is not "no session".
func withGuardResponses(operation openapi.Operation) []openapi.Response {
	if !contains(operation.Security, schemeSession) {
		return operation.Responses
	}
	responses := operation.Responses
	add := func(status int, description string) {
		for _, existing := range responses {
			if existing.Status == status {
				return
			}
		}
		responses = append(responses, plain(status, description))
	}
	add(401, "No session, or the session has expired.")
	if auth.ChangesState(operation.Method) && !auth.OwnCredential(operation.Path) {
		add(403, "A read-only account may not change tenant data; or the session belongs "+
			"to another tenant; or the tenant is not active. The refusal happens at one "+
			"chokepoint wrapping the whole route table, before the handler runs.")
	} else {
		add(403, "The session belongs to another tenant, or the tenant is not active.")
	}
	add(404, "The request host does not name a known tenant.")
	return responses
}

// ── serving ──────────────────────────────────────────────────────────────

// wildcardSegment matches a {name} placeholder, for probing the mux.
var wildcardSegment = regexp.MustCompile(`\{[^}]*\}`)

// serveOpenAPI answers with the document, having first checked it against the
// router it claims to describe.
//
// The check is the point. A document built from a list in this file is exactly
// as trustworthy as that list, and the test that keeps the list honest runs at
// build time on the source -- which says nothing about the binary somebody
// actually deployed. Asking the live mux to resolve every documented operation
// closes that gap: a binary whose routes and document disagree refuses to hand
// out the document rather than handing out a wrong one.
//
// What it cannot see is the other direction: a route registered but not
// described. http.ServeMux does not enumerate, so nothing at runtime can. That
// half is TestOpenAPIDescribesEveryRegisteredRoute, which reads the
// registrations out of the source.
func (process *process) serveOpenAPI(mux *http.ServeMux) http.HandlerFunc {
	var once sync.Once
	var body []byte
	var failure error
	return func(writer http.ResponseWriter, request *http.Request) {
		if _, ok := process.tenantFromRequest(writer, request); !ok {
			return
		}
		once.Do(func() {
			body, failure = renderAPISpec(mux)
			if failure != nil {
				slog.Error("the openapi document does not describe this router", "error", failure)
			}
		})
		if failure != nil {
			http.Error(writer, "the openapi document does not describe this router: "+
				failure.Error(), http.StatusInternalServerError)
			return
		}
		writer.Header().Set("Content-Type", "application/json; charset=utf-8")
		writer.Header().Set("Cache-Control", "no-store")
		_, _ = writer.Write(body)
	}
}

// renderAPISpec builds the document and refuses to return one the mux does not
// back.
func renderAPISpec(mux *http.ServeMux) ([]byte, error) {
	document := apiDocument()
	if missing := unroutable(document, mux); len(missing) > 0 {
		return nil, fmt.Errorf("%d documented route(s) are not registered: %s",
			len(missing), strings.Join(missing, ", "))
	}
	return openapi.Render(document)
}

// unroutable lists the documented operations the mux does not resolve to.
func unroutable(document openapi.Document, mux *http.ServeMux) []string {
	if mux == nil {
		return document.Keys()
	}
	var missing []string
	for _, operation := range document.Operations {
		probe := &http.Request{
			Method: operation.Method,
			// A host that cannot be a tenant: the mux is being asked which
			// pattern matches, not to serve anything.
			Host:   "openapi.invalid",
			URL:    &url.URL{Path: wildcardSegment.ReplaceAllString(operation.Path, "sample")},
			Header: http.Header{},
		}
		if _, pattern := mux.Handler(probe); pattern != operation.Key() {
			missing = append(missing, operation.Key())
		}
	}
	sort.Strings(missing)
	return missing
}

// ── small builders, so the table above reads as prose ────────────────────

var (
	plainText  = openapi.Schema{Type: "string"}
	freeObject = openapi.Schema{Free: true}
)

func str(description string) openapi.Schema {
	return openapi.Schema{Type: "string", Description: description}
}

func integer(description string) openapi.Schema {
	return openapi.Schema{Type: "integer", Format: "int64", Description: description}
}

func object(fields ...openapi.Field) openapi.Schema {
	return openapi.Schema{Type: "object", Fields: fields}
}

func field(name string, required bool, schema openapi.Schema) openapi.Field {
	return openapi.Field{Name: name, Required: required, Schema: schema}
}

func arrayOf(itemDescription string) openapi.Schema {
	return openapi.Schema{
		Type:  "array",
		Items: &openapi.Schema{Type: "object", Free: true, Description: itemDescription},
	}
}

// wrap is the shape almost every list route answers with: one key holding an
// array.
func wrap(key, itemDescription string) openapi.Schema {
	return object(field(key, true, arrayOf(itemDescription)))
}

func jsonOK(description string, schema openapi.Schema) openapi.Response {
	return openapi.Response{Status: 200, Description: description,
		MediaType: "application/json", Schema: &schema}
}

func jsonError(status int, description string) openapi.Response {
	return openapi.Response{Status: status, Description: description,
		MediaType: "application/json",
		Schema:    &openapi.Schema{Type: "object", Fields: []openapi.Field{{Name: "error", Required: true, Schema: openapi.Schema{Type: "string"}}}}}
}

// plain is an error response. Handlers answer failures with http.Error, which
// writes text/plain, so documenting them as JSON would be wrong.
func plain(status int, description string) openapi.Response {
	return openapi.Response{Status: status, Description: description,
		MediaType: "text/plain", Schema: &plainText}
}

func noContent(description string) openapi.Response {
	return openapi.Response{Status: 204, Description: description}
}

func jsonBody(description string, required bool, schema openapi.Schema) *openapi.Body {
	return &openapi.Body{MediaType: "application/json", Description: description,
		Required: required, Schema: schema}
}

func tenantSchema() openapi.Schema {
	return object(
		field("tenant_id", true, str("")),
		field("slug", true, str("")),
		field("region", true, str("")),
		field("status", true, str("\"active\" for a tenant that may be used.")),
	)
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
