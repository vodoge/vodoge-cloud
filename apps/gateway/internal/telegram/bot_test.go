package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/auth"
)

// ── Fakes ────────────────────────────────────────────────────────────────

type sent struct {
	method string
	body   map[string]any
}

// fakeTelegram records what the bot said and hands back queued updates.
type fakeTelegram struct {
	mu      sync.Mutex
	calls   []sent
	updates [][]Update
	err     error
}

func (fake *fakeTelegram) Call(
	_ context.Context, _ Config, method string, body, out any,
) error {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	document, _ := body.(map[string]any)
	fake.calls = append(fake.calls, sent{method: method, body: document})
	if fake.err != nil {
		return fake.err
	}
	if method == "getUpdates" {
		target, ok := out.(*[]Update)
		if !ok {
			return nil
		}
		if len(fake.updates) == 0 {
			*target = nil
			return nil
		}
		*target = fake.updates[0]
		fake.updates = fake.updates[1:]
	}
	return nil
}

func (fake *fakeTelegram) texts() []string {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	var out []string
	for _, call := range fake.calls {
		if call.method != "sendMessage" {
			continue
		}
		text, _ := call.body["text"].(string)
		out = append(out, text)
	}
	return out
}

func (fake *fakeTelegram) said(fragment string) bool {
	for _, text := range fake.texts() {
		if strings.Contains(text, fragment) {
			return true
		}
	}
	return false
}

// nonce returns the callback data of the last confirmation offered.
func (fake *fakeTelegram) nonce(t *testing.T) string {
	t.Helper()
	fake.mu.Lock()
	defer fake.mu.Unlock()
	for i := len(fake.calls) - 1; i >= 0; i-- {
		markup, ok := fake.calls[i].body["reply_markup"].(map[string]any)
		if !ok {
			continue
		}
		rows, ok := markup["inline_keyboard"].([][]map[string]any)
		if !ok || len(rows) == 0 || len(rows[0]) == 0 {
			continue
		}
		data, _ := rows[0][0]["callback_data"].(string)
		_, nonce, _ := strings.Cut(data, ":")
		return nonce
	}
	t.Fatal("no confirmation was offered")
	return ""
}

type apiCall struct {
	method string
	path   string
	token  string
	body   map[string]any
}

// fakeAPI stands in for the gateway.
type fakeAPI struct {
	mu      sync.Mutex
	calls   []apiCall
	answers map[string]Answer
	err     error
}

func (fake *fakeAPI) Do(
	_ context.Context, method, path, token string, body any,
) (Answer, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	document, _ := body.(map[string]any)
	fake.calls = append(fake.calls, apiCall{method, path, token, document})
	if fake.err != nil {
		return Answer{}, fake.err
	}
	if answer, ok := fake.answers[method+" "+path]; ok {
		return answer, nil
	}
	if answer, ok := fleet[method+" "+path]; ok {
		return answer, nil
	}
	return Answer{Status: http.StatusOK, Body: []byte(`{}`)}, nil
}

// fleet is the bench as the gateway would describe it, so a test that is about
// confirmation does not have to restate it. A sensitive command looks the
// module up before quoting anything, because the API addresses commands to the
// device that carries it and an operator only ever types the IMEI.
var fleet = map[string]Answer{
	"GET /v1/devices": {Status: http.StatusOK, Body: []byte(
		`{"devices":[{"id":"d-1","name":"bench","state":"online"}]}`)},
	"GET /v1/modems": {Status: http.StatusOK, Body: []byte(
		`{"modems":[{"device_id":"d-1","imei":"867018069509705","registration":"registered"},` +
			`{"device_id":"d-1","imei":"867018069514820","registration":"registered"}]}`)},
}

func (fake *fakeAPI) writes() []apiCall {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	var out []apiCall
	for _, call := range fake.calls {
		if call.method != http.MethodGet {
			out = append(out, call)
		}
	}
	return out
}

// fakeMinter resolves an email to a credential without a database.
type fakeMinter struct {
	mu       sync.Mutex
	known    map[string]bool
	disabled map[string]bool
	released int
}

