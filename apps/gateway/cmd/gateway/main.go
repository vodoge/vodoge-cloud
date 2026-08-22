// Command gateway is the Cloud device-facing process.
//
// /healthz and /readyz stay on plaintext HTTP for the Compose healthcheck.
// /v1/enroll exchanges a one-time code for a device certificate over TLS 1.3
// without a client cert. /v1/edge upgrades to the authenticated device
// WebSocket. Production supplies VODOGE_GATEWAY_TLS_* so the listener uses
// TLS 1.3 and verifies a client certificate when one is presented.
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/audit"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/cards"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/auth"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/catalog"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/commands"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/directory"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/dispatch"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/enroll"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/events"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/ingress"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/matrix"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/observe"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/messaging"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/region"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/proxy"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/ratelimit"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/rules"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/settings"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/session"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/transport"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/wakeup"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/wss"
)

const defaultAddress = ":8080"

func main() {
	address := os.Getenv("VODOGE_GATEWAY_ADDR")
	if address == "" {
		address = defaultAddress
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	tlsConfig, err := optionalServerTLS()
	if err != nil {
		logger.Error("gateway tls", "error", err)
		os.Exit(1)
	}

	journal, tenants, enrollment, err := openRuntime()
	if err != nil {
		logger.Error("gateway database", "error", err)
		os.Exit(1)
	}
	wakeups := connectWakeup(os.Getenv("REDIS_URL"), os.Getenv("VODOGE_GATEWAY_NODE_ID"), logger)
	proc := newProcess(os.Getenv("VODOGE_GATEWAY_REGION"), journal, tenants, wakeups, enrollment)
	if sqlStore, ok := journal.(*ingress.SQLStore); ok && sqlStore.DB != nil {
		proc.catalog = catalog.SQL{DB: sqlStore.DB}
		proc.matrix = matrix.SQL{DB: sqlStore.DB}
		proc.queue = commands.SQL{DB: sqlStore.DB}
		proc.audit = audit.SQL{DB: sqlStore.DB}
		proc.rules = rules.SQL{DB: sqlStore.DB}
		proc.config = settings.SQL{DB: sqlStore.DB}
		proc.proxies = proxy.SQL{DB: sqlStore.DB}
		proc.inbox = messaging.SQL{DB: sqlStore.DB}
		proc.cards = cards.SQL{DB: sqlStore.DB}
		proc.codes = enroll.SQLCodes{DB: sqlStore.DB}
		authStore := auth.SQL{DB: sqlStore.DB}
		proc.authSessions = authStore
		proc.users = authStore
		proc.hasher = auth.Bcrypt{}
		// resolve_session already ignores expired rows, so this is housekeeping
		// rather than a boundary; without it the table only ever grows.
		auth.StartSessionPurge(context.Background(), authStore, time.Hour, func(err error) {
			slog.Warn("session purge failed", "error", err)
		})
		lifecycle := commands.SQLLifecycle{DB: sqlStore.DB}
		proc.session.Commands = commands.SQLPending{DB: sqlStore.DB}
		proc.session.Receipts = lifecycle
		// A send's result is also the answer to "did the message arrive", so
		// it updates the conversation as well as the command. Wrapped rather
		// than folded into SQLLifecycle: what a command did and what a message
		// shows are different concerns that happen to share one event.
		proc.session.Results = settlingResults{inner: lifecycle, inbox: proc.inbox}
		proc.session.AfterInsert = proc.afterInsert
		proc.session.ResumeReport = proc.recordResume
	}

	proc.session.Metrics = proc.metrics

	handler := proc.handler()
	httpServer := &http.Server{
		Addr:              address,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    8 << 10,
	}

	tlsAddr := strings.TrimSpace(os.Getenv("VODOGE_GATEWAY_TLS_ADDR"))
	var tlsServer *http.Server
	if tlsAddr != "" {
		if tlsConfig == nil {
			logger.Error("gateway tls", "error", "VODOGE_GATEWAY_TLS_ADDR requires VODOGE_GATEWAY_TLS_*")
			os.Exit(1)
		}
		tlsServer = &http.Server{
			Addr:              tlsAddr,
			Handler:           handler,
			TLSConfig:         tlsConfig,
			ReadHeaderTimeout: 5 * time.Second,
			IdleTimeout:       60 * time.Second,
			MaxHeaderBytes:    8 << 10,
		}
	} else if tlsConfig != nil {
		httpServer.TLSConfig = tlsConfig
	}

	shutdownSignals := make(chan os.Signal, 1)
	signal.Notify(shutdownSignals, syscall.SIGINT, syscall.SIGTERM)
	serverErrors := make(chan error, 1)
	go func() {
		logger.Info("gateway listening", "address", address, "tls_addr", tlsAddr, "mtls", tlsConfig != nil, "sql", os.Getenv("VODOGE_DATABASE_URL") != "", "redis", os.Getenv("REDIS_URL") != "")
		if httpServer.TLSConfig != nil {
			serverErrors <- httpServer.ListenAndServeTLS("", "")
			return
		}
		serverErrors <- httpServer.ListenAndServe()
	}()
	if tlsServer != nil {
		go func() {
			serverErrors <- tlsServer.ListenAndServeTLS("", "")
		}()
	}

	select {
	case signal := <-shutdownSignals:
		logger.Info("gateway shutdown requested", "signal", signal.String())
		context, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(context); err != nil {
			logger.Error("gateway shutdown failed", "error", err)
			os.Exit(1)
		}
		if tlsServer != nil {
			_ = tlsServer.Shutdown(context)
		}
	case err := <-serverErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			logger.Error("gateway stopped", "error", err)
			os.Exit(1)
		}
	}
}

