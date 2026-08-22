package notify

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/smtp"
	"net/url"
	"strings"
	"time"
)

// httpClient is shared by every HTTP-shaped channel.
//
// A short timeout on purpose: a notification that has not gone out in ten
// seconds is not going out, and a channel that hangs must not hold up the
// others behind it.
var httpClient = &http.Client{Timeout: 10 * time.Second}

// ── Webhook ──────────────────────────────────────────────────────────────

// Webhook posts the event as JSON to one or more URLs.
type Webhook struct{}

func (Webhook) Name() string { return "webhook" }

func (Webhook) Configured(config map[string]any) bool {
	return asBool(config, "enabled") && len(asStrings(config, "urls")) > 0
}

func (channel Webhook) Send(ctx context.Context, config map[string]any, event Event) error {
	if !channel.Configured(config) {
		return ErrNotConfigured
	}
	payload, err := json.Marshal(map[string]any{
		"kind":  string(event.Kind),
		"title": event.Title,
		"body":  event.Body,
		"at":    event.At.UTC().Format(time.RFC3339),
	})
	if err != nil {
		return err
	}
	secret := asString(config, "secret")

	var failures []string
	for _, endpoint := range asStrings(config, "urls") {
		request, err := http.NewRequestWithContext(
			ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", endpoint, err))
			continue
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("User-Agent", "vodoge-cloud")
		if secret != "" {
			// Signed so the receiver can tell a real notification from anyone
			// who learned the URL. Over the body, not a timestamp header, so a
			// replay of a captured request is still recognisably the same
			// event rather than a new one.
			mac := hmac.New(sha256.New, []byte(secret))
			mac.Write(payload)
			request.Header.Set("X-VoDoge-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
		}
		response, err := httpClient.Do(request)
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", endpoint, err))
			continue
		}
		_ = response.Body.Close()
		if response.StatusCode >= 300 {
			failures = append(failures,
				fmt.Sprintf("%s: HTTP %d", endpoint, response.StatusCode))
		}
	}
	if len(failures) > 0 {
		return fmt.Errorf("webhook: %s", strings.Join(failures, "; "))
	}
	return nil
}

// ── Bark ─────────────────────────────────────────────────────────────────

// Bark pushes to the iOS app of the same name.
type Bark struct{}

func (Bark) Name() string { return "bark" }

func (Bark) Configured(config map[string]any) bool {
	return asBool(config, "enabled") && len(asStrings(config, "urls")) > 0
}

func (channel Bark) Send(ctx context.Context, config map[string]any, event Event) error {
	if !channel.Configured(config) {
		return ErrNotConfigured
	}
	var failures []string
	for _, base := range asStrings(config, "urls") {
		// Bark takes title and body as path segments, so both have to be
		// escaped — a message containing a slash would otherwise change the
		// URL's shape.
		endpoint := strings.TrimRight(base, "/") + "/" +
			url.PathEscape(event.Title) + "/" + url.PathEscape(event.Body)
		query := url.Values{}
		if group := asString(config, "group"); group != "" {
			query.Set("group", group)
		}
		if level := asString(config, "level"); level != "" {
			query.Set("level", level)
		}
		if len(query) > 0 {
			endpoint += "?" + query.Encode()
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			failures = append(failures, err.Error())
			continue
		}
		response, err := httpClient.Do(request)
		if err != nil {
			failures = append(failures, err.Error())
			continue
		}
		_ = response.Body.Close()
		if response.StatusCode >= 300 {
			failures = append(failures, fmt.Sprintf("HTTP %d", response.StatusCode))
		}
	}
	if len(failures) > 0 {
		return fmt.Errorf("bark: %s", strings.Join(failures, "; "))
	}
	return nil
}

// ── Email ────────────────────────────────────────────────────────────────

// Email sends through the tenant's own SMTP server.
type Email struct{}

func (Email) Name() string { return "email" }

func (Email) Configured(config map[string]any) bool {
	return asBool(config, "enabled") &&
		asString(config, "smtp_host") != "" &&
		asInt(config, "smtp_port") > 0 &&
		len(asStrings(config, "to_addresses")) > 0
}

func (channel Email) Send(ctx context.Context, config map[string]any, event Event) error {
	if !channel.Configured(config) {
		return ErrNotConfigured
	}
	host := asString(config, "smtp_host")
	port := asInt(config, "smtp_port")
	from := asString(config, "from_address")
	if from == "" {
		from = asString(config, "username")
	}
	to := asStrings(config, "to_addresses")

	// Header injection: a subject carrying a newline could append arbitrary
	// headers, including extra recipients. The title comes from an event this
	// process built, but that is a property of today's code rather than of
	// this function, so it is enforced here.
	subject := strings.NewReplacer("\r", " ", "\n", " ").Replace(event.Title)
	message := fmt.Sprintf(
		"From: %s\r\nTo: %s\r\nSubject: %s\r\nDate: %s\r\nMIME-Version: 1.0\r\n"+
			"Content-Type: text/plain; charset=UTF-8\r\n\r\n%s\r\n",
		from, strings.Join(to, ", "), subject,
		event.At.UTC().Format(time.RFC1123Z), event.Body)

	address := net.JoinHostPort(host, fmt.Sprint(port))
	var auth smtp.Auth
	if user := asString(config, "username"); user != "" {
		auth = smtp.PlainAuth("", user, asString(config, "password"), host)
	}

	// net/smtp has no context support, so the deadline is honoured by running
	// the send on its own goroutine and abandoning the result. The connection
	// is left to the client's own timeouts rather than leaking indefinitely.
	done := make(chan error, 1)
	go func() {
		done <- smtp.SendMail(address, auth, from, to, []byte(message))
	}()
	select {
	case err := <-done:
		if err != nil {
			return fmt.Errorf("email: %w", err)
		}
		return nil
	case <-ctx.Done():
		return fmt.Errorf("email: %w", ctx.Err())
	}
}

// Registry is every channel this build knows how to deliver through.
func Registry() []Channel {
	return []Channel{Webhook{}, Bark{}, Email{}}
}