func (fake *fakeMinter) Mint(_ context.Context, email string) (Credential, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.disabled[email] {
		return Credential{}, ErrAccountDisabled
	}
	if !fake.known[email] {
		return Credential{}, ErrUnknownAccount
	}
	return Credential{
		Token:  "tok-" + email,
		UserID: "user-" + email,
		Release: func(context.Context) {
			fake.mu.Lock()
			defer fake.mu.Unlock()
			fake.released++
		},
	}, nil
}

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// testConfig authorises sender 111 as ops@example.com.
func testConfig() Config {
	return Config{
		Enabled:  true,
		Token:    "1234:secret",
		APIBase:  DefaultAPIBase,
		accounts: map[string]string{"111": "ops@example.com"},
	}
}

func newBot(chat *fakeTelegram, api *fakeAPI, minter *fakeMinter) *Bot {
	return &Bot{Telegram: chat, API: api, Accounts: minter, Logger: quiet()}
}

func message(sender int64, text string) Update {
	return Update{
		UpdateID: 1,
		Message: &Message{
			MessageID: 7,
			Text:      text,
			From:      &User{ID: sender},
			Chat:      &Chat{ID: sender, Type: "private"},
		},
	}
}

func press(sender int64, data string) Update {
	return Update{
		UpdateID: 2,
		CallbackQuery: &CallbackQuery{
			ID:   "cb-1",
			Data: data,
			From: &User{ID: sender},
			Message: &Message{
				MessageID: 8,
				Chat:      &Chat{ID: sender, Type: "private"},
			},
		},
	}
}

func operators() *fakeMinter {
	return &fakeMinter{known: map[string]bool{"ops@example.com": true}}
}

// ── Authorisation ────────────────────────────────────────────────────────

// The bot is a second front door. A sender that maps to no console account
// must not reach the API at all -- not read it, not write it.
func TestAnUnmappedSenderReachesNothing(t *testing.T) {
	t.Parallel()
	chat, api := &fakeTelegram{}, &fakeAPI{}
	bot := newBot(chat, api, operators())

	bot.HandleUpdate(context.Background(), testConfig(), message(999, "/status"))

	if len(api.calls) != 0 {
		t.Fatalf("an unauthorised sender reached the gateway: %+v", api.calls)
	}
	if !chat.said("未授权") {
		t.Fatalf("no refusal was sent: %q", chat.texts())
	}
}

// A refusal must not become a way to send somebody messages by pointing the
// bot at them.
func TestAnUnmappedSenderIsOnlyToldOnce(t *testing.T) {
	t.Parallel()
	chat := &fakeTelegram{}
	bot := newBot(chat, &fakeAPI{}, operators())
	now := time.Now()
	bot.Now = func() time.Time { return now }

	for range 5 {
		bot.HandleUpdate(context.Background(), testConfig(), message(999, "/status"))
	}
	if got := len(chat.texts()); got != 1 {
		t.Fatalf("sent %d refusals to one stranger, want 1", got)
	}

	now = now.Add(2 * scoldInterval)
	bot.HandleUpdate(context.Background(), testConfig(), message(999, "/status"))
	if got := len(chat.texts()); got != 2 {
		t.Fatalf("after the quiet period there were %d refusals, want 2", got)
	}
}

// The bot holds no identity of its own: every call it makes carries the
// credential of the account the chat is mapped to.
func TestCallsCarryTheMappedAccountsCredential(t *testing.T) {
	t.Parallel()
	chat, api, minter := &fakeTelegram{}, &fakeAPI{}, operators()
	bot := newBot(chat, api, minter)

	bot.HandleUpdate(context.Background(), testConfig(), message(111, "/status"))

	if len(api.calls) == 0 {
		t.Fatal("an authorised sender reached nothing")
	}
	for _, call := range api.calls {
		if call.token != "tok-ops@example.com" {
			t.Fatalf("%s %s carried token %q, want the mapped account's",
				call.method, call.path, call.token)
		}
	}
	// A session left behind is a credential nobody is holding.
	if minter.released == 0 {
		t.Fatal("the minted session was never released")
	}
}