type process struct {
	region  string
	session *wss.Server
	tenants *directory.Resolver
	enroll  *enroll.Handler
	events  *events.Bus
	catalog catalog.Store
	matrix  matrix.Store
	queue   commands.Queue
	audit   audit.Log
	rules   rules.Store
	codes   enroll.CodeStore
	metrics *observe.Registry
	config   settings.Store
	proxies  proxy.Store
	inbox    messaging.Store
	cards    cards.Store
	// authSessions is nil until a database is configured. Endpoints refuse
	// rather than fall back to trusting the Host header.
	authSessions auth.SessionStore
	users        auth.UserStore
	hasher       auth.PasswordHasher
}

func newProcess(region string, store ingress.Store, tenants *directory.Resolver, wakeups wakeup.Publisher, enrollment *enroll.Handler) *process {
	if store == nil {
		store = ingress.NewJournal()
	}
	if tenants == nil {
		tenants = directory.New(nil)
	}
	if base := strings.TrimSpace(os.Getenv("VODOGE_BASE_DOMAIN")); base != "" {
		tenants.BaseDomain = base
	}
	bus := events.NewBus()
	return &process{
		region: region,
		session: &wss.Server{
			Region:  region,
			Hub:     session.NewHub(),
			Journal: store,
			Wakeups: wakeups,
			Events:  bus,
		},
		tenants: tenants,
		enroll:  enrollment,
		events:  bus,
		catalog: catalog.Empty{},
		matrix:  &matrix.Memory{},
		queue:   &commands.Memory{},
		audit:   &audit.Memory{},
		rules:   &rules.Memory{},
		metrics: newRegistry(),
		config:  &settings.Memory{},
		proxies: &proxy.Memory{},
		inbox:   &messaging.Memory{},
		cards:   &cards.Memory{},
		codes:   &enroll.MemoryCodes{},
	}
}

func healthHandler() http.Handler {
	return newProcess("", nil, nil, nil, nil).handler()
}

func (process *process) handler() http.Handler {
	mux := http.NewServeMux()
	// Served on the plain HTTP listener only, which is published to
	// 127.0.0.1 — operational numbers should not be reachable from the
	// internet, and the device listener is a different port with mTLS.
	mux.HandleFunc("GET /metrics", observe.Handler(process.metrics))
	mux.HandleFunc("GET /healthz", healthResponse("healthy", http.StatusOK))
	mux.HandleFunc("GET /readyz", process.readyz)
	// Sign-in has no session yet, and tenant lookup is what the console uses to
	// decide whether a subdomain exists at all. Both stay open; neither returns
	// tenant data.
	// Sign-in is limited per client address rather than per account: limiting
	// by account lets anyone lock out a colleague by failing their password
	// five times, which turns a defence into a denial of service. Five
	// attempts then one every twelve seconds is invisible to a person typing
	// a password and ruinous to anything trying a dictionary.
	signIn := ratelimit.New(1.0/12.0, 5)
	mux.HandleFunc("POST /v1/auth/login",
		ratelimit.Guard(signIn, ratelimit.ClientKey, process.login))
	// A password change is a credential guess too — it needs the current one.
	passwordChange := ratelimit.New(1.0/12.0, 5)
	mux.HandleFunc("POST /v1/auth/logout", process.logout)
	mux.HandleFunc("GET /v1/auth/session", process.currentSession)
	mux.HandleFunc("GET /v1/tenant", process.tenants.ServeHost)
	mux.Handle("GET /v1/tenants/{slug}", process.tenants)
	if process.enroll != nil {
		mux.Handle("POST "+enroll.Path, process.enroll)
	} else {
		mux.HandleFunc("POST "+enroll.Path, enroll.Unavailable)
	}
	mux.Handle("GET "+wss.Path, process.session)
	mux.HandleFunc("GET /v1/events", process.sse)
	mux.HandleFunc("GET /v1/devices", process.devices)
	mux.HandleFunc("GET /v1/modems", process.modems)
	mux.HandleFunc("GET /v1/messages", process.messages)
	mux.HandleFunc("GET /v1/sessions", process.sessions)
	mux.HandleFunc("GET /v1/capability-matrix", process.getMatrix)
	mux.HandleFunc("PUT /v1/capability-matrix", process.putMatrix)
	// Commands cost a device real time — an operator scan takes the radio away
	// for over a minute — so this is limited per tenant rather than per
	// caller: two operators in one tenant should not be able to queue twice as
	// much work for the same hardware. The burst covers working through a
	// device page; the rate is well above what a person generates.
	commandRate := ratelimit.New(2, 30)
	mux.HandleFunc("POST /v1/commands",
		ratelimit.Guard(commandRate, process.tenantKey, process.enqueueCommand))
	mux.HandleFunc("GET /v1/commands/kinds", process.commandKinds)
	mux.HandleFunc("GET /v1/commands", process.listCommands)
	mux.HandleFunc("GET /v1/journal", process.listJournal)
	mux.HandleFunc("GET /v1/esim/profiles", process.listEsimProfiles)
	mux.HandleFunc("GET /v1/settings", process.readSettings)
	mux.HandleFunc("PUT /v1/settings/{section}", process.writeSettings)
	mux.HandleFunc("POST /v1/auth/password",
		ratelimit.Guard(passwordChange, ratelimit.ClientKey, process.changePassword))
	process.registerProxyRoutes(mux)
	process.registerMessagingRoutes(mux)
	process.registerCardRoutes(mux)
	process.registerDeviceRoutes(mux)
	mux.HandleFunc("GET /v1/audit", process.listAudit)
	mux.HandleFunc("GET /v1/rules", process.listRules)
	mux.HandleFunc("POST /v1/rules", process.createRule)
	mux.HandleFunc("GET /v1/enrollment-codes", process.listEnrollmentCodes)
	mux.HandleFunc("POST /v1/enrollment-codes", process.createEnrollmentCode)
	// Metrics wrap the mux rather than each handler, so a route added later
	// is measured without anyone remembering to measure it.
	return securityHeaders(observe.Middleware(process.metrics, mux))
}

