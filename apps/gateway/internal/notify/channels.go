package notify

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/smtp"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
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

// ── Shared plumbing for the JSON-over-HTTP channels ──────────────────────

// maxResponseBody caps what a channel reads back.
//
// These services answer with a short status object. Anything larger is a
// captive portal, a proxy error page or something hostile, and none of them
// are worth pulling into memory whole.
const maxResponseBody = 8 << 10

// postJSON sends one document and returns the answer.
//
// Every channel below has to read its response body rather than trust the
// status code, so unlike the webhook sender this one keeps the body.
func postJSON(
	ctx context.Context,
	endpoint string,
	payload any,
) (body []byte, status int, err error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, 0, err
	}
	request, err := http.NewRequestWithContext(
		ctx, http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return nil, 0, err
	}
	request.Header.Set("Content-Type", "application/json; charset=utf-8")
	request.Header.Set("User-Agent", "vodoge-cloud")
	response, err := httpClient.Do(request)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = response.Body.Close() }()
	body, err = io.ReadAll(io.LimitReader(response.Body, maxResponseBody))
	if err != nil {
		return nil, response.StatusCode, err
	}
	return body, response.StatusCode, nil
}

// endpointBase lets a test — or a tenant behind a relay — point a channel at
// something other than the vendor's own host. Absent, the real service is used.
func endpointBase(config map[string]any, key, fallback string) string {
	if custom := asString(config, key); custom != "" {
		return strings.TrimRight(custom, "/")
	}
	return fallback
}

// hide keeps a credential out of an error string.
//
// Telegram carries the bot token in the URL path, so net/http quotes it back in
// its own errors: Post "https://api.telegram.org/bot123:AA.../sendMessage":
// dial tcp ... Those errors are logged by the dispatcher and shown by the test
// button, so without this the token ends up in the log of every failed send and
// in any screenshot of the settings page.
func hide(err error, secrets ...string) error {
	if err == nil {
		return nil
	}
	text := err.Error()
	for _, secret := range secrets {
		if secret == "" {
			continue
		}
		text = strings.ReplaceAll(text, secret, "[redacted]")
	}
	return errors.New(text)
}

// clip shortens a message to a service's own limit.
//
// Some of these reject an oversized message outright, which would turn a long
// notification into no notification. The cut lands on a rune boundary because
// half a UTF-8 sequence is not a character, and anything strict would reject
// the truncated text as invalid.
func clip(text string, limitBytes int) string {
	if len(text) <= limitBytes {
		return text
	}
	const ellipsis = "…"
	cut := max(limitBytes-len(ellipsis), 0)
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut] + ellipsis
}

// because renders a service's own explanation, when it gave one.
func because(reason string) string {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return ""
	}
	return ": " + reason
}

// ── Telegram ─────────────────────────────────────────────────────────────

// Telegram sends through a bot to one chat.
//
// The settings page has offered bot_token and chat_id since the section was
// written and nothing ever read either one. A tenant could fill both in, save
// without complaint, see no error anywhere, and never receive a notification —
// which is worse than the fields not existing at all.
type Telegram struct{}

func (Telegram) Name() string { return "telegram" }

func (Telegram) Configured(config map[string]any) bool {
	return asBool(config, "enabled") &&
		asString(config, "bot_token") != "" &&
		asString(config, "chat_id") != ""
}

// telegramLimit is Telegram's own ceiling on a text message.
const telegramLimit = 4096

func (channel Telegram) Send(ctx context.Context, config map[string]any, event Event) error {
	if !channel.Configured(config) {
		return ErrNotConfigured
	}
	token := asString(config, "bot_token")
	endpoint := endpointBase(config, "api_base", "https://api.telegram.org") +
		"/bot" + token + "/sendMessage"

	body, status, err := postJSON(ctx, endpoint, map[string]any{
		"chat_id": asString(config, "chat_id"),
		"text":    clip(Text(event), telegramLimit),
		// A link in a notification is for the reader to follow. Letting
		// Telegram's servers fetch it first would have a third party visiting
		// the tenant's console URLs on every message.
		"link_preview_options": map[string]any{"is_disabled": true},
	})
	if err != nil {
		return fmt.Errorf("telegram: %w", hide(err, token))
	}
	// Telegram is honest with status codes, but the body says why — "chat not
	// found", "bot was blocked by the user" — and those need different fixes.
	var answer struct {
		OK          bool   `json:"ok"`
		Description string `json:"description"`
	}
	_ = json.Unmarshal(body, &answer)
	if status >= 300 || !answer.OK {
		return fmt.Errorf("telegram: HTTP %d%s", status, because(answer.Description))
	}
	return nil
}

// ── 飞书 / Lark ──────────────────────────────────────────────────────────

// Feishu posts to a group chat's custom bot webhook.
type Feishu struct{}

func (Feishu) Name() string { return "feishu" }

func (Feishu) Configured(config map[string]any) bool {
	return asBool(config, "enabled") && asString(config, "webhook_url") != ""
}