// A mapping that names a disabled account is not a way back in.
func TestADisabledAccountCannotAct(t *testing.T) {
	t.Parallel()
	chat, api := &fakeTelegram{}, &fakeAPI{}
	minter := operators()
	minter.disabled = map[string]bool{"ops@example.com": true}
	bot := newBot(chat, api, minter)

	bot.HandleUpdate(context.Background(), testConfig(), message(111, "/status"))

	if len(api.calls) != 0 {
		t.Fatalf("a disabled account reached the gateway: %+v", api.calls)
	}
	if !chat.said("已停用") {
		t.Fatalf("the operator was not told why: %q", chat.texts())
	}
}

// ── Confirmation ─────────────────────────────────────────────────────────

// The whole point of the second step: asking must not do anything.
func TestASensitiveCommandDoesNothingUntilConfirmed(t *testing.T) {
	t.Parallel()
	for _, command := range []string{
		"/sms 867018069509705 10086 CXYE",
		"/switch 867018069509705 8986011234567890123",
		"/reset 867018069509705",
	} {
		chat, api := &fakeTelegram{}, &fakeAPI{}
		bot := newBot(chat, api, operators())

		bot.HandleUpdate(context.Background(), testConfig(), message(111, command))

		if writes := api.writes(); len(writes) != 0 {
			t.Fatalf("%q performed %+v before any confirmation", command, writes)
		}
		if bot.Pending() != 1 {
			t.Fatalf("%q left %d confirmations outstanding, want 1",
				command, bot.Pending())
		}
		if chat.nonce(t) == "" {
			t.Fatalf("%q offered no button", command)
		}
	}
}

// And confirming must do exactly the thing that was quoted.
func TestConfirmingPerformsTheQuotedAction(t *testing.T) {
	t.Parallel()
	chat, api := &fakeTelegram{}, &fakeAPI{}
	api.answers = map[string]Answer{
		"POST /v1/commands": {
			Status: http.StatusOK,
			Body:   []byte(`{"id":"c-1","status":"queued"}`),
		},
	}
	bot := newBot(chat, api, operators())

	bot.HandleUpdate(context.Background(), testConfig(),
		message(111, "/sms 867018069509705 10086 CXYE"))
	bot.HandleUpdate(context.Background(), testConfig(),
		press(111, "ok:"+chat.nonce(t)))

	writes := api.writes()
	if len(writes) != 1 {
		t.Fatalf("performed %d writes, want 1: %+v", len(writes), writes)
	}
	if writes[0].method != http.MethodPost || writes[0].path != "/v1/commands" {
		t.Fatalf("wrote %s %s", writes[0].method, writes[0].path)
	}
	want := map[string]any{
		"kind": "send_sms", "modem_imei": "867018069509705",
		"to": "10086", "body": "CXYE",
	}
	for key, value := range want {
		if writes[0].body[key] != value {
			t.Errorf("body[%q] = %v, want %v", key, writes[0].body[key], value)
		}
	}
	if !chat.said("c-1") {
		t.Errorf("the command id was not reported back: %q", chat.texts())
	}
}

// A confirmation is single use, or a stale chat becomes a replay button.
func TestAConfirmationCanOnlyBeSpentOnce(t *testing.T) {
	t.Parallel()
	chat, api := &fakeTelegram{}, &fakeAPI{}
	bot := newBot(chat, api, operators())

	bot.HandleUpdate(context.Background(), testConfig(),
		message(111, "/reset 867018069509705"))
	nonce := chat.nonce(t)
	bot.HandleUpdate(context.Background(), testConfig(), press(111, "ok:"+nonce))
	bot.HandleUpdate(context.Background(), testConfig(), press(111, "ok:"+nonce))

	if writes := api.writes(); len(writes) != 1 {
		t.Fatalf("performed %d writes for one confirmation, want 1", len(writes))
	}
	if !chat.said("已经用过") {
		t.Errorf("the second press was not explained: %q", chat.texts())
	}
}

// A button that belongs to somebody else is not yours, even in a group where
// both of you can see it.
func TestAnotherSenderCannotSpendAConfirmation(t *testing.T) {
	t.Parallel()
	chat, api := &fakeTelegram{}, &fakeAPI{}
	config := testConfig()
	config.accounts["222"] = "ops@example.com"
	bot := newBot(chat, api, operators())

	bot.HandleUpdate(context.Background(), config, message(111, "/reset 867018069509705"))
	bot.HandleUpdate(context.Background(), config, press(222, "ok:"+chat.nonce(t)))

	if writes := api.writes(); len(writes) != 0 {
		t.Fatalf("another sender performed %+v", writes)
	}
	if bot.Pending() != 1 {
		t.Fatal("the confirmation was consumed by the wrong sender")
	}
}