// login exchanges a credential for a session token.
//
// The tenant comes from the Host, which scopes the attempt rather than granting
// anything: the password still has to match a user inside that tenant.
// The only tenant status that may transact. `suspended` and `disabled` both
// stop at the boundary; the difference between them is an operations
// distinction, not an access one.
const tenantActive = "active"

func (process *process) login(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.hostTenant(request)
	if !ok {
		http.Error(writer, "unknown tenant", http.StatusNotFound)
		return
	}
	// Same gate as tenantFromRequest: without it an offboarded tenant could
	// still mint fresh sessions, which is the one thing offboarding must stop.
	if entry.Status != tenantActive {
		http.Error(writer, "tenant is not active", http.StatusForbidden)
		return
	}
	if process.users == nil || process.authSessions == nil || process.hasher == nil {
		http.Error(writer, "authentication is unavailable", http.StatusServiceUnavailable)
		return
	}
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(io.LimitReader(request.Body, 4<<10)).Decode(&body); err != nil {
		http.Error(writer, "invalid request", http.StatusBadRequest)
		return
	}
	token, session, err := auth.SignIn(
		request.Context(), process.users, process.authSessions, process.hasher,
		entry.TenantID, body.Email, body.Password, time.Now(), auth.DefaultSessionTTL,
	)
	switch {
	case errors.Is(err, auth.ErrBadCredentials), errors.Is(err, auth.ErrUserDisabled):
		// One message for both. Which of the two it was tells an attacker
		// whether the address is registered.
		_ = process.audit.Append(request.Context(), entry.TenantID, audit.Event{
			Actor:  strings.ToLower(strings.TrimSpace(body.Email)),
			Action: "auth.login.failed",
		})
		http.Error(writer, "email or password is incorrect", http.StatusUnauthorized)
		return
	case err != nil:
		slog.Warn("sign-in failed", "tenant_id", entry.TenantID, "error", err)
		http.Error(writer, "authentication unavailable", http.StatusInternalServerError)
		return
	}
	_ = process.audit.Append(request.Context(), entry.TenantID, audit.Event{
		Actor:  session.UserID,
		Action: "auth.login",
	})
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(writer).Encode(map[string]any{
		"token":      token,
		"expires_at": session.ExpiresAt.UTC().Format(time.RFC3339),
		"tenant_id":  session.TenantID,
		"user_id":    session.UserID,
	})
}

// logout drops the presented session. It does not require the session to be
// valid: the caller wants it gone either way.
func (process *process) logout(writer http.ResponseWriter, request *http.Request) {
	if process.authSessions != nil {
		if err := auth.SignOut(request.Context(), process.authSessions, request.Header.Get("Authorization")); err != nil {
			slog.Warn("sign-out failed", "error", err)
		}
	}
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(http.StatusNoContent)
}

// currentSession lets the console check a cookie without fetching tenant data.
func (process *process) currentSession(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(writer).Encode(map[string]any{
		"tenant_id": entry.TenantID,
		"slug":      entry.Slug,
		"region":    entry.Region,
	})
}

// hostTenant resolves the tenant a request was addressed to.
//
// This grants nothing. It says which tenant the caller is *asking about*, and
// the answer is only trustworthy once a session has been checked against it.
func (process *process) hostTenant(request *http.Request) (region.Entry, bool) {
	slug, ok := directory.SlugFromHost(request.Header.Get("X-Forwarded-Host"), process.tenants.BaseDomain)
	if !ok {
		slug, ok = directory.SlugFromHost(request.Host, process.tenants.BaseDomain)
	}
	if !ok {
		return region.Entry{}, false
	}
	entry, found, err := process.tenants.Resolve(request.Context(), slug)
	if err != nil || !found {
		return region.Entry{}, false
	}
	return entry, true
}