func (channel Feishu) Send(ctx context.Context, config map[string]any, event Event) error {
	if !channel.Configured(config) {
		return ErrNotConfigured
	}
	payload := map[string]any{
		"msg_type": "text",
		"content":  map[string]any{"text": Text(event)},
	}
	// Signing is optional on Feishu's side and worth turning on: without it the
	// webhook URL is the only thing between the group and anyone who has ever
	// seen it. The scheme is Feishu's own — an HMAC over an empty message, keyed
	// by "<timestamp>\n<secret>" — and the timestamp has to be close to now, so
	// it comes from the clock rather than from the event, which may have spent
	// minutes in the retry window.
	if secret := asString(config, "secret"); secret != "" {
		timestamp := strconv.FormatInt(time.Now().Unix(), 10)
		mac := hmac.New(sha256.New, []byte(timestamp+"\n"+secret))
		payload["timestamp"] = timestamp
		payload["sign"] = base64.StdEncoding.EncodeToString(mac.Sum(nil))
	}

	body, status, err := postJSON(ctx, asString(config, "webhook_url"), payload)
	if err != nil {
		return fmt.Errorf("feishu: %w", err)
	}
	if status >= 300 {
		return fmt.Errorf("feishu: HTTP %d", status)
	}
	// Feishu answers 200 to a message it refused and puts the refusal in the
	// body: a stale signature, a bot removed from the group, a webhook that was
	// reset. Trusting the status code would report every one of those as
	// delivered — the same shape of lie as a settings slot with no sender.
	var answer struct {
		Code          int    `json:"code"`
		Msg           string `json:"msg"`
		StatusCode    int    `json:"StatusCode"`
		StatusMessage string `json:"StatusMessage"`
	}
	// An answer that is not the documented JSON object did not come from
	// Feishu: a captive portal, a proxy error page, the wrong host entirely.
	// Letting it through as a zero code would report a delivery that never
	// happened, which is the exact failure being removed here.
	if err := json.Unmarshal(body, &answer); err != nil {
		return fmt.Errorf("feishu: unreadable answer: %.120q", body)
	}
	if answer.Code != 0 {
		return fmt.Errorf("feishu: code %d%s", answer.Code, because(answer.Msg))
	}
	if answer.StatusCode != 0 {
		return fmt.Errorf("feishu: code %d%s", answer.StatusCode, because(answer.StatusMessage))
	}
	return nil
}

// ── 企业微信 / WeCom ─────────────────────────────────────────────────────

// WeCom posts to a group robot's webhook.
type WeCom struct{}

func (WeCom) Name() string { return "wecom" }

func (WeCom) Configured(config map[string]any) bool {
	return asBool(config, "enabled") && asString(config, "webhook_url") != ""
}

// wecomLimit is the documented ceiling on a text message, in bytes rather than
// characters — so a Chinese notification runs out of room three times sooner
// than an English one.
const wecomLimit = 2048

func (channel WeCom) Send(ctx context.Context, config map[string]any, event Event) error {
	if !channel.Configured(config) {
		return ErrNotConfigured
	}
	body, status, err := postJSON(ctx, asString(config, "webhook_url"), map[string]any{
		"msgtype": "text",
		"text":    map[string]any{"content": clip(Text(event), wecomLimit)},
	})
	if err != nil {
		return fmt.Errorf("wecom: %w", err)
	}
	if status >= 300 {
		return fmt.Errorf("wecom: HTTP %d", status)
	}
	// Same trap as Feishu: 200 with a non-zero errcode is a rejection.
	var answer struct {
		ErrCode int    `json:"errcode"`
		ErrMsg  string `json:"errmsg"`
	}
	if err := json.Unmarshal(body, &answer); err != nil {
		return fmt.Errorf("wecom: unreadable answer: %.120q", body)
	}
	if answer.ErrCode != 0 {
		return fmt.Errorf("wecom: errcode %d%s", answer.ErrCode, because(answer.ErrMsg))
	}
	return nil
}

// ── Pushplus ─────────────────────────────────────────────────────────────

// Pushplus relays to WeChat through pushplus.plus.
//
// Like Telegram, its token has had a settings slot and a redaction rule since
// the section was written, and no sender behind it.
type Pushplus struct{}

func (Pushplus) Name() string { return "pushplus" }

func (Pushplus) Configured(config map[string]any) bool {
	return asBool(config, "enabled") && asString(config, "token") != ""
}

func (channel Pushplus) Send(ctx context.Context, config map[string]any, event Event) error {
	if !channel.Configured(config) {
		return ErrNotConfigured
	}
	token := asString(config, "token")
	payload := map[string]any{
		"token": token,
		"title": event.Title,
		// "txt" rather than the default HTML template: the body is plain text
		// that may contain an ampersand or a number in angle brackets, and
		// rendering it as markup would silently eat either.
		"template": "txt",
		"content":  Text(event),
	}
	// A topic fans the message out to a group of subscribers. Omitted rather
	// than sent empty, because an empty topic is not the same request.
	if topic := asString(config, "topic"); topic != "" {
		payload["topic"] = topic
	}

	body, status, err := postJSON(ctx,
		endpointBase(config, "api_base", "https://www.pushplus.plus")+"/send", payload)
	if err != nil {
		return fmt.Errorf("pushplus: %w", hide(err, token))
	}
	if status >= 300 {
		return fmt.Errorf("pushplus: HTTP %d", status)
	}
	// 200 in the envelope, the real answer in the body — and here the success
	// value is 200 as well, so an unparseable body reads as failure rather than
	// as success.
	var answer struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	}
	_ = json.Unmarshal(body, &answer)
	if answer.Code != 200 {
		return fmt.Errorf("pushplus: code %d%s", answer.Code, because(answer.Msg))
	}
	return nil
}

// Registry is every channel this build knows how to deliver through.
//
// settings.NotificationChannels() must name exactly these. The two lists are
// held together by TestEveryConfigurableChannelHasASender, because the drift
// between them is invisible from either side alone: the console will happily
// configure a channel nothing delivers.
func Registry() []Channel {
	return []Channel{
		Webhook{}, Bark{}, Email{},
		Telegram{}, Feishu{}, WeCom{}, Pushplus{},
	}
}