func TestAnExpiredConfirmationIsRefused(t *testing.T) {
	t.Parallel()
	chat, api := &fakeTelegram{}, &fakeAPI{}
	bot := newBot(chat, api, operators())
	now := time.Now()
	bot.Now = func() time.Time { return now }

	bot.HandleUpdate(context.Background(), testConfig(),
		message(111, "/reset 867018069509705"))
	nonce := chat.nonce(t)
	now = now.Add(ConfirmationTTL + time.Second)
	bot.HandleUpdate(context.Background(), testConfig(), press(111, "ok:"+nonce))

	if writes := api.writes(); len(writes) != 0 {
		t.Fatalf("an expired confirmation performed %+v", writes)
	}
}

func TestCancellingPerformsNothing(t *testing.T) {
	t.Parallel()
	chat, api := &fakeTelegram{}, &fakeAPI{}
	bot := newBot(chat, api, operators())

	bot.HandleUpdate(context.Background(), testConfig(),
		message(111, "/sms 867018069509705 10086 hello"))
	bot.HandleUpdate(context.Background(), testConfig(), press(111, "no:"+chat.nonce(t)))

	if writes := api.writes(); len(writes) != 0 {
		t.Fatalf("a cancelled action performed %+v", writes)
	}
	if bot.Pending() != 0 {
		t.Fatal("a cancelled confirmation is still outstanding")
	}
	var edited bool
	for _, call := range chat.calls {
		if call.method == "editMessageReplyMarkup" {
			edited = true
		}
	}
	if !edited {
		t.Error("the keyboard was left on the answered prompt")
	}
}

// /cancel is the way out for somebody who typed the wrong thing and does not
// want to go hunting for the button.
func TestCancelDropsEveryOutstandingConfirmation(t *testing.T) {
	t.Parallel()
	chat, api := &fakeTelegram{}, &fakeAPI{}
	bot := newBot(chat, api, operators())

	bot.HandleUpdate(context.Background(), testConfig(), message(111, "/reset 867018069509705"))
	bot.HandleUpdate(context.Background(), testConfig(), message(111, "/reset 867018069514820"))
	bot.HandleUpdate(context.Background(), testConfig(), message(111, "/cancel"))

	if bot.Pending() != 0 {
		t.Fatalf("%d confirmations survived /cancel", bot.Pending())
	}
	if len(api.writes()) != 0 {
		t.Fatal("cancelling performed something")
	}
}

// Authorisation is re-checked when the button is pressed rather than trusted
// from when it was drawn.
func TestAnOperatorRemovedBeforePressingCannotExecute(t *testing.T) {
	t.Parallel()
	chat, api := &fakeTelegram{}, &fakeAPI{}
	bot := newBot(chat, api, operators())

	bot.HandleUpdate(context.Background(), testConfig(),
		message(111, "/reset 867018069509705"))
	nonce := chat.nonce(t)

	revoked := testConfig()
	delete(revoked.accounts, "111")
	bot.HandleUpdate(context.Background(), revoked, press(111, "ok:"+nonce))

	if writes := api.writes(); len(writes) != 0 {
		t.Fatalf("a revoked operator performed %+v", writes)
	}
}

// ── Parsing and rendering ────────────────────────────────────────────────