// tenantFromRequest authenticates the caller and returns the tenant it may act
// for, writing the failure response itself.
//
// Every tenant-scoped endpoint already called this name, so making this the
// authenticated path closes them all at once and leaves no version of the
// lookup that skips the check. The tenant returned is the session's, not the
// host's: the host is only cross-checked, so a valid session for one tenant
// cannot read another by changing a header.
func (process *process) tenantFromRequest(
	writer http.ResponseWriter,
	request *http.Request,
) (region.Entry, bool) {
	entry, ok := process.hostTenant(request)
	if !ok {
		http.Error(writer, "unknown tenant", http.StatusNotFound)
		return region.Entry{}, false
	}
	// An offboarded tenant kept working until every one of its sessions
	// expired, because status was resolved and then never read. Checked before
	// authentication so a suspended tenant cannot be probed for whether a
	// given credential is valid.
	if entry.Status != tenantActive {
		http.Error(writer, "tenant is not active", http.StatusForbidden)
		return region.Entry{}, false
	}
	if process.authSessions == nil {
		// Refuse rather than fall back to host-only trust. A gateway started
		// without a session store must not serve tenant data at all.
		http.Error(writer, "authentication is unavailable", http.StatusServiceUnavailable)
		return region.Entry{}, false
	}
	session, err := auth.Authenticate(
		request.Context(),
		process.authSessions,
		request.Header.Get("Authorization"),
		entry.TenantID,
		time.Now(),
	)
	switch {
	case errors.Is(err, auth.ErrNoCredential), errors.Is(err, auth.ErrInvalidSession):
		http.Error(writer, "sign in required", http.StatusUnauthorized)
		return region.Entry{}, false
	case errors.Is(err, auth.ErrTenantMismatch):
		// Deliberately not "not found": the caller proved an identity, it just
		// does not belong here, and hiding that makes the failure unreadable.
		http.Error(writer, "session belongs to another tenant", http.StatusForbidden)
		return region.Entry{}, false
	case err != nil:
		slog.Warn("session lookup failed", "tenant_id", entry.TenantID, "error", err)
		http.Error(writer, "authentication unavailable", http.StatusInternalServerError)
		return region.Entry{}, false
	}
	_ = session
	return entry, true
}

// tenantAndSession is tenantFromRequest for the handlers that need to know who
// is asking, not only which tenant they belong to.
func (process *process) tenantAndSession(
	writer http.ResponseWriter,
	request *http.Request,
) (region.Entry, auth.Session, bool) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return region.Entry{}, auth.Session{}, false
	}
	session, err := auth.Authenticate(
		request.Context(),
		process.authSessions,
		request.Header.Get("Authorization"),
		entry.TenantID,
		time.Now(),
	)
	if err != nil {
		http.Error(writer, "sign in required", http.StatusUnauthorized)
		return region.Entry{}, auth.Session{}, false
	}
	return entry, session, true
}

// modems lists the modules the edge has reported, which is what says whether a
// device's hardware is actually usable — a device can be online while every
// module on it has lost its network.
func (process *process) modems(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	list, err := process.catalog.ListModems(request.Context(), entry.TenantID)
	if err != nil {
		http.Error(writer, "catalog unavailable", http.StatusInternalServerError)
		return
	}
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(writer).Encode(map[string]any{"modems": list})
}

func (process *process) devices(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	list, err := process.catalog.ListDevices(request.Context(), entry.TenantID)
	if err != nil {
		http.Error(writer, "catalog unavailable", http.StatusInternalServerError)
		return
	}
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(writer).Encode(map[string]any{"devices": list})
}

func (process *process) messages(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	list, err := process.catalog.ListMessages(request.Context(), entry.TenantID)
	if err != nil {
		http.Error(writer, "catalog unavailable", http.StatusInternalServerError)
		return
	}
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(writer).Encode(map[string]any{"messages": list})
}

func (process *process) sessions(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	list, err := process.catalog.ListSessions(request.Context(), entry.TenantID)
	if err != nil {
		http.Error(writer, "catalog unavailable", http.StatusInternalServerError)
		return
	}
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(writer).Encode(map[string]any{"sessions": list})
}

func (process *process) getMatrix(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	overlay, found, err := process.matrix.Get(request.Context(), entry.TenantID)
	if err != nil {
		http.Error(writer, "matrix unavailable", http.StatusInternalServerError)
		return
	}
	if !found {
		http.Error(writer, "matrix not found", http.StatusNotFound)
		return
	}
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(writer).Encode(overlay)
}

func (process *process) putMatrix(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	var body struct {
		Matrix json.RawMessage `json:"matrix"`
	}
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil || len(body.Matrix) == 0 {
		http.Error(writer, "invalid matrix", http.StatusBadRequest)
		return
	}
	overlay, err := matrix.Parse(body.Matrix)
	if err != nil {
		http.Error(writer, err.Error(), http.StatusBadRequest)
		return
	}
	if err := process.matrix.Put(request.Context(), entry.TenantID, overlay); err != nil {
		http.Error(writer, "matrix unavailable", http.StatusInternalServerError)
		return
	}
	devices, err := process.catalog.ListDevices(request.Context(), entry.TenantID)
	if err != nil {
		http.Error(writer, "catalog unavailable", http.StatusInternalServerError)
		return
	}
	payload, err := matrix.CommandPayload(overlay)
	if err != nil {
		http.Error(writer, "matrix unavailable", http.StatusInternalServerError)
		return
	}
	expires := time.Now().Add(24 * time.Hour)
	queued := 0
	for _, device := range devices {
		if _, err := process.queue.Enqueue(request.Context(), commands.Item{
			TenantID:       entry.TenantID,
			DeviceID:       device.ID,
			Kind:           "update_capability_matrix",
			IdempotencyKey: "matrix:" + overlay.Version + ":" + device.ID,
			Payload:        payload,
			ExpiresAt:      expires,
		}); err != nil {
			http.Error(writer, "command queue unavailable", http.StatusInternalServerError)
			return
		}
		queued++
	}
	detail, _ := json.Marshal(map[string]any{"version": overlay.Version, "sha256": overlay.SHA256, "devices": queued})
	_ = process.audit.Append(request.Context(), entry.TenantID, audit.Event{
		Actor:  "gateway",
		Action: "update_capability_matrix",
		Target: overlay.Version,
		Detail: detail,
	})
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(writer).Encode(map[string]any{
		"version": overlay.Version,
		"sha256":  overlay.SHA256,
		"queued":  queued,
	})
}

