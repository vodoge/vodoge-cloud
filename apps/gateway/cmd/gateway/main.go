// Command gateway starts the initial Cloud gateway process.
//
// The process currently provides deployment health endpoints only. WSS,
// MessagePack framing, and device authentication are added in later slices;
// this binary deliberately does not claim to accept device traffic yet.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

const defaultAddress = ":8080"

func main() {
	address := os.Getenv("VODOGE_GATEWAY_ADDR")
	if address == "" {
		address = defaultAddress
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	server := &http.Server{
		Addr:              address,
		Handler:           healthHandler(),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    8 << 10,
	}

	shutdownSignals := make(chan os.Signal, 1)
	signal.Notify(shutdownSignals, syscall.SIGINT, syscall.SIGTERM)
	serverErrors := make(chan error, 1)
	go func() {
		logger.Info("gateway foundation listening", "address", address)
		serverErrors <- server.ListenAndServe()
	}()

	select {
	case signal := <-shutdownSignals:
		logger.Info("gateway shutdown requested", "signal", signal.String())
		context, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(context); err != nil {
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

func healthHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", healthResponse("healthy"))
	mux.HandleFunc("GET /readyz", healthResponse("ready"))
	return securityHeaders(mux)
}

func healthResponse(status string) http.HandlerFunc {
	return func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json; charset=utf-8")
		writer.Header().Set("Cache-Control", "no-store")
		if err := json.NewEncoder(writer).Encode(map[string]string{
			"component": "vodoge-gateway",
			"mode":      "foundation",
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
