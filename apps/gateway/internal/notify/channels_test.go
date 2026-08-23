package notify

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/settings"
)

// The check this whole card exists for.
//
// A settings slot with no sender behind it is the worst kind of broken: the
// console accepts the configuration, the save succeeds, no error appears
// anywhere, and nothing is ever delivered. telegram and pushplus were in that
// state — slots and redaction rules on one side, three senders on the other —
// and it survived review because seeing it means holding two files open at
// once. A person will not do that again next time. This will.
func TestEveryConfigurableChannelHasASender(t *testing.T) {
	t.Parallel()

	configurable := settings.NotificationChannels()
	var implemented []string
	for _, channel := range Registry() {
		implemented = append(implemented, channel.Name())
	}

	slices.Sort(configurable)
	slices.Sort(implemented)
	if !slices.Equal(configurable, implemented) {
		t.Fatalf(
			"the notifications section and the sender registry have drifted\n"+
				"  configurable: %v\n"+
				"  implemented:  %v\n"+
				"  configurable with no sender: %v\n"+
				"  senders with no settings slot: %v",
			configurable, implemented,
			missing(configurable, implemented), missing(implemented, configurable))
	}
}

// A redaction rule for a channel nobody can configure is the same drift seen
// from the other end: the credential is hidden on read, and there is no form
// that could ever have set it.
func TestEverySecretBelongsToAChannelThatExists(t *testing.T) {
	t.Parallel()

	channels := settings.NotificationChannels()
	for _, path := range settings.SecretPaths(settings.SectionNotifications) {
		channel, _, ok := strings.Cut(path, ".")
		if !ok {
			t.Fatalf("secret path %q is not <channel>.<field>", path)
		}
		if !slices.Contains(channels, channel) {
			t.Fatalf("secret %q belongs to %q, which is not a configurable channel",
				path, channel)
		}
	}
}

// A sender must not claim to be ready without what it needs to send. The
// dispatcher skips unconfigured channels silently, so a Configured that is too
// generous turns into deliveries that fail forever in the retry window.
func TestAChannelIsNotReadyWithoutItsCredentials(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		channel Channel
		config  map[string]any
		want    bool
	}{
		{"telegram with both", Telegram{},
			map[string]any{"enabled": true, "bot_token": "t", "chat_id": "1"}, true},
		{"telegram with no token", Telegram{},
			map[string]any{"enabled": true, "chat_id": "1"}, false},
		{"telegram with no chat", Telegram{},
			map[string]any{"enabled": true, "bot_token": "t"}, false},
		{"telegram switched off", Telegram{},
			map[string]any{"bot_token": "t", "chat_id": "1"}, false},
		{"feishu with a url", Feishu{},
			map[string]any{"enabled": true, "webhook_url": "https://x/y"}, true},
		{"feishu with none", Feishu{}, map[string]any{"enabled": true}, false},
		{"wecom with a url", WeCom{},
			map[string]any{"enabled": true, "webhook_url": "https://x/y"}, true},
		{"wecom with none", WeCom{}, map[string]any{"enabled": true}, false},
		{"pushplus with a token", Pushplus{},
			map[string]any{"enabled": true, "token": "t"}, true},
		{"pushplus with none", Pushplus{}, map[string]any{"enabled": true}, false},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			if got := testCase.channel.Configured(testCase.config); got != testCase.want {
				t.Fatalf("Configured = %v, want %v", got, testCase.want)
			}
		})
	}
}

// ── Telegram ─────────────────────────────────────────────────────────────