// A request the gateway would refuse is refused while the operator is still
// typing, and never becomes a confirmation prompt.
func TestMalformedSensitiveCommandsNeverReachConfirmation(t *testing.T) {
	t.Parallel()
	for _, command := range []string{
		"/sms",
		"/sms 12345 10086 hi",
		"/sms 867018069509705 not-a-number hi",
		"/sms 867018069509705 10086",
		"/switch 867018069509705",
		"/switch 867018069509705 123",
		"/reset",
		"/reset 12345",
	} {
		chat, api := &fakeTelegram{}, &fakeAPI{}
		bot := newBot(chat, api, operators())
		bot.HandleUpdate(context.Background(), testConfig(), message(111, command))

		if bot.Pending() != 0 {
			t.Errorf("%q produced a confirmation prompt", command)
		}
		if len(api.calls) != 0 {
			t.Errorf("%q reached the gateway: %+v", command, api.calls)
		}
		if !chat.said("用法") && !chat.said("不合法") && !chat.said("不能为空") {
			t.Errorf("%q was refused without saying how to fix it: %q",
				command, chat.texts())
		}
	}
}

// Telegram appends @botname to commands sent in a group.
func TestTheBotnameSuffixIsTolerated(t *testing.T) {
	t.Parallel()
	chat, api := &fakeTelegram{}, &fakeAPI{}
	bot := newBot(chat, api, operators())

	bot.HandleUpdate(context.Background(), testConfig(),
		message(111, "/status@vodoge_bot"))

	if len(api.calls) == 0 {
		t.Fatal("a suffixed command was not recognised")
	}
}

func TestStatusReportsWhatTheFleetLooksLike(t *testing.T) {
	t.Parallel()
	chat, api := &fakeTelegram{}, &fakeAPI{}
	api.answers = map[string]Answer{
		"GET /v1/devices": {Status: http.StatusOK, Body: []byte(
			`{"devices":[{"id":"d-1","name":"bench","state":"online","public_ip":"1.2.3.4"}]}`)},
		"GET /v1/modems": {Status: http.StatusOK, Body: []byte(
			`{"modems":[{"device_id":"d-1","imei":"867018069509705",` +
				`"iccid":"8986061234567890123","registration":"registered",` +
				`"signal_dbm":-69,"serving_plmn":"460-00"}]}`)},
	}
	bot := newBot(chat, api, operators())

	bot.HandleUpdate(context.Background(), testConfig(), message(111, "/status"))

	for _, fragment := range []string{
		"bench", "online", "1.2.3.4", "867018069509705", "registered", "460-00",
	} {
		if !chat.said(fragment) {
			t.Errorf("status did not mention %q: %q", fragment, chat.texts())
		}
	}
}

// A read that the gateway refuses is reported as a refusal, not as an empty
// fleet -- "no devices" and "you may not see the devices" are different facts.
func TestARefusedReadIsNotRenderedAsAnEmptyFleet(t *testing.T) {
	t.Parallel()
	chat, api := &fakeTelegram{}, &fakeAPI{}
	api.answers = map[string]Answer{
		"GET /v1/devices": {Status: http.StatusForbidden, Body: []byte("nope")},
		"GET /v1/modems":  {Status: http.StatusOK, Body: []byte(`{"modems":[]}`)},
	}
	bot := newBot(chat, api, operators())

	bot.HandleUpdate(context.Background(), testConfig(), message(111, "/status"))

	if chat.said("还没有设备上报") {
		t.Fatalf("a refusal was rendered as an empty fleet: %q", chat.texts())
	}
	if !chat.said("403") {
		t.Fatalf("the refusal was not reported: %q", chat.texts())
	}
}

// The gateway refusing a write is the read-only guard doing its job, and the
// operator has to be able to tell that apart from a broken bot.
func TestAGatewayRefusalIsReportedAsARefusal(t *testing.T) {
	t.Parallel()
	chat, api := &fakeTelegram{}, &fakeAPI{}
	api.answers = map[string]Answer{
		"POST /v1/commands": {
			Status: http.StatusForbidden,
			Body:   []byte("this account is read-only\n"),
		},
	}
	bot := newBot(chat, api, operators())

	bot.HandleUpdate(context.Background(), testConfig(),
		message(111, "/reset 867018069509705"))
	bot.HandleUpdate(context.Background(), testConfig(), press(111, "ok:"+chat.nonce(t)))

	if !chat.said("被拒绝") || !chat.said("read-only") {
		t.Fatalf("a 403 was not reported as a refusal: %q", chat.texts())
	}
}