func (process *process) enqueueCommand(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	var body commands.Request
	if err := json.NewDecoder(io.LimitReader(request.Body, 64<<10)).Decode(&body); err != nil {
		http.Error(writer, "invalid command", http.StatusBadRequest)
		return
	}
	spec, payload, err := commands.BuildPayload(body)
	if err != nil {
		// The reason is the caller's to fix, so it is returned rather than
		// flattened into a generic 400.
		var invalid commands.ErrInvalid
		if errors.As(err, &invalid) {
			http.Error(writer, invalid.Reason, http.StatusBadRequest)
			return
		}
		http.Error(writer, "invalid command", http.StatusBadRequest)
		return
	}
	process.metrics.Add(observe.CommandsTotal, 1, "kind", spec.Kind)
	id, err := process.queue.Enqueue(request.Context(), commands.Item{
		TenantID: entry.TenantID,
		DeviceID: body.DeviceID,
		Kind:     spec.Kind,
		// Two identical commands issued a nanosecond apart are two separate
		// intentions — a second AT+CSQ is a second reading, not a duplicate.
		IdempotencyKey: fmt.Sprintf("%s:%s:%d", spec.Kind, body.DeviceID, time.Now().UnixNano()),
		Payload:        payload,
		ExpiresAt:      time.Now().Add(10 * time.Minute),
	})
	if err != nil {
		http.Error(writer, "command queue unavailable", http.StatusInternalServerError)
		return
	}
	_ = process.audit.Append(request.Context(), entry.TenantID, audit.Event{
		Actor:  "console",
		Action: spec.Kind,
		Target: body.DeviceID,
		Detail: payload,
	})
	// A sent message belongs in the conversation immediately, with an honest
	// `queued` status. Waiting for the device would mean it vanishing for
	// however long the device takes to answer — or forever, if it never does.
	if spec.Kind == "send_sms" && process.inbox != nil {
		commandID := id
		if err := process.inbox.RecordOutbound(request.Context(), entry.TenantID,
			messaging.Message{
				DeviceID:  body.DeviceID,
				Peer:      body.To,
				Body:      body.Body,
				CommandID: &commandID,
			}); err != nil {
			// Not fatal: the message is queued either way, and refusing the
			// send because the conversation could not be updated would be
			// the wrong trade.
			slog.Warn("outbound message not recorded",
				"tenant_id", entry.TenantID, "command_id", id, "error", err)
		}
	}
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(writer).Encode(map[string]any{"id": id, "status": "queued"})
}

// changePassword lets a signed-in operator replace their own credential.
func (process *process) changePassword(writer http.ResponseWriter, request *http.Request) {
	_, session, ok := process.tenantAndSession(writer, request)
	if !ok {
		return
	}
	changer, canChange := process.users.(auth.PasswordChanger)
	if !canChange || process.hasher == nil {
		http.Error(writer, "password changes are unavailable", http.StatusServiceUnavailable)
		return
	}
	var body struct {
		Current string `json:"current_password"`
		Next    string `json:"new_password"`
	}
	if err := json.NewDecoder(io.LimitReader(request.Body, 4<<10)).Decode(&body); err != nil {
		http.Error(writer, "invalid request", http.StatusBadRequest)
		return
	}
	err := auth.ChangePassword(
		request.Context(), changer, process.hasher, session,
		body.Current, body.Next,
		auth.Fingerprint(auth.BearerToken(request.Header.Get("Authorization"))),
	)
	switch {
	case errors.Is(err, auth.ErrWeakPassword):
		http.Error(writer, err.Error(), http.StatusBadRequest)
		return
	case errors.Is(err, auth.ErrBadCredentials):
		http.Error(writer, "current password is incorrect", http.StatusUnauthorized)
		return
	case err != nil:
		slog.Warn("password change failed", "tenant_id", session.TenantID, "error", err)
		http.Error(writer, "password change failed", http.StatusInternalServerError)
		return
	}
	_ = process.audit.Append(request.Context(), session.TenantID, audit.Event{
		Actor:  "console",
		Action: "auth.password_changed",
		Target: session.UserID,
	})
	writer.WriteHeader(http.StatusNoContent)
}

// listEsimProfiles returns what each eUICC last reported it holds.
func (process *process) listEsimProfiles(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	profiles, err := process.catalog.ListEsimProfiles(
		request.Context(), entry.TenantID, request.URL.Query().Get("device_id"))
	if err != nil {
		http.Error(writer, "esim inventory unavailable", http.StatusInternalServerError)
		return
	}
	writeJSON(writer, map[string]any{"profiles": profiles})
}

// listJournal reads what devices actually said, as opposed to what the
// projections made of it.
//
// When something looks wrong on a page the question is always whether the
// device reported it that way or the projection mangled it. Nothing could
// answer that before: the journal held thirty thousand envelopes and had no
// reader.
func (process *process) listJournal(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	query := request.URL.Query()
	criteria := catalog.EventQuery{
		DeviceID: query.Get("device_id"),
		Kind:     query.Get("kind"),
		// Payloads are opt-in: a page of DeviceState envelopes is a megabyte
		// of JSON that the list view does not show.
		WithPayload: query.Get("payload") == "1",
	}
	if raw := query.Get("before"); raw != "" {
		if parsed, err := strconv.ParseInt(raw, 10, 64); err == nil {
			criteria.Before = parsed
		}
	}
	if raw := query.Get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			criteria.Limit = parsed
		}
	}
	events, err := process.catalog.ListEvents(request.Context(), entry.TenantID, criteria)
	if err != nil {
		http.Error(writer, "journal unavailable", http.StatusInternalServerError)
		return
	}
	// The cursor for the next page is the oldest row's timestamp. Returned
	// rather than left for the caller to compute, so paging cannot drift.
	var next int64
	if len(events) > 0 {
		next = events[len(events)-1].ReceivedAt
	}
	writeJSON(writer, map[string]any{"events": events, "next_before": next})
}