func TestTelegramSendsThroughTheBotAPI(t *testing.T) {
	t.Parallel()

	var gotPath string
	var gotBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &gotBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"result":{"message_id":7}}`))
	}))
	defer server.Close()

	err := Telegram{}.Send(context.Background(), map[string]any{
		"enabled": true, "bot_token": "1234:AAE-secret", "chat_id": "-100777",
		"api_base": server.URL,
	}, Event{Kind: KindSmsReceived, Title: "新短信", Body: "来自 10086", At: time.Unix(0, 0)})
	if err != nil {
		t.Fatal(err)
	}

	if gotPath != "/bot1234:AAE-secret/sendMessage" {
		t.Fatalf("path = %q, want the token and method in it", gotPath)
	}
	if gotBody["chat_id"] != "-100777" {
		t.Fatalf("chat_id = %v", gotBody["chat_id"])
	}
	if text, _ := gotBody["text"].(string); !strings.Contains(text, "新短信") ||
		!strings.Contains(text, "来自 10086") {
		t.Fatalf("text = %q, want the title and body", gotBody["text"])
	}
}

// Telegram answers 200 to some refusals and puts the reason in the body, so
// "ok": false has to be read as a failure — otherwise a bot that was blocked
// or a chat id with a typo looks like a delivery forever.
func TestTelegramTreatsNotOKAsFailure(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":false,"description":"Bad Request: chat not found"}`))
	}))
	defer server.Close()

	err := Telegram{}.Send(context.Background(), map[string]any{
		"enabled": true, "bot_token": "t", "chat_id": "1", "api_base": server.URL,
	}, Event{Kind: KindTest, Title: "x"})
	if err == nil || !strings.Contains(err.Error(), "chat not found") {
		t.Fatalf("err = %v, want the API's own explanation", err)
	}
}

// The bot token is a path segment, so net/http quotes the whole URL back in
// transport errors — and those errors are logged on every failed attempt and
// shown verbatim by the test button.
func TestTelegramKeepsTheBotTokenOutOfItsErrors(t *testing.T) {
	t.Parallel()

	// A server that is closed before the send, so the failure comes from the
	// transport rather than from the API.
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	base := server.URL
	server.Close()

	const token = "1234:AAE-super-secret"
	err := Telegram{}.Send(context.Background(), map[string]any{
		"enabled": true, "bot_token": token, "chat_id": "1", "api_base": base,
	}, Event{Kind: KindTest, Title: "x"})
	if err == nil {
		t.Fatal("expected the send to fail")
	}
	if strings.Contains(err.Error(), token) {
		t.Fatalf("err = %v, want the token redacted", err)
	}
	if !strings.Contains(err.Error(), "[redacted]") {
		t.Fatalf("err = %v, want it to say something was removed", err)
	}
}

// ── 飞书 ─────────────────────────────────────────────────────────────────

func TestFeishuSignsTheRequestWhenASecretIsSet(t *testing.T) {
	t.Parallel()

	var gotBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &gotBody)
		_, _ = w.Write([]byte(`{"code":0,"msg":"success"}`))
	}))
	defer server.Close()

	err := Feishu{}.Send(context.Background(), map[string]any{
		"enabled": true, "webhook_url": server.URL, "secret": "sign-me",
	}, Event{Kind: KindTest, Title: "标题", Body: "正文", At: time.Unix(0, 0)})
	if err != nil {
		t.Fatal(err)
	}

	if gotBody["msg_type"] != "text" {
		t.Fatalf("msg_type = %v", gotBody["msg_type"])
	}
	content, _ := gotBody["content"].(map[string]any)
	if text, _ := content["text"].(string); !strings.Contains(text, "标题") {
		t.Fatalf("text = %q, want the title", text)
	}

	// Feishu keys the HMAC with "<timestamp>\n<secret>" and signs an empty
	// message, which is unusual enough to be worth pinning.
	timestamp, _ := gotBody["timestamp"].(string)
	if timestamp == "" {
		t.Fatal("a signed request must carry the timestamp it was signed with")
	}
	mac := hmac.New(sha256.New, []byte(timestamp+"\n"+"sign-me"))
	want := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if got, _ := gotBody["sign"].(string); got != want {
		t.Fatalf("sign = %q, want %q", got, want)
	}
	// The timestamp is checked against Feishu's clock, so it has to be now and
	// not the event's own time — an event replayed out of the retry window
	// would otherwise be signed into the past.
	if timestamp == "0" {
		t.Fatal("signed with the event's timestamp, not the current one")
	}
}