func TestAnUnknownCommandGetsHelp(t *testing.T) {
	t.Parallel()
	chat, api := &fakeTelegram{}, &fakeAPI{}
	bot := newBot(chat, api, operators())

	bot.HandleUpdate(context.Background(), testConfig(), message(111, "第一条消息"))

	if !chat.said("/status") {
		t.Fatalf("no help was offered: %q", chat.texts())
	}
	if len(api.calls) != 0 {
		t.Fatalf("chatter reached the gateway: %+v", api.calls)
	}
}

// ── Configuration ────────────────────────────────────────────────────────

func TestReadConfigAuthorisesTheMappedChats(t *testing.T) {
	t.Parallel()
	config := ReadConfig(decode(t, `{"telegram":{"bot_token":"1234:AAE","bot":{
		"enabled":true,"operators":["111=Ops@Example.com"," 222 = two@example.com "]}}}`))

	if !config.Enabled {
		t.Fatal("a complete configuration did not enable the bot")
	}
	email, ok := config.Account(111)
	if !ok || email != "ops@example.com" {
		t.Fatalf("sender 111 resolved to %q (%v), want the lowercased address", email, ok)
	}
	if _, ok := config.Account(333); ok {
		t.Fatal("an unmapped sender resolved to an account")
	}
}

// Fails closed: one unusable line must not leave the rest of the table live,
// because the line nobody could parse is the line nobody has looked at.
func TestAMalformedOperatorListAuthorisesNobody(t *testing.T) {
	t.Parallel()
	config := ReadConfig(decode(t, `{"telegram":{"bot_token":"1234:AAE","bot":{
		"enabled":true,"operators":["111=ops@example.com","garbage"]}}}`))

	if config.Enabled {
		t.Fatal("a malformed operator list left the bot enabled")
	}
	if _, ok := config.Account(111); ok {
		t.Fatal("the entry that happened to parse was still honoured")
	}
}

func TestTheBotStaysOffWithoutTokenOrOperators(t *testing.T) {
	t.Parallel()
	for name, document := range map[string]string{
		"no token":     `{"telegram":{"bot":{"enabled":true,"operators":["1=a@b"]}}}`,
		"no operators": `{"telegram":{"bot_token":"1234:AAE","bot":{"enabled":true}}}`,
		"not enabled":  `{"telegram":{"bot_token":"1234:AAE","bot":{"operators":["1=a@b"]}}}`,
		"no bot block": `{"telegram":{"bot_token":"1234:AAE","chat_id":"1"}}`,
		"nothing":      `{}`,
	} {
		if ReadConfig(decode(t, document)).Enabled {
			t.Errorf("%s: the bot enabled itself", name)
		}
	}
}

func decode(t *testing.T, raw string) map[string]any {
	t.Helper()
	var document map[string]any
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	return document
}

// ── Transport ────────────────────────────────────────────────────────────

// The token is a path segment, so net/http quotes it into its own errors. Those
// errors are logged, and a log is not a place for a credential.
func TestTheBotTokenIsNotInAnError(t *testing.T) {
	t.Parallel()
	const token = "8817774003:AA-super-secret-value"
	// A port nothing listens on, so the failure is net/http's own.
	config := Config{Token: token, APIBase: "http://127.0.0.1:1"}
	err := HTTPTransport{Client: &http.Client{Timeout: 2 * time.Second}}.
		Call(context.Background(), config, "getMe", map[string]any{}, nil)
	if err == nil {
		t.Fatal("expected a transport failure")
	}
	if strings.Contains(err.Error(), token) {
		t.Fatalf("the bot token is in the error text")
	}
	if !strings.Contains(err.Error(), "[redacted]") {
		t.Fatalf("the token was neither present nor redacted: %v", err)
	}
}

// Telegram answers 200 with ok:false for application errors, so the status
// code alone is not the answer.
func TestATelegramApplicationErrorIsAnError(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(
		func(writer http.ResponseWriter, _ *http.Request) {
			_, _ = writer.Write([]byte(`{"ok":false,"description":"chat not found"}`))
		}))
	defer server.Close()

	err := HTTPTransport{}.Call(context.Background(),
		Config{Token: "x", APIBase: server.URL}, "sendMessage", map[string]any{}, nil)
	if err == nil || !strings.Contains(err.Error(), "chat not found") {
		t.Fatalf("error = %v, want the service's own explanation", err)
	}
}