// readSettings returns every section, secrets replaced by a placeholder.
//
// The console never receives a webhook secret or an SMTP password: it would
// otherwise sit in a page's HTML on every visit, so that it could be posted
// back unchanged. Sending the placeholder back means "leave it alone".
func (process *process) readSettings(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	all, err := process.config.All(request.Context(), entry.TenantID)
	if err != nil {
		http.Error(writer, "settings unavailable", http.StatusInternalServerError)
		return
	}
	shown := make(map[string]map[string]any, len(all))
	for section, document := range all {
		shown[section] = settings.Redact(section, document)
	}
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(writer).Encode(map[string]any{"settings": shown})
}

func (process *process) writeSettings(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	section := request.PathValue("section")
	var incoming map[string]any
	if err := json.NewDecoder(io.LimitReader(request.Body, 256<<10)).Decode(&incoming); err != nil {
		http.Error(writer, "invalid settings document", http.StatusBadRequest)
		return
	}
	if incoming == nil {
		incoming = map[string]any{}
	}
	stored, err := process.config.Get(request.Context(), entry.TenantID, section)
	if err != nil {
		http.Error(writer, "settings unavailable", http.StatusInternalServerError)
		return
	}
	// Merge before validating: a channel whose only missing field is the
	// secret it never received is valid once the stored one is back.
	merged := settings.Merge(section, incoming, stored)
	validated, err := settings.Validate(section, merged)
	if err != nil {
		var invalid settings.ErrInvalid
		if errors.As(err, &invalid) {
			http.Error(writer, invalid.Reason, http.StatusBadRequest)
			return
		}
		http.Error(writer, "invalid settings document", http.StatusBadRequest)
		return
	}
	if err := process.config.Put(request.Context(), entry.TenantID, section, validated); err != nil {
		http.Error(writer, "settings unavailable", http.StatusInternalServerError)
		return
	}
	// The values are not audited, only the fact of the change: a settings
	// document holds credentials and the audit log is read far more widely
	// than the settings page.
	_ = process.audit.Append(request.Context(), entry.TenantID, audit.Event{
		Actor:  "console",
		Action: "settings." + section,
		Target: section,
	})
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(writer).Encode(map[string]any{
		"section":  section,
		"settings": settings.Redact(section, validated),
	})
}

// listCommands is how the console reads a relayed diagnostic's answer. The
// command is queued, the device runs it, and the result lands here — there is
// no synchronous path and there should not be one, since a scan takes minutes.
func (process *process) listCommands(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	deviceID := request.URL.Query().Get("device_id")
	limit := 50
	if raw := request.URL.Query().Get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			limit = parsed
		}
	}
	list, err := process.catalog.ListCommands(request.Context(), entry.TenantID, deviceID, limit)
	if err != nil {
		http.Error(writer, "catalog unavailable", http.StatusInternalServerError)
		return
	}
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(writer).Encode(map[string]any{"commands": list})
}

// settlingResults records a command result and, when it settles a send,
// updates the message in the conversation.
type settlingResults struct {
	inner interface {
		RecordResult(tenantID string, result dispatch.CommandResult) error
	}
	inbox messaging.Store
}

func (handler settlingResults) RecordResult(
	tenantID string,
	result dispatch.CommandResult,
) error {
	// The command record comes first: it is the durable one, and a message
	// left saying `queued` is a far smaller problem than a command whose
	// outcome was lost.
	if err := handler.inner.RecordResult(tenantID, result); err != nil {
		return err
	}
	if handler.inbox == nil {
		return nil
	}
	status := "sent"
	if result.Status != dispatch.ResultSucceeded {
		status = "failed"
	}
	reason := result.Reason
	if reason == "" {
		reason = result.ReasonCode
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// Every command kind is offered; only one has a message waiting on it, and
	// the update matches nothing for the rest.
	if err := handler.inbox.SettleOutbound(ctx, tenantID, result.CommandID, status, reason); err != nil {
		slog.Warn("outbound message not settled",
			"tenant_id", tenantID, "command_id", result.CommandID, "error", err)
	}
	return nil
}

// recordResume stores what a device said about itself when it connected.
//
// Best effort and off the connection's critical path in spirit: a device that
// reconnects must not be refused because its version could not be written
// down.
func (process *process) recordResume(tenantID, deviceID string, report wss.DeviceReport) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := process.catalog.RecordResume(ctx, tenantID, deviceID,
		report.EdgeVersion, report.MatrixVersion,
		report.QueueRecords, report.QueueBytes); err != nil {
		slog.Warn("device resume not recorded",
			"tenant_id", tenantID, "device_id", deviceID, "error", err)
	}
}

// newRegistry declares every metric this process reports.
//
// Declared at construction rather than on first use so a series reads zero
// before anything happens. An absent series and a zero one look very different
// on a graph, and only one of them is true.
func newRegistry() *observe.Registry {
	registry := observe.New()
	observe.Declare(registry)
	return registry
}