// Feishu returns 200 with a refusal in the body. Reading only the status code
// would count every rejected message as delivered.
func TestFeishuTreatsATwoHundredWithACodeAsFailure(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"code":19021,"msg":"sign match fail"}`))
	}))
	defer server.Close()

	err := Feishu{}.Send(context.Background(),
		map[string]any{"enabled": true, "webhook_url": server.URL},
		Event{Kind: KindTest, Title: "x"})
	if err == nil || !strings.Contains(err.Error(), "19021") ||
		!strings.Contains(err.Error(), "sign match fail") {
		t.Fatalf("err = %v, want the code and the reason", err)
	}
}

// ── 企业微信 ─────────────────────────────────────────────────────────────

func TestWeComPostsTextToTheRobot(t *testing.T) {
	t.Parallel()

	var gotBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &gotBody)
		_, _ = w.Write([]byte(`{"errcode":0,"errmsg":"ok"}`))
	}))
	defer server.Close()

	err := WeCom{}.Send(context.Background(),
		map[string]any{"enabled": true, "webhook_url": server.URL},
		Event{Kind: KindDeviceOffline, Title: "设备离线", Body: "edge-01", At: time.Unix(0, 0)})
	if err != nil {
		t.Fatal(err)
	}
	if gotBody["msgtype"] != "text" {
		t.Fatalf("msgtype = %v", gotBody["msgtype"])
	}
	text, _ := gotBody["text"].(map[string]any)
	if content, _ := text["content"].(string); !strings.Contains(content, "设备离线") {
		t.Fatalf("content = %q, want the title", content)
	}
}

func TestWeComTreatsATwoHundredWithAnErrcodeAsFailure(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"errcode":93000,"errmsg":"invalid webhook url"}`))
	}))
	defer server.Close()

	err := WeCom{}.Send(context.Background(),
		map[string]any{"enabled": true, "webhook_url": server.URL},
		Event{Kind: KindTest, Title: "x"})
	if err == nil || !strings.Contains(err.Error(), "93000") {
		t.Fatalf("err = %v, want the errcode", err)
	}
}