// ── The loopback and the poll loop ───────────────────────────────────────

// The bot must not be able to reach a handler by a route that skips the
// middleware a browser goes through.
func TestLoopbackGoesThroughTheWrappedHandler(t *testing.T) {
	t.Parallel()
	var sawGuard bool
	guarded := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		sawGuard = true
		if request.Host != "a.vodoge.com" {
			t.Errorf("host = %q", request.Host)
		}
		if request.Header.Get("Authorization") != "Bearer tok" {
			t.Errorf("authorization = %q", request.Header.Get("Authorization"))
		}
		writer.WriteHeader(http.StatusForbidden)
		_, _ = writer.Write([]byte("this account is read-only"))
	})

	answer, err := Loopback{Handler: guarded, Host: "a.vodoge.com"}.
		Do(context.Background(), http.MethodPost, "/v1/commands", "tok",
			map[string]any{"kind": "reset_modem_usb"})
	if err != nil {
		t.Fatalf("loopback: %v", err)
	}
	if !sawGuard {
		t.Fatal("the request did not reach the handler")
	}
	if answer.Status != http.StatusForbidden || answer.OK() {
		t.Fatalf("status = %d", answer.Status)
	}
	if !strings.Contains(string(answer.Body), "read-only") {
		t.Fatalf("body = %q", answer.Body)
	}
}

// The offset has to advance past an update whatever handling it did, or a
// message the handler cannot cope with is redelivered forever.
func TestThePollLoopAdvancesPastEveryUpdate(t *testing.T) {
	t.Parallel()
	chat := &fakeTelegram{updates: [][]Update{{
		{UpdateID: 41, Message: &Message{Text: "/status",
			From: &User{ID: 999}, Chat: &Chat{ID: 999}}},
	}}}
	api := &fakeAPI{err: errors.New("gateway is down")}
	bot := newBot(chat, api, operators())

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		bot.Run(ctx, func(context.Context) (Config, error) { return testConfig(), nil })
	}()

	deadline := time.After(5 * time.Second)
	for {
		chat.mu.Lock()
		polls := 0
		var second sent
		for _, call := range chat.calls {
			if call.method == "getUpdates" {
				polls++
				if polls == 2 {
					second = call
				}
			}
		}
		chat.mu.Unlock()
		if polls >= 2 {
			cancel()
			<-done
			if got := second.body["offset"]; got != int64(42) {
				t.Fatalf("second poll offset = %v, want 42", got)
			}
			return
		}
		select {
		case <-deadline:
			cancel()
			<-done
			t.Fatal("the poll loop did not make a second request")
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// A bot nobody configured must not talk to Telegram at all.
func TestAnUnconfiguredBotDoesNotPoll(t *testing.T) {
	t.Parallel()
	chat := &fakeTelegram{}
	bot := newBot(chat, &fakeAPI{}, operators())

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	bot.Run(ctx, func(context.Context) (Config, error) { return Config{}, nil })

	if len(chat.calls) != 0 {
		t.Fatalf("an unconfigured bot called %+v", chat.calls)
	}
}

// ── Minting ──────────────────────────────────────────────────────────────

type memoryAccounts struct {
	mu       sync.Mutex
	users    map[string]auth.User
	sessions map[string]auth.Session
}

func (store *memoryAccounts) User(_ context.Context, _, email string) (auth.User, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	user, ok := store.users[email]
	return user, ok, nil
}

func (store *memoryAccounts) Session(
	_ context.Context, fingerprint []byte,
) (auth.Session, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	session, ok := store.sessions[string(fingerprint)]
	return session, ok, nil
}

func (store *memoryAccounts) CreateSession(
	_ context.Context, fingerprint []byte, session auth.Session,
) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.sessions == nil {
		store.sessions = map[string]auth.Session{}
	}
	store.sessions[string(fingerprint)] = session
	return nil
}

func (store *memoryAccounts) DeleteSession(_ context.Context, fingerprint []byte) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	delete(store.sessions, string(fingerprint))
	return nil
}