// tenantKey limits by tenant, falling back to the client address when the
// tenant cannot be resolved — an unresolvable host is exactly the traffic that
// should not get an unlimited allowance while it is being refused.
func (process *process) tenantKey(request *http.Request) string {
	if entry, ok := process.hostTenant(request); ok {
		return "tenant:" + entry.TenantID
	}
	return "addr:" + ratelimit.ClientKey(request)
}

// commandKinds tells the console what this gateway can dispatch, so the device
// page renders the actions the deployment actually supports instead of a list
// compiled into the frontend that can drift from the backend.
func (process *process) commandKinds(writer http.ResponseWriter, request *http.Request) {
	if _, ok := process.tenantFromRequest(writer, request); !ok {
		return
	}
	type entry struct {
		Kind       string `json:"kind"`
		NeedsModem bool   `json:"needs_modem"`
		Mutating   bool   `json:"mutating"`
	}
	list := make([]entry, 0, len(commands.Kinds()))
	for _, kind := range commands.Kinds() {
		spec, _ := commands.Lookup(kind)
		list = append(list, entry{Kind: spec.Kind, NeedsModem: spec.NeedsModem, Mutating: spec.Mutating})
	}
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(writer).Encode(map[string]any{"commands": list})
}

func (process *process) listAudit(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	events, err := process.audit.List(request.Context(), entry.TenantID)
	if err != nil {
		http.Error(writer, "audit unavailable", http.StatusInternalServerError)
		return
	}
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(writer).Encode(map[string]any{"events": events})
}

func (process *process) listRules(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	list, err := process.rules.List(request.Context(), entry.TenantID)
	if err != nil {
		http.Error(writer, "rules unavailable", http.StatusInternalServerError)
		return
	}
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(writer).Encode(map[string]any{"rules": list})
}

func (process *process) createRule(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	var body struct {
		Name    string          `json:"name"`
		Matcher json.RawMessage `json:"matcher"`
		Action  json.RawMessage `json:"action"`
		Enabled *bool           `json:"enabled"`
	}
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil || strings.TrimSpace(body.Name) == "" {
		http.Error(writer, "invalid rule", http.StatusBadRequest)
		return
	}
	enabled := true
	if body.Enabled != nil {
		enabled = *body.Enabled
	}
	rule, err := process.rules.Create(request.Context(), entry.TenantID, rules.Rule{
		Name:    body.Name,
		Matcher: body.Matcher,
		Action:  body.Action,
		Enabled: enabled,
	})
	if err != nil {
		http.Error(writer, "rules unavailable", http.StatusInternalServerError)
		return
	}
	detail, _ := json.Marshal(map[string]any{"id": rule.ID, "name": rule.Name})
	_ = process.audit.Append(request.Context(), entry.TenantID, audit.Event{
		Actor:  "console",
		Action: "create_rule",
		Target: rule.ID,
		Detail: detail,
	})
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(writer).Encode(rule)
}

func (process *process) listEnrollmentCodes(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	list, err := process.codes.List(request.Context(), entry.TenantID)
	if err != nil {
		http.Error(writer, "enrollment unavailable", http.StatusInternalServerError)
		return
	}
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(writer).Encode(map[string]any{"codes": list})
}

func (process *process) createEnrollmentCode(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	var body struct {
		TTLHours int `json:"ttl_hours"`
	}
	_ = json.NewDecoder(request.Body).Decode(&body)
	ttl := time.Duration(body.TTLHours) * time.Hour
	if ttl <= 0 {
		ttl = 24 * time.Hour
	}
	code, err := process.codes.Create(request.Context(), entry.TenantID, ttl)
	if err != nil {
		http.Error(writer, "enrollment unavailable", http.StatusInternalServerError)
		return
	}
	detail, _ := json.Marshal(map[string]any{"code": code.Code, "expires_at": code.ExpiresAt})
	_ = process.audit.Append(request.Context(), entry.TenantID, audit.Event{
		Actor:  "console",
		Action: "create_enrollment_code",
		Target: code.ID,
		Detail: detail,
	})
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(writer).Encode(code)
}

func (process *process) afterInsert(tenantID, _deviceID, kind string, payload []byte) {
	if kind != "SmsReceived" {
		return
	}
	var sms struct {
		Peer string `json:"peer"`
		Body string `json:"body"`
	}
	if err := json.Unmarshal(payload, &sms); err != nil || strings.TrimSpace(sms.Body) == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	list, err := process.rules.List(ctx, tenantID)
	if err != nil {
		return
	}
	code, ok := rules.ExtractWith(sms.Body, rules.PatternsFrom(list))
	if !ok {
		return
	}
	detail, _ := json.Marshal(map[string]any{"peer": sms.Peer, "code": code})
	_ = process.audit.Append(ctx, tenantID, audit.Event{
		Actor:  "gateway",
		Action: "otp_extracted",
		Target: sms.Peer,
		Detail: detail,
	})
}

