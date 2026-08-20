// Command gateway is the Cloud device-facing process.
//
// /healthz and /readyz stay on plaintext HTTP for the Compose healthcheck.
// /v1/edge upgrades to the authenticated device WebSocket. Production supplies
// VODOGE_GATEWAY_TLS_* so that listener uses TLS 1.3 mTLS.
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
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/ingress"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/session"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/transport"
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

	journal, err := openJournal()
	if err != nil {
		logger.Error("gateway database", "error", err)
		os.Exit(1)
	}

	httpServer := &http.Server{
		Addr:              address,
		Handler:           newProcess(os.Getenv("VODOGE_GATEWAY_REGION"), journal).handler(),
		TLSConfig:         tlsConfig,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    8 << 10,
	}

	shutdownSignals := make(chan os.Signal, 1)
	signal.Notify(shutdownSignals, syscall.SIGINT, syscall.SIGTERM)
	serverErrors := make(chan error, 1)
	go func() {
		logger.Info("gateway listening", "address", address, "mtls", tlsConfig != nil, "sql", os.Getenv("VODOGE_DATABASE_URL") != "")
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
}

func newProcess(region string, store ingress.Store) *process {
	if store == nil {
		store = ingress.NewJournal()
	}
	return &process{
		region: region,
		session: &wss.Server{
			Region:  region,
			Hub:     session.NewHub(),
			Journal: store,
		},
	}
}

func healthHandler() http.Handler {
	return newProcess("", nil).handler()
}

func (process *process) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", healthResponse("healthy", http.StatusOK))
	mux.HandleFunc("GET /readyz", process.readyz)
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

func openJournal() (ingress.Store, error) {
	dsn := os.Getenv("VODOGE_DATABASE_URL")
	if dsn == "" {
		return ingress.NewJournal(), nil
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	db.SetMaxOpenConns(32)
	db.SetConnMaxLifetime(time.Hour)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return &ingress.SQLStore{DB: db}, nil
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
	return transport.ServerTLSConfig(certificate, pool)
}