// The session the bot mints is a real one, and it does not outlive the call.
func TestMintingIssuesARealSessionAndReleasesIt(t *testing.T) {
	t.Parallel()
	store := &memoryAccounts{users: map[string]auth.User{
		"ops@example.com": {
			ID: "u-1", TenantID: "t-a", Email: "ops@example.com",
			Status: "active", Role: auth.RoleReadOnly,
		},
	}}
	accounts := Accounts{Users: store, Sessions: store, TenantID: "t-a"}

	credential, err := accounts.Mint(context.Background(), "ops@example.com")
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	session, found, _ := store.Session(context.Background(), auth.Fingerprint(credential.Token))
	if !found || session.UserID != "u-1" || session.TenantID != "t-a" {
		t.Fatalf("session = %+v found=%v", session, found)
	}
	// The role is deliberately not copied into the session row: the store
	// reads it back from the account, so demoting an account demotes the bot
	// with it rather than at the end of a session lifetime.
	if session.Role != "" {
		t.Errorf("session role = %q, want it to come from the account", session.Role)
	}
	credential.Release(context.Background())
	if _, still, _ := store.Session(context.Background(),
		auth.Fingerprint(credential.Token)); still {
		t.Fatal("the session outlived the call it was minted for")
	}
}

func TestMintingRefusesUnknownAndDisabledAccounts(t *testing.T) {
	t.Parallel()
	store := &memoryAccounts{users: map[string]auth.User{
		"gone@example.com": {ID: "u-2", TenantID: "t-a", Status: "disabled"},
	}}
	accounts := Accounts{Users: store, Sessions: store, TenantID: "t-a"}

	if _, err := accounts.Mint(context.Background(), "nobody@example.com"); !errors.Is(
		err, ErrUnknownAccount) {
		t.Errorf("unknown account: err = %v", err)
	}
	if _, err := accounts.Mint(context.Background(), "gone@example.com"); !errors.Is(
		err, ErrAccountDisabled) {
		t.Errorf("disabled account: err = %v", err)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.sessions) != 0 {
		t.Fatal("a refused mint still created a session")
	}
}

// An IMEI the fleet does not have is refused before anyone is asked to
// confirm. Enqueuing it would be accepted by the queue and rejected by the
// agent minutes later, where nobody is watching.
func TestAnUnknownImeiNeverBecomesAConfirmation(t *testing.T) {
	t.Parallel()
	chat, api := &fakeTelegram{}, &fakeAPI{}
	bot := newBot(chat, api, operators())

	bot.HandleUpdate(context.Background(), testConfig(), message(111, "/reset 111111111111111"))

	if bot.Pending() != 0 {
		t.Fatal("an unknown IMEI produced a confirmation prompt")
	}
	if writes := api.writes(); len(writes) != 0 {
		t.Fatalf("an unknown IMEI performed %+v", writes)
	}
	if !chat.said("没有 IMEI") {
		t.Fatalf("the operator was not told why: %q", chat.texts())
	}
}

// The confirmation names the device, not only the module, because "reset the
// modem on bench" and "reset the modem on the other box" are the same sentence
// until the device is in it.
func TestTheConfirmationNamesTheDevice(t *testing.T) {
	t.Parallel()
	chat, api := &fakeTelegram{}, &fakeAPI{}
	bot := newBot(chat, api, operators())

	bot.HandleUpdate(context.Background(), testConfig(), message(111, "/reset 867018069509705"))

	if !chat.said("bench") {
		t.Fatalf("the prompt did not name the device: %q", chat.texts())
	}
}

// The device id the gateway needs is looked up, not typed.
func TestAConfirmedActionCarriesTheResolvedDevice(t *testing.T) {
	t.Parallel()
	chat, api := &fakeTelegram{}, &fakeAPI{}
	bot := newBot(chat, api, operators())

	bot.HandleUpdate(context.Background(), testConfig(), message(111, "/reset 867018069509705"))
	bot.HandleUpdate(context.Background(), testConfig(), press(111, "ok:"+chat.nonce(t)))

	writes := api.writes()
	if len(writes) != 1 {
		t.Fatalf("performed %d writes, want 1", len(writes))
	}
	if got := writes[0].body["device_id"]; got != "d-1" {
		t.Fatalf("device_id = %v, want the device carrying the module", got)
	}
}