func (process *process) sse(writer http.ResponseWriter, request *http.Request) {
	slug, ok := directory.SlugFromHost(request.Header.Get("X-Forwarded-Host"), process.tenants.BaseDomain)
	if !ok {
		slug, ok = directory.SlugFromHost(request.Host, process.tenants.BaseDomain)
	}
	if !ok {
		http.Error(writer, "unknown tenant", http.StatusNotFound)
		return
	}
	entry, found, err := process.tenants.Resolve(request.Context(), slug)
	if err != nil || !found {
		http.Error(writer, "unknown tenant", http.StatusNotFound)
		return
	}
	flusher, ok := writer.(http.Flusher)
	if !ok {
		http.Error(writer, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	writer.Header().Set("Content-Type", "text/event-stream")
	writer.Header().Set("Cache-Control", "no-store")
	ch, cancel := process.events.Subscribe(entry.TenantID)
	defer cancel()
	fmt.Fprintf(writer, "event: hello\ndata: %s\n\n", entry.Slug)
	flusher.Flush()
	ctx := request.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case event, open := <-ch:
			if !open {
				return
			}
			fmt.Fprintf(writer, "event: uplink\ndata: %s\n\n", event)
			flusher.Flush()
		}
	}
}

func (process *process) readyz(writer http.ResponseWriter, _ *http.Request) {
	if err := pingStore(process.session.Journal); err != nil {
		healthResponse("not-ready", http.StatusServiceUnavailable)(writer, nil)
		return
	}
	healthResponse("ready", http.StatusOK)(writer, nil)
}

func pingStore(store ingress.Store) error {
	pinger, ok := store.(interface{ Ping() error })
	if !ok {
		return nil
	}
	return pinger.Ping()
}

func connectWakeup(url, nodeID string, logger *slog.Logger) wakeup.Publisher {
	if logger == nil {
		logger = slog.Default()
	}
	url = strings.TrimSpace(url)
	nodeID = strings.TrimSpace(nodeID)
	if nodeID == "" {
		host, err := os.Hostname()
		if err != nil || strings.TrimSpace(host) == "" {
			nodeID = "gateway"
		} else {
			nodeID = strings.TrimSpace(host)
		}
	}
	if url == "" {
		logger.Info("gateway redis disabled", "reason", "REDIS_URL unset")
		return wakeup.Nop{}
	}

	conn, err := wakeup.Dial(url, nodeID)
	if err != nil {
		logger.Error("gateway redis", "error", err)
		return wakeup.Nop{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := conn.Ping(ctx); err != nil {
		logger.Warn("gateway redis ping failed; uplink continues without routing hints until redis recovers", "error", err, "node_id", nodeID)
		return conn
	}
	logger.Info("gateway redis connected", "node_id", nodeID)
	return conn
}

func openRuntime() (ingress.Store, *directory.Resolver, *enroll.Handler, error) {
	dsn := os.Getenv("VODOGE_DATABASE_URL")
	if dsn == "" {
		return ingress.NewJournal(), directory.New(nil), nil, nil
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("open database: %w", err)
	}
	db.SetMaxOpenConns(32)
	db.SetConnMaxLifetime(time.Hour)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, nil, nil, fmt.Errorf("ping database: %w", err)
	}

	var enrollment *enroll.Handler
	authority, err := loadDeviceCA()
	if err != nil {
		_ = db.Close()
		return nil, nil, nil, err
	}
	if authority != nil {
		enrollment = &enroll.Handler{
			Service: &enroll.Service{
				Issuer: &enroll.SQLIssuer{DB: db},
				CA:     authority,
			},
		}
	}
	return &ingress.SQLStore{DB: db}, directory.New(directory.SQLLookup(db)), enrollment, nil
}

func loadDeviceCA() (*enroll.Authority, error) {
	certFile := os.Getenv("VODOGE_DEVICE_CA_CERT")
	keyFile := os.Getenv("VODOGE_DEVICE_CA_KEY")
	if certFile == "" && keyFile == "" {
		return nil, nil
	}
	if certFile == "" || keyFile == "" {
		return nil, errors.New("VODOGE_DEVICE_CA_CERT and VODOGE_DEVICE_CA_KEY are required together")
	}
	certPEM, err := os.ReadFile(certFile)
	if err != nil {
		return nil, fmt.Errorf("read device CA certificate: %w", err)
	}
	keyPEM, err := os.ReadFile(keyFile)
	if err != nil {
		return nil, fmt.Errorf("read device CA key: %w", err)
	}
	return enroll.ParseAuthority(certPEM, keyPEM)
}

func healthResponse(status string, code int) http.HandlerFunc {
	return func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json; charset=utf-8")
		writer.Header().Set("Cache-Control", "no-store")
		writer.WriteHeader(code)
		if err := json.NewEncoder(writer).Encode(map[string]string{
			"component": "vodoge-gateway",
			"mode":      "edge",
			"status":    status,
		}); err != nil {
			_ = fmt.Errorf("encode health response: %w", err)
		}
	}
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		writer.Header().Set("X-Frame-Options", "DENY")
		writer.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(writer, request)
	})
}

func optionalServerTLS() (*tls.Config, error) {
	certFile := os.Getenv("VODOGE_GATEWAY_TLS_CERT")
	keyFile := os.Getenv("VODOGE_GATEWAY_TLS_KEY")
	caFile := os.Getenv("VODOGE_GATEWAY_CLIENT_CA")
	if certFile == "" && keyFile == "" && caFile == "" {
		return nil, nil
	}
	if certFile == "" || keyFile == "" || caFile == "" {
		return nil, errors.New("VODOGE_GATEWAY_TLS_CERT, VODOGE_GATEWAY_TLS_KEY, and VODOGE_GATEWAY_CLIENT_CA are required together")
	}
	certificate, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("load gateway certificate: %w", err)
	}
	pem, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("read client CA: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, errors.New("client CA file contained no certificates")
	}
	return transport.OptionalClientTLSConfig(certificate, pool)
}