// WeCom counts bytes, not characters, so a Chinese message runs out of room
// three times sooner. Being refused for length would turn a long notification
// into no notification at all.
func TestAnOversizedWeComMessageIsClippedOnARuneBoundary(t *testing.T) {
	t.Parallel()

	var content string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Text struct {
				Content string `json:"content"`
			} `json:"text"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		content = body.Text.Content
		_, _ = w.Write([]byte(`{"errcode":0,"errmsg":"ok"}`))
	}))
	defer server.Close()

	err := WeCom{}.Send(context.Background(),
		map[string]any{"enabled": true, "webhook_url": server.URL},
		Event{Kind: KindTest, Title: "长", Body: strings.Repeat("案", 4000)})
	if err != nil {
		t.Fatal(err)
	}
	if len(content) > wecomLimit {
		t.Fatalf("content is %d bytes, over the %d limit", len(content), wecomLimit)
	}
	if !utf8.ValidString(content) {
		t.Fatal("the cut landed inside a character")
	}
	if !strings.HasPrefix(content, "长") {
		t.Fatalf("content = %.20q, want the title kept", content)
	}
}

// ── Pushplus ─────────────────────────────────────────────────────────────

func TestPushplusSendsTheTokenInTheBody(t *testing.T) {
	t.Parallel()

	var gotPath string
	var gotBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &gotBody)
		_, _ = w.Write([]byte(`{"code":200,"msg":"请求成功"}`))
	}))
	defer server.Close()

	err := Pushplus{}.Send(context.Background(), map[string]any{
		"enabled": true, "token": "tok", "topic": "ops", "api_base": server.URL,
	}, Event{Kind: KindBackupFailed, Title: "备份失败", Body: "dump 未完成", At: time.Unix(0, 0)})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/send" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotBody["token"] != "tok" || gotBody["topic"] != "ops" {
		t.Fatalf("body = %v, want the token and topic", gotBody)
	}
	if gotBody["template"] != "txt" {
		t.Fatalf("template = %v, want plain text", gotBody["template"])
	}
	if title, _ := gotBody["title"].(string); title != "备份失败" {
		t.Fatalf("title = %q", title)
	}
}

// Pushplus signals failure with a code inside a 200, and its success value is
// 200 as well — so anything unreadable has to count as failure rather than
// falling through as a zero-valued success.
func TestPushplusTreatsATwoHundredWithACodeAsFailure(t *testing.T) {
	t.Parallel()

	for _, body := range []string{`{"code":903,"msg":"token不存在"}`, `not json at all`} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(body))
		}))
		err := Pushplus{}.Send(context.Background(),
			map[string]any{"enabled": true, "token": "tok", "api_base": server.URL},
			Event{Kind: KindTest, Title: "x"})
		server.Close()
		if err == nil {
			t.Fatalf("body %q was accepted as a delivery", body)
		}
	}
}

// An empty topic is not the same request as no topic: it addresses a group
// rather than the token's owner.
func TestPushplusOmitsAnEmptyTopic(t *testing.T) {
	t.Parallel()

	var gotBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &gotBody)
		_, _ = w.Write([]byte(`{"code":200}`))
	}))
	defer server.Close()

	if err := (Pushplus{}).Send(context.Background(),
		map[string]any{"enabled": true, "token": "tok", "api_base": server.URL},
		Event{Kind: KindTest, Title: "x"}); err != nil {
		t.Fatal(err)
	}
	if _, present := gotBody["topic"]; present {
		t.Fatalf("topic = %v, want it absent", gotBody["topic"])
	}
}

// ── The new channels ride the existing dispatcher ────────────────────────

// Nothing about retry, backoff or accounting is per-channel, and none of it was
// re-implemented here. This is the proof: a channel added today gets the six
// minute retry window and the counters that came with the lane rework, because
// it goes through the same dispatcher.
func TestANewChannelInheritsTheRetriesAndTheCounters(t *testing.T) {
	t.Parallel()

	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if attempts.Add(1) == 1 {
			http.Error(w, "upstream is restarting", http.StatusBadGateway)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	metrics := newCountingRecorder()
	dispatcher := New(fixedSettings{
		"telegram": map[string]any{
			"enabled": true, "bot_token": "tok", "chat_id": "42",
			"api_base": server.URL,
		},
	}, Registry(), Options{Backoff: time.Millisecond, Metrics: metrics})
	defer dispatcher.Close()

	dispatcher.Notify(Event{Kind: KindSmsReceived, TenantID: "t", Title: "新短信"})

	waitFor(t, func() bool {
		return metrics.get("vodoge_notifications_total",
			"channel", "telegram", "result", "delivered") == 1
	})
	if got := metrics.get("vodoge_notification_retries_total", "channel", "telegram"); got != 1 {
		t.Fatalf("retries = %d, want the failed attempt counted", got)
	}
	if got := attempts.Load(); got != 2 {
		t.Fatalf("attempts = %d, want the send retried once", got)
	}
}

// The test button's whole path, minus the HTTP handler: settings are read,
// the named channel is found, and the answer comes back synchronously so the
// person who pressed it sees the failure rather than a queued promise.
func TestTheTestButtonReachesANewChannel(t *testing.T) {
	t.Parallel()

	var delivered atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		delivered.Store(true)
		_, _ = w.Write([]byte(`{"code":0,"msg":"success"}`))
	}))
	defer server.Close()

	dispatcher := New(fixedSettings{
		"feishu": map[string]any{"enabled": true, "webhook_url": server.URL},
	}, Registry(), Options{})
	defer dispatcher.Close()

	if err := dispatcher.SendTest(context.Background(), "t", "feishu"); err != nil {
		t.Fatal(err)
	}
	if !delivered.Load() {
		t.Fatal("the test never reached the channel")
	}
	// A channel the tenant has not configured must say so, not fail obscurely.
	if err := dispatcher.SendTest(context.Background(), "t", "wecom"); err == nil {
		t.Fatal("an unconfigured channel should refuse the test")
	}
}

// missing returns the members of a that are not in b.
func missing(a, b []string) []string {
	var out []string
	for _, item := range a {
		if !slices.Contains(b, item) {
			out = append(out, item)
		}
	}
	return out
}
