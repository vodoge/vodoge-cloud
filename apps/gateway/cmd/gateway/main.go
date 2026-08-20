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
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/directory"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/enroll"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/ingress"
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

	httpServer := &http.Server{
		Addr:              address,
		Handler:           newProcess(os.Getenv("VODOGE_GATEWAY_REGION"), journal, tenants, wakeups, enrollment).handler(),
		TLSConfig:         tlsConfig,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    8 << 10,
	}

	shutdownSignals := make(chan os.Signal, 1)
	signal.Notify(shutdownSignals, syscall.SIGINT, syscall.SIGTERM)
	serverErrors := make(chan error, 1)
	go func() {
		logger.Info("gateway listening", "address", address, "mtls", tlsConfig != nil, "sql", os.Getenv("VODOGE_DATABASE_URL") != "", "redis", os.Getenv("REDIS_URL") != "")
		if tlsConfig != nil {
			serverErrors <- httpServer.ListenAndServeTLS("", "")
			return
		}
		serverErrors <- httpServer.ListenAndServe()
	}()

	select {
	case signal := <-shutdownSignals:
		logger.Info("gateway shutdown requested", "signal", signal.String())
		context, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(context); err != nil {
			logger.Error("gateway shutdown failed", "error", err)
			os.Exit(1)
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
	return &process{
		region: region,
		session: &wss.Server{
			Region:  region,
			Hub:     session.NewHub(),
			Journal: store,
			Wakeups: wakeups,
		},
		tenants: tenants,
		enroll:  enrollment,
	}
}

func healthHandler() http.Handler {
	return newProcess("", nil, nil, nil, nil).handler()
}

func (process *process) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", healthResponse("healthy", http.StatusOK))
	mux.HandleFunc("GET /readyz", process.readyz)
	mux.HandleFunc("GET /v1/tenant", process.tenants.ServeHost)
	mux.Handle("GET /v1/tenants/{slug}", process.tenants)
	if process.enroll != nil {
		mux.Handle("POST "+enroll.Path, process.enroll)
	} else {
		mux.HandleFunc("POST "+enroll.Path, enroll.Unavailable)
	}
	mux.Handle("GET "+wss.Path, process.session)
	return securityHeaders(mux)
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
