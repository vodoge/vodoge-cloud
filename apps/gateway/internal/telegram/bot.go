// Package telegram is the operator-facing bot: a second front door onto the
// same API the console serves.
//
// # Long polling, not a webhook
//
// The gateway dials out to api.telegram.org and asks for updates. The obvious
// alternative -- registering a webhook, since a.vodoge.com is already on the
// public internet behind Caddy -- was rejected for one reason that outweighs
// its convenience.
//
// The read-only account added just before this is enforced by a single
// middleware wrapped around the whole route table: anything whose method is
// not GET/HEAD/OPTIONS/TRACE is refused to a session that may not write, so a
// route added later is covered without anyone remembering to cover it. A
// webhook endpoint would be a POST route, authenticated by a header from
// Telegram rather than by a session, carrying no bearer token -- which is
// exactly the shape that middleware passes straight through. It would be a
// state-changing route, reachable from the internet, that the one chokepoint
// does not evaluate, sitting in front of "switch profile" and "send SMS". The
// secret-token comparison would then be the only thing between the internet
// and the fleet, and it would be load-bearing in a way nothing else in the
// route table is.
//
// Polling has no inbound surface at all. It also needs no change to
// /opt/trek/Caddyfile, which is in no repository and is shared with another
// product. The costs are real and smaller: one resident goroutine, and only
// one process may poll a given bot (Telegram answers a second getUpdates with
// 409). This deployment runs one gateway.
//
// # Identity
//
// A Telegram message ends up performing the same operation as a click in the
// console, so it goes through the same door. A chat is mapped, in tenant
// settings, to a console account by email; the bot resolves that account,
// mints a short-lived session for it, and issues an ordinary HTTP request
// against the gateway's own handler with that session attached. Every check
// the console gets -- the read-only guard, the tenant boundary, rate limits,
// the audit log -- applies unchanged, because it is the same request path. The
// bot holds no privileges of its own, and an unmapped sender is nobody.
//
// # Confirmation
//
// Actions that change the fleet are quoted back with an inline keyboard and
// performed only when the same sender presses the button. Nothing is enqueued
// while a confirmation is outstanding.
package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/auth"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/observe"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/settings"
)

// Metric names this package reports.
const (
	// UpdatesTotal counts handled updates by outcome: answered, unauthorised,
	// rejected. "unauthorised" rising on its own is somebody probing the bot;
	// it is the series worth an alert.
	UpdatesTotal = "vodoge_telegram_updates_total"
	// ActionsTotal counts what operators asked for, by command and outcome:
	// requested (a confirmation was offered), confirmed, cancelled, expired,
	// refused (the account may not), rejected (malformed), failed.
	ActionsTotal = "vodoge_telegram_actions_total"
)

// DeclareMetrics registers this package's series.
//
// Declared by the package that emits them, so the series exist and read zero
// before the first message rather than appearing out of nowhere.
func DeclareMetrics(registry *observe.Registry) {
	if registry == nil {
		return
	}
	registry.Count(UpdatesTotal, "Telegram updates handled, by outcome.")
	registry.Count(ActionsTotal, "Telegram actions, by command and outcome.")
}

// ── Configuration ────────────────────────────────────────────────────────

// DefaultAPIBase is Telegram's own host.
const DefaultAPIBase = "https://api.telegram.org"

// Config is the bot's slice of a tenant's notification settings, already
// parsed. It is re-read from the database on every poll, so enabling the bot,
// adding an operator or rotating the token all take effect without a restart.
type Config struct {
	Enabled  bool
	Token    string
	APIBase  string
	accounts map[string]string // telegram sender id -> account email
}

// ReadConfig parses the notifications section.
//
// Fails closed in every direction: a malformed operator list authorises nobody
// rather than authorising the entries that happened to parse, because the half
// that failed to parse is the half nobody has looked at.
func ReadConfig(notifications map[string]any) Config {
	operators, err := settings.TelegramOperators(notifications)
	if err != nil {
		slog.Warn("telegram bot operators are unusable, nobody is authorised",
			"error", err)
		return Config{}
	}
	accounts := make(map[string]string, len(operators))
	for _, operator := range operators {
		accounts[operator.ChatID] = operator.Email
	}
	base := strings.TrimRight(strings.TrimSpace(settings.TelegramAPIBase(notifications)), "/")
	if base == "" {
		base = DefaultAPIBase
	}
	config := Config{
		Token:    settings.TelegramBotToken(notifications),
		APIBase:  base,
		accounts: accounts,
	}
	config.Enabled = settings.TelegramBotEnabled(notifications) &&
		config.Token != "" && len(accounts) > 0
	return config
}

// Account returns the console account a sender acts as, if any.
func (config Config) Account(senderID int64) (string, bool) {
	email, ok := config.accounts[strconv.FormatInt(senderID, 10)]
	return email, ok
}

// Operators is how many chats this configuration authorises.
func (config Config) Operators() int { return len(config.accounts) }

// ── Telegram wire types ──────────────────────────────────────────────────

// Update is the subset of Telegram's update object this bot acts on.
type Update struct {
	UpdateID      int64          `json:"update_id"`
	Message       *Message       `json:"message"`
	CallbackQuery *CallbackQuery `json:"callback_query"`
}

// Message is one chat message.
type Message struct {
	MessageID int64  `json:"message_id"`
	Text      string `json:"text"`
	From      *User  `json:"from"`
	Chat      *Chat  `json:"chat"`
}

// User is a Telegram account.
type User struct {
	ID int64 `json:"id"`
}

// Chat is a conversation.
type Chat struct {
	ID   int64  `json:"id"`
	Type string `json:"type"`
}

// CallbackQuery is a press of an inline keyboard button.
type CallbackQuery struct {
	ID      string   `json:"id"`
	Data    string   `json:"data"`
	From    *User    `json:"from"`
	Message *Message `json:"message"`
}

// Transport talks to the Telegram Bot API.
//
// An interface so the bot's behaviour can be exercised without the network and
// without a real token: every test in this package drives it through a
// recording transport.
type Transport interface {
	Call(ctx context.Context, config Config, method string, body, out any) error
}

// HTTPTransport is the real client.
type HTTPTransport struct {
	Client *http.Client
}

// telegramTimeout bounds one API call. Long polling asks for a shorter wait
// than this, so a call that reaches it is a stuck connection rather than an
// idle one.
const telegramTimeout = 75 * time.Second

func (transport HTTPTransport) Call(
	ctx context.Context, config Config, method string, body, out any,
) error {
	client := transport.Client
	if client == nil {
		client = &http.Client{Timeout: telegramTimeout}
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	base := config.APIBase
	if base == "" {
		base = DefaultAPIBase
	}
	endpoint := base + "/bot" + config.Token + "/" + method
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint,
		bytes.NewReader(encoded))
	if err != nil {
		return hide(err, config.Token)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return hide(err, config.Token)
	}
	defer func() { _ = response.Body.Close() }()
	// 1 MiB is far past any answer this bot asks for and far short of anything
	// that could exhaust the process.
	payload, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return hide(err, config.Token)
	}
	var envelope struct {
		OK          bool            `json:"ok"`
		Description string          `json:"description"`
		Result      json.RawMessage `json:"result"`
	}
	_ = json.Unmarshal(payload, &envelope)
	if response.StatusCode >= 300 || !envelope.OK {
		reason := strings.TrimSpace(envelope.Description)
		if reason != "" {
			reason = ": " + reason
		}
		return fmt.Errorf("telegram %s: HTTP %d%s", method, response.StatusCode, reason)
	}
	if out == nil || len(envelope.Result) == 0 {
		return nil
	}
	return json.Unmarshal(envelope.Result, out)
}

// hide keeps the bot token out of an error string.
//
// The token is a path segment, so net/http quotes it back inside its own
// errors -- and those errors are logged. Without this, one DNS failure puts
// the credential in the log of a machine whose logs are not treated as
// secrets.
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

// ── The gateway's own API ────────────────────────────────────────────────

// Answer is what an internal call returned.
type Answer struct {
	Status int
	Body   []byte
}

// OK reports a 2xx.
func (answer Answer) OK() bool { return answer.Status >= 200 && answer.Status < 300 }

// API performs a request against the gateway as a given session.
type API interface {
	Do(ctx context.Context, method, path, token string, body any) (Answer, error)
}

// Loopback runs the request through the gateway's own handler.
//
// In process rather than over a socket, but through the complete handler --
// security headers, metrics, and the read-only guard -- so the bot cannot
// reach a handler by a route that skips any of them. Calling the handler
// functions directly would have been simpler and would have been exactly the
// bypass this design exists to prevent.
type Loopback struct {
	Handler http.Handler
	// Host is the tenant's console hostname, e.g. a.vodoge.com. It is what the
	// gateway resolves the tenant from, and it is cross-checked against the
	// session, so a wrong value here fails closed.
	Host string
}

func (loopback Loopback) Do(
	ctx context.Context, method, path, token string, body any,
) (Answer, error) {
	if loopback.Handler == nil {
		return Answer{}, errors.New("telegram: no gateway handler")
	}
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return Answer{}, err
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method,
		"http://"+loopback.Host+path, reader)
	if err != nil {
		return Answer{}, err
	}
	request.Host = loopback.Host
	// Named so a rate limiter that falls back to the client address groups the
	// bot's traffic together rather than under the empty string.
	request.RemoteAddr = "127.0.0.1:0"
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	recorder := &capture{header: http.Header{}, status: http.StatusOK}
	loopback.Handler.ServeHTTP(recorder, request)
	return Answer{Status: recorder.status, Body: recorder.body.Bytes()}, nil
}

// capture is the innermost ResponseWriter for a loopback call.
type capture struct {
	header  http.Header
	body    bytes.Buffer
	status  int
	written bool
}

func (writer *capture) Header() http.Header { return writer.header }

func (writer *capture) WriteHeader(status int) {
	if writer.written {
		return
	}
	writer.written = true
	writer.status = status
}

func (writer *capture) Write(payload []byte) (int, error) {
	if !writer.written {
		writer.WriteHeader(http.StatusOK)
	}
	return writer.body.Write(payload)
}

// Flush exists because middleware wraps this writer and forwards to whatever
// the inner one implements. None of the routes the bot calls stream, but a
// writer that silently lacks Flush is the shape of a bug that appears only on
// the one route that does.
func (writer *capture) Flush() {}

// ── Credentials ──────────────────────────────────────────────────────────

var (
	// ErrUnknownAccount means the mapping names an account this tenant does
	// not have.
	ErrUnknownAccount = errors.New("the mapped account does not exist")
	// ErrAccountDisabled means the account exists and may not act.
	ErrAccountDisabled = errors.New("the mapped account is disabled")
)

// Credential is a short-lived session held on behalf of an operator.
type Credential struct {
	Token  string
	UserID string
	// Release ends the session. Always called; a bot request should not leave
	// a usable token behind it.
	Release func(context.Context)
}

// Accounts mints a real session for a mapped console account.
//
// It deliberately does no role logic. The role travels with the account and is
// read by the same middleware that reads it for a browser, so there is one
// implementation of "may this identity change things" rather than two that
// have to agree.
type Accounts struct {
	Users    auth.UserStore
	Sessions auth.SessionStore
	TenantID string
	// TTL is how long a minted session lasts. Short: it is released as soon as
	// the call it was minted for returns, and this is only the ceiling for the
	// case where the process dies in between.
	TTL time.Duration
	Now func() time.Time
}

// DefaultCredentialTTL bounds a session the bot mints.
const DefaultCredentialTTL = 2 * time.Minute

func (accounts Accounts) now() time.Time {
	if accounts.Now != nil {
		return accounts.Now()
	}
	return time.Now()
}

// Mint resolves email inside the bot's tenant and issues a session for it.
func (accounts Accounts) Mint(ctx context.Context, email string) (Credential, error) {
	if accounts.Users == nil || accounts.Sessions == nil {
		return Credential{}, errors.New("telegram: no account store")
	}
	user, found, err := accounts.Users.User(ctx, accounts.TenantID, email)
	if err != nil {
		return Credential{}, err
	}
	if !found {
		return Credential{}, ErrUnknownAccount
	}
	if !user.Active() {
		return Credential{}, ErrAccountDisabled
	}
	token, err := auth.NewToken()
	if err != nil {
		return Credential{}, err
	}
	ttl := accounts.TTL
	if ttl <= 0 {
		ttl = DefaultCredentialTTL
	}
	fingerprint := auth.Fingerprint(token)
	// The role is not written here on purpose. The store reads it back from
	// the account, so an account demoted while a bot session is open is
	// demoted for the bot too.
	err = accounts.Sessions.CreateSession(ctx, fingerprint, auth.Session{
		UserID:    user.ID,
		TenantID:  user.TenantID,
		ExpiresAt: accounts.now().Add(ttl),
	})
	if err != nil {
		return Credential{}, err
	}
	return Credential{
		Token:  token,
		UserID: user.ID,
		Release: func(ctx context.Context) {
			if err := accounts.Sessions.DeleteSession(ctx, fingerprint); err != nil {
				slog.Warn("telegram session was not released", "error", err)
			}
		},
	}, nil
}

// Minter is the slice of Accounts the bot uses.
type Minter interface {
	Mint(ctx context.Context, email string) (Credential, error)
}

// ── The bot ──────────────────────────────────────────────────────────────

// Bot turns Telegram updates into gateway calls.
type Bot struct {
	Telegram Transport
	API      API
	Accounts Minter
	Metrics  *observe.Registry
	Logger   *slog.Logger
	Now      func() time.Time

	mu       sync.Mutex
	pending  map[string]*confirmation
	scolded  map[int64]time.Time
	sequence uint64
}

// ConfirmationTTL is how long a quoted action waits for its button.
//
// Long enough to read the message and think; short enough that a phone left
// unlocked on a desk is not a fleet command an hour later.
const ConfirmationTTL = 3 * time.Minute

// scoldInterval is the least time between two refusals sent to the same
// unauthorised sender, so the bot cannot be pointed at somebody as a way of
// sending them messages.
const scoldInterval = time.Minute

type confirmation struct {
	senderID int64
	chatID   int64
	action   action
	expires  time.Time
}

// action is a fully formed intent: everything needed to perform it, decided
// before the operator was asked, so that pressing the button performs exactly
// what was quoted.
type action struct {
	command string
	method  string
	path    string
	body    map[string]any
	// quote is what the operator is shown before confirming.
	quote string
	// done renders the answer.
	done func(Answer) string
}

func (bot *Bot) now() time.Time {
	if bot.Now != nil {
		return bot.Now()
	}
	return time.Now()
}

func (bot *Bot) log() *slog.Logger {
	if bot.Logger != nil {
		return bot.Logger
	}
	return slog.Default()
}

func (bot *Bot) count(name string, labels ...string) {
	if bot.Metrics != nil {
		bot.Metrics.Add(name, 1, labels...)
	}
}

// HandleUpdate processes one update. Failures are reported to the operator and
// logged; they never stop the poll loop.
func (bot *Bot) HandleUpdate(ctx context.Context, config Config, update Update) {
	switch {
	case update.CallbackQuery != nil:
		bot.handleCallback(ctx, config, update.CallbackQuery)
	case update.Message != nil:
		bot.handleMessage(ctx, config, update.Message)
	}
}

func (bot *Bot) handleMessage(ctx context.Context, config Config, message *Message) {
	if message.From == nil || message.Chat == nil {
		return
	}
	sender := message.From.ID
	email, authorised := config.Account(sender)
	if !authorised {
		bot.refuseStranger(ctx, config, message.Chat.ID, sender)
		return
	}
	text := strings.TrimSpace(message.Text)
	if text == "" {
		return
	}
	verb, rest := splitCommand(text)
	switch verb {
	case "/start", "/help":
		bot.count(UpdatesTotal, "result", "answered")
		bot.say(ctx, config, message.Chat.ID, helpText())
	case "/status", "/profiles":
		bot.count(UpdatesTotal, "result", "answered")
		bot.readOnlyCommand(ctx, config, message.Chat.ID, email, verb, rest)
	case "/sms", "/switch", "/reset":
		bot.count(UpdatesTotal, "result", "answered")
		bot.propose(ctx, config, message, email, verb, rest)
	case "/cancel":
		bot.count(UpdatesTotal, "result", "answered")
		bot.say(ctx, config, message.Chat.ID, bot.cancelAll(sender))
	default:
		bot.count(UpdatesTotal, "result", "rejected")
		bot.say(ctx, config, message.Chat.ID, "不认识这条指令。\n\n"+helpText())
	}
}

// refuseStranger answers a sender that maps to no account.
//
// It says nothing about which accounts exist or what the bot can do. There is
// a reply at all so that an operator whose mapping is missing or mistyped is
// told, rather than watching the bot ignore them.
func (bot *Bot) refuseStranger(ctx context.Context, config Config, chatID, sender int64) {
	bot.count(UpdatesTotal, "result", "unauthorised")
	bot.log().Warn("telegram message from an unauthorised sender",
		"sender_id", sender, "chat_id", chatID)
	bot.mu.Lock()
	if bot.scolded == nil {
		bot.scolded = map[int64]time.Time{}
	}
	last, seen := bot.scolded[sender]
	quiet := seen && bot.now().Sub(last) < scoldInterval
	if !quiet {
		bot.scolded[sender] = bot.now()
	}
	bot.mu.Unlock()
	if quiet {
		return
	}
	bot.say(ctx, config, chatID, fmt.Sprintf(
		"未授权。此 Telegram 账号（id %d）没有映射到任何控制台账号。", sender))
}

// readOnlyCommand answers a question about the fleet.
func (bot *Bot) readOnlyCommand(
	ctx context.Context, config Config, chatID int64, email, verb, rest string,
) {
	credential, err := bot.Accounts.Mint(ctx, email)
	if err != nil {
		bot.count(ActionsTotal, "command", strings.TrimPrefix(verb, "/"), "result", "refused")
		bot.say(ctx, config, chatID, accountProblem(email, err))
		return
	}
	defer credential.Release(ctx)

	switch verb {
	case "/status":
		bot.say(ctx, config, chatID,
			bot.renderStatus(ctx, credential.Token, strings.TrimSpace(rest)))
	case "/profiles":
		answer, err := bot.API.Do(ctx, http.MethodGet, "/v1/esim/profiles",
			credential.Token, nil)
		bot.say(ctx, config, chatID, renderProfiles(answer, err))
	}
}

// propose quotes a state-changing action and waits for the button.
//
// Nothing is enqueued here. The action is built now -- so that what is quoted
// and what is later performed are one object rather than two parses of the
// same text -- and held under a nonce only this sender can redeem.
func (bot *Bot) propose(
	ctx context.Context, config Config, message *Message, email, verb, rest string,
) {
	act, err := buildAction(verb, rest)
	if err != nil {
		bot.count(ActionsTotal, "command", strings.TrimPrefix(verb, "/"), "result", "rejected")
		bot.say(ctx, config, message.Chat.ID, err.Error())
		return
	}
	// Resolved before asking, so an operator whose account is gone is told now
	// rather than after pressing a button that then fails.
	credential, err := bot.Accounts.Mint(ctx, email)
	if err != nil {
		bot.count(ActionsTotal, "command", act.command, "result", "refused")
		bot.say(ctx, config, message.Chat.ID, accountProblem(email, err))
		return
	}
	target, err := bot.locate(ctx, credential.Token, act.body["modem_imei"].(string))
	credential.Release(ctx)
	if err != nil {
		bot.count(ActionsTotal, "command", act.command, "result", "rejected")
		bot.say(ctx, config, message.Chat.ID, err.Error())
		return
	}
	// The device is looked up rather than typed. An operator knows a module by
	// its IMEI -- that is what the console shows, what a status reply shows,
	// and what is printed on the thing -- while the API addresses commands to
	// the device that carries it. Asking a person to supply both would be
	// asking them to look up an id so the bot does not have to.
	act.body["device_id"] = target.id
	act.quote += "\n\n设备 " + target.name
	nonce := bot.remember(message.From.ID, message.Chat.ID, act)
	bot.count(ActionsTotal, "command", act.command, "result", "requested")
	bot.log().Info("telegram action awaiting confirmation",
		"sender_id", message.From.ID, "command", act.command)
	bot.ask(ctx, config, message.Chat.ID, act.quote, nonce)
}

// target is the device a module belongs to.
type target struct {
	id   string
	name string
}

// locate finds the device carrying an IMEI.
//
// It fails rather than guesses. A command addressed to a device that does not
// have the module would be accepted by the queue and rejected by the agent
// minutes later, and the operator would have to go and read a command log to
// find out why nothing happened.
func (bot *Bot) locate(ctx context.Context, token, imei string) (target, error) {
	answer, err := bot.API.Do(ctx, http.MethodGet, "/v1/modems", token, nil)
	if err != nil {
		return target{}, errors.New("无法读取模组列表，已中止。")
	}
	if !answer.OK() {
		return target{}, fmt.Errorf("无法读取模组列表（HTTP %d）：%s",
			answer.Status, detail(answer))
	}
	var body struct {
		Modems []modemRow `json:"modems"`
	}
	if json.Unmarshal(answer.Body, &body) != nil {
		return target{}, errors.New("模组列表无法解析，已中止。")
	}
	for _, modem := range body.Modems {
		if modem.IMEI != imei {
			continue
		}
		found := target{id: modem.DeviceID, name: modem.DeviceID}
		if devices, err := bot.API.Do(ctx, http.MethodGet, "/v1/devices", token, nil); err == nil &&
			devices.OK() {
			var list struct {
				Devices []deviceRow `json:"devices"`
			}
			if json.Unmarshal(devices.Body, &list) == nil {
				for _, device := range list.Devices {
					if device.ID == modem.DeviceID && device.Name != "" {
						found.name = device.Name
					}
				}
			}
		}
		return found, nil
	}
	return target{}, fmt.Errorf("机队里没有 IMEI 为 %s 的模组。用 /status 看看有哪些。", imei)
}

func (bot *Bot) remember(senderID, chatID int64, act action) string {
	bot.mu.Lock()
	defer bot.mu.Unlock()
	if bot.pending == nil {
		bot.pending = map[string]*confirmation{}
	}
	bot.sequence++
	// Unguessable is not required -- redeeming also requires being the sender
	// that created it -- but distinct is, and a counter alone would repeat
	// across restarts.
	nonce := strconv.FormatUint(bot.sequence, 36) + "-" +
		strconv.FormatInt(bot.now().UnixNano()%1000000007, 36)
	bot.pending[nonce] = &confirmation{
		senderID: senderID,
		chatID:   chatID,
		action:   act,
		expires:  bot.now().Add(ConfirmationTTL),
	}
	bot.expireLocked()
	return nonce
}

func (bot *Bot) expireLocked() {
	now := bot.now()
	for key, item := range bot.pending {
		if !item.expires.After(now) {
			delete(bot.pending, key)
		}
	}
}

// redeem takes a pending action, once.
func (bot *Bot) redeem(nonce string, senderID int64) (*confirmation, error) {
	bot.mu.Lock()
	defer bot.mu.Unlock()
	item, ok := bot.pending[nonce]
	if !ok {
		return nil, errors.New("这条确认已经用过或已过期。")
	}
	// Checked before deleting: somebody else pressing this button must not be
	// able to consume it either.
	if item.senderID != senderID {
		return nil, errors.New("这条确认属于另一个人。")
	}
	delete(bot.pending, nonce)
	if !item.expires.After(bot.now()) {
		return nil, errors.New("这条确认已经过期，请重新发起。")
	}
	return item, nil
}

func (bot *Bot) cancelAll(senderID int64) string {
	bot.mu.Lock()
	defer bot.mu.Unlock()
	dropped := 0
	for key, item := range bot.pending {
		if item.senderID == senderID {
			delete(bot.pending, key)
			dropped++
		}
	}
	if dropped == 0 {
		return "没有待确认的操作。"
	}
	return fmt.Sprintf("已取消 %d 个待确认操作。", dropped)
}

func (bot *Bot) handleCallback(ctx context.Context, config Config, query *CallbackQuery) {
	if query.From == nil {
		return
	}
	sender := query.From.ID
	chatID := sender
	if query.Message != nil && query.Message.Chat != nil {
		chatID = query.Message.Chat.ID
	}
	// Re-checked against the current configuration rather than trusted from
	// when the button was drawn: an operator removed in between must not be
	// able to redeem an action they were offered while still mapped.
	email, authorised := config.Account(sender)
	if !authorised {
		bot.acknowledge(ctx, config, query.ID, "未授权")
		bot.refuseStranger(ctx, config, chatID, sender)
		return
	}

	verdict, nonce, ok := strings.Cut(query.Data, ":")
	if !ok {
		bot.acknowledge(ctx, config, query.ID, "")
		return
	}
	switch verdict {
	case "no":
		bot.dropOne(nonce, sender)
		bot.count(ActionsTotal, "command", "callback", "result", "cancelled")
		bot.acknowledge(ctx, config, query.ID, "已取消")
		bot.clearKeyboard(ctx, config, query)
		bot.say(ctx, config, chatID, "已取消，什么都没有执行。")
		return
	case "ok":
	default:
		bot.acknowledge(ctx, config, query.ID, "")
		return
	}

	item, err := bot.redeem(nonce, sender)
	if err != nil {
		bot.count(ActionsTotal, "command", "callback", "result", "expired")
		bot.acknowledge(ctx, config, query.ID, "无效")
		bot.say(ctx, config, chatID, err.Error())
		return
	}
	bot.acknowledge(ctx, config, query.ID, "执行中…")
	bot.clearKeyboard(ctx, config, query)
	bot.perform(ctx, config, chatID, email, item.action)
}

// perform runs a confirmed action as the operator's account.
func (bot *Bot) perform(
	ctx context.Context, config Config, chatID int64, email string, act action,
) {
	credential, err := bot.Accounts.Mint(ctx, email)
	if err != nil {
		bot.count(ActionsTotal, "command", act.command, "result", "refused")
		bot.say(ctx, config, chatID, accountProblem(email, err))
		return
	}
	defer credential.Release(ctx)

	answer, err := bot.API.Do(ctx, act.method, act.path, credential.Token, act.body)
	switch {
	case err != nil:
		bot.count(ActionsTotal, "command", act.command, "result", "failed")
		bot.log().Warn("telegram action failed", "command", act.command, "error", err)
		bot.say(ctx, config, chatID, "执行失败："+err.Error())
	case answer.Status == http.StatusForbidden:
		// The read-only guard, reached through the same door a browser uses.
		bot.count(ActionsTotal, "command", act.command, "result", "refused")
		bot.log().Info("telegram action refused by the gateway",
			"command", act.command, "user_id", credential.UserID)
		bot.say(ctx, config, chatID, "被拒绝："+detail(answer))
	case !answer.OK():
		bot.count(ActionsTotal, "command", act.command, "result", "failed")
		bot.say(ctx, config, chatID,
			fmt.Sprintf("执行失败（HTTP %d）：%s", answer.Status, detail(answer)))
	default:
		bot.count(ActionsTotal, "command", act.command, "result", "confirmed")
		bot.log().Info("telegram action performed",
			"command", act.command, "user_id", credential.UserID)
		bot.say(ctx, config, chatID, act.done(answer))
	}
}

func (bot *Bot) dropOne(nonce string, senderID int64) {
	bot.mu.Lock()
	defer bot.mu.Unlock()
	if item, ok := bot.pending[nonce]; ok && item.senderID == senderID {
		delete(bot.pending, nonce)
	}
}

// Pending reports how many confirmations are outstanding.
func (bot *Bot) Pending() int {
	bot.mu.Lock()
	defer bot.mu.Unlock()
	bot.expireLocked()
	return len(bot.pending)
}

// ── Rendering ────────────────────────────────────────────────────────────

func (bot *Bot) say(ctx context.Context, config Config, chatID int64, text string) {
	if strings.TrimSpace(text) == "" {
		return
	}
	err := bot.Telegram.Call(ctx, config, "sendMessage", map[string]any{
		"chat_id": chatID,
		"text":    clip(text, telegramTextLimit),
		// No parse mode. Device names, operator names and message bodies are
		// arbitrary text; rendering them as Markdown means every unbalanced
		// asterisk in a real SMS becomes a message Telegram refuses to send.
		"link_preview_options": map[string]any{"is_disabled": true},
	}, nil)
	if err != nil {
		bot.log().Warn("telegram reply failed", "error", err)
	}
}

func (bot *Bot) ask(ctx context.Context, config Config, chatID int64, quote, nonce string) {
	err := bot.Telegram.Call(ctx, config, "sendMessage", map[string]any{
		"chat_id": chatID,
		"text":    clip(quote, telegramTextLimit),
		"reply_markup": map[string]any{
			"inline_keyboard": [][]map[string]any{{
				{"text": "确认执行", "callback_data": "ok:" + nonce},
				{"text": "取消", "callback_data": "no:" + nonce},
			}},
		},
		"link_preview_options": map[string]any{"is_disabled": true},
	}, nil)
	if err != nil {
		bot.log().Warn("telegram confirmation prompt failed", "error", err)
	}
}

func (bot *Bot) acknowledge(ctx context.Context, config Config, queryID, text string) {
	if queryID == "" {
		return
	}
	body := map[string]any{"callback_query_id": queryID}
	if text != "" {
		body["text"] = text
	}
	if err := bot.Telegram.Call(ctx, config, "answerCallbackQuery", body, nil); err != nil {
		bot.log().Warn("telegram callback acknowledgement failed", "error", err)
	}
}

// clearKeyboard takes the buttons off a prompt that has been answered, so the
// chat does not keep offering a choice that has already been made.
func (bot *Bot) clearKeyboard(ctx context.Context, config Config, query *CallbackQuery) {
	if query.Message == nil || query.Message.Chat == nil {
		return
	}
	err := bot.Telegram.Call(ctx, config, "editMessageReplyMarkup", map[string]any{
		"chat_id":      query.Message.Chat.ID,
		"message_id":   query.Message.MessageID,
		"reply_markup": map[string]any{"inline_keyboard": [][]map[string]any{}},
	}, nil)
	if err != nil {
		// Cosmetic. The nonce is already spent, so a button left on screen
		// cannot perform anything twice.
		bot.log().Debug("telegram keyboard not cleared", "error", err)
	}
}

// telegramTextLimit is Telegram's own ceiling on a message.
const telegramTextLimit = 4096

// clip shortens text to a byte limit on a rune boundary, because half a UTF-8
// sequence is not a character and Telegram rejects the result.
func clip(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	const ellipsis = "…"
	cut := limit - len(ellipsis)
	if cut < 0 {
		cut = 0
	}
	for cut > 0 && text[cut]&0xC0 == 0x80 {
		cut--
	}
	return text[:cut] + ellipsis
}

func helpText() string {
	return strings.Join([]string{
		"VoDoge 机器人。指令：",
		"",
		"/status [IMEI]              查设备与模组状态",
		"/profiles                   列出 eSIM profile",
		"/sms <IMEI> <号码> <正文>   发短信（需确认）",
		"/switch <IMEI> <ICCID>      切换 eSIM profile（需确认）",
		"/reset <IMEI>               重新枚举模组 USB（需确认）",
		"/cancel                     取消待确认的操作",
		"",
		"改变状态的指令会先把要做的事回给你，按下按钮才执行。",
		"权限与网页控制台完全相同：你的账号能做什么，机器人就能做什么。",
	}, "\n")
}

func accountProblem(email string, err error) string {
	switch {
	case errors.Is(err, ErrUnknownAccount):
		return fmt.Sprintf("映射到的账号 %s 不存在。", email)
	case errors.Is(err, ErrAccountDisabled):
		return fmt.Sprintf("映射到的账号 %s 已停用。", email)
	default:
		return "无法确认身份，已拒绝执行。"
	}
}

// detail returns a server error body, trimmed to something a chat can carry.
func detail(answer Answer) string {
	text := strings.TrimSpace(string(answer.Body))
	if text == "" {
		return "（没有说明）"
	}
	return clip(text, 500)
}

type modemRow struct {
	DeviceID     string  `json:"device_id"`
	IMEI         string  `json:"imei"`
	ICCID        *string `json:"iccid"`
	Registration *string `json:"registration"`
	SignalDbm    *int64  `json:"signal_dbm"`
	Rsrp         *int64  `json:"rsrp"`
	ServingPlmn  *string `json:"serving_plmn"`
	Manageable   *bool   `json:"manageable"`
}

type deviceRow struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	State    string  `json:"state"`
	PublicIP *string `json:"public_ip"`
}

// renderStatus is the answer to "is the fleet all right", which is the whole
// reason to reach for a chat window rather than a browser.
func (bot *Bot) renderStatus(ctx context.Context, token, filter string) string {
	devices, deviceErr := bot.API.Do(ctx, http.MethodGet, "/v1/devices", token, nil)
	modems, modemErr := bot.API.Do(ctx, http.MethodGet, "/v1/modems", token, nil)
	if deviceErr != nil || modemErr != nil {
		return "读取状态失败。"
	}
	if !devices.OK() {
		return fmt.Sprintf("读取设备失败（HTTP %d）：%s", devices.Status, detail(devices))
	}
	if !modems.OK() {
		return fmt.Sprintf("读取模组失败（HTTP %d）：%s", modems.Status, detail(modems))
	}
	var deviceBody struct {
		Devices []deviceRow `json:"devices"`
	}
	var modemBody struct {
		Modems []modemRow `json:"modems"`
	}
	if json.Unmarshal(devices.Body, &deviceBody) != nil ||
		json.Unmarshal(modems.Body, &modemBody) != nil {
		return "状态响应无法解析。"
	}

	byDevice := map[string][]modemRow{}
	for _, modem := range modemBody.Modems {
		if filter != "" && modem.IMEI != filter {
			continue
		}
		byDevice[modem.DeviceID] = append(byDevice[modem.DeviceID], modem)
	}
	sort.Slice(deviceBody.Devices, func(i, j int) bool {
		return deviceBody.Devices[i].Name < deviceBody.Devices[j].Name
	})
	lines := make([]string, 0, len(deviceBody.Devices)*3)
	shown := 0
	for _, device := range deviceBody.Devices {
		rows := byDevice[device.ID]
		if filter != "" && len(rows) == 0 {
			continue
		}
		head := device.Name + " · " + device.State
		if device.PublicIP != nil && *device.PublicIP != "" {
			head += " · " + *device.PublicIP
		}
		lines = append(lines, head)
		sort.Slice(rows, func(i, j int) bool { return rows[i].IMEI < rows[j].IMEI })
		for _, modem := range rows {
			lines = append(lines, "  "+modemLine(modem))
			shown++
		}
		if len(rows) == 0 {
			lines = append(lines, "  （没有模组）")
		}
	}
	if len(lines) == 0 {
		if filter != "" {
			return "没有 IMEI 为 " + filter + " 的模组。"
		}
		return "还没有设备上报。"
	}
	if filter == "" {
		lines = append(lines, "", fmt.Sprintf("共 %d 个模组。", shown))
	}
	return strings.Join(lines, "\n")
}

func modemLine(modem modemRow) string {
	parts := []string{modem.IMEI, text(modem.Registration, "registration?")}
	if modem.ServingPlmn != nil && *modem.ServingPlmn != "" {
		parts = append(parts, *modem.ServingPlmn)
	}
	switch {
	case modem.Rsrp != nil:
		parts = append(parts, fmt.Sprintf("RSRP %d dBm", *modem.Rsrp))
	case modem.SignalDbm != nil:
		parts = append(parts, fmt.Sprintf("%d dBm", *modem.SignalDbm))
	}
	if modem.ICCID != nil && *modem.ICCID != "" {
		parts = append(parts, "ICCID "+*modem.ICCID)
	}
	// Reported rather than hidden: a module the agent found over its AT port
	// alone is present and out of reach, and that is exactly the state where
	// somebody reaches for the bot to ask why a command did nothing.
	if modem.Manageable != nil && !*modem.Manageable {
		parts = append(parts, "待纳管")
	}
	return strings.Join(parts, " · ")
}

func text(value *string, fallback string) string {
	if value == nil || *value == "" {
		return fallback
	}
	return *value
}

func renderProfiles(answer Answer, err error) string {
	if err != nil {
		return "读取 profile 失败。"
	}
	if !answer.OK() {
		return fmt.Sprintf("读取 profile 失败（HTTP %d）：%s", answer.Status, detail(answer))
	}
	var body struct {
		Profiles []struct {
			ICCID    string `json:"iccid"`
			Nickname string `json:"nickname"`
			State    string `json:"state"`
			IMEI     string `json:"modem_imei"`
		} `json:"profiles"`
	}
	if json.Unmarshal(answer.Body, &body) != nil {
		return "profile 响应无法解析。"
	}
	if len(body.Profiles) == 0 {
		return "没有已知的 eSIM profile。先在控制台读一次卡（list_esim_profiles）。"
	}
	lines := make([]string, 0, len(body.Profiles))
	for _, profile := range body.Profiles {
		line := profile.ICCID
		for _, extra := range []string{profile.Nickname, profile.State, profile.IMEI} {
			if extra != "" {
				line += " · " + extra
			}
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

// ── Parsing ──────────────────────────────────────────────────────────────

var (
	imeiPattern  = regexp.MustCompile(`^[0-9]{15}$`)
	iccidPattern = regexp.MustCompile(`^[0-9]{19,20}$`)
	phonePattern = regexp.MustCompile(`^\+?[0-9]{1,15}$`)
)

// splitCommand separates the verb from the rest, tolerating the @botname
// suffix Telegram appends in groups.
func splitCommand(text string) (string, string) {
	verb, rest, _ := strings.Cut(text, " ")
	verb = strings.ToLower(strings.TrimSpace(verb))
	if at := strings.IndexByte(verb, '@'); at >= 0 {
		verb = verb[:at]
	}
	return verb, strings.TrimSpace(rest)
}

// buildAction turns a sensitive command into the exact call it will make.
//
// Validation happens here as well as in the gateway. The point is not defence
// -- the gateway validates the same request again -- but that a confirmation
// has to be the truth. Quoting a send to a number the gateway will reject, and
// only failing after the operator presses the button, is worse than refusing
// it while they are still typing.
func buildAction(verb, rest string) (action, error) {
	switch verb {
	case "/sms":
		return smsAction(rest)
	case "/switch":
		return switchAction(rest)
	case "/reset":
		imei := strings.TrimSpace(rest)
		if !imeiPattern.MatchString(imei) {
			return action{}, errors.New("用法：/reset <15 位 IMEI>")
		}
		return action{
			command: "reset_modem_usb",
			method:  http.MethodPost,
			path:    "/v1/commands",
			body:    map[string]any{"kind": "reset_modem_usb", "modem_imei": imei},
			quote: fmt.Sprintf("要重置模组 USB 吗？\n\n模组 %s\n\n"+
				"这会真的让 USB 重新枚举：模组会短暂从机队消失，回来之前控制台够不到它。",
				imei),
			done: commandQueued("重置已入队"),
		}, nil
	}
	return action{}, errors.New("不认识这条指令。")
}

func smsAction(rest string) (action, error) {
	const usage = "用法：/sms <15 位 IMEI> <号码> <正文>"
	imei, remainder, _ := strings.Cut(rest, " ")
	to, body, found := strings.Cut(strings.TrimSpace(remainder), " ")
	imei = strings.TrimSpace(imei)
	to = strings.TrimSpace(to)
	body = strings.TrimSpace(body)
	if !imeiPattern.MatchString(imei) {
		return action{}, errors.New(usage)
	}
	if !phonePattern.MatchString(to) {
		return action{}, errors.New("号码不合法。" + usage)
	}
	if !found || body == "" {
		return action{}, errors.New("正文不能为空。" + usage)
	}
	return action{
		command: "send_sms",
		method:  http.MethodPost,
		path:    "/v1/commands",
		body: map[string]any{
			"kind": "send_sms", "modem_imei": imei, "to": to, "body": body,
		},
		quote: fmt.Sprintf("要发送短信吗？\n\n模组 %s\n收件 %s\n正文 %s\n\n确认后立即入队。",
			imei, to, clip(body, 400)),
		done: commandQueued("短信已入队"),
	}, nil
}

func switchAction(rest string) (action, error) {
	imei, iccid, _ := strings.Cut(rest, " ")
	imei = strings.TrimSpace(imei)
	iccid = strings.TrimSpace(iccid)
	if !imeiPattern.MatchString(imei) || !iccidPattern.MatchString(iccid) {
		return action{}, errors.New("用法：/switch <15 位 IMEI> <19-20 位 ICCID>")
	}
	return action{
		command: "switch_esim_profile",
		method:  http.MethodPost,
		path:    "/v1/commands",
		body: map[string]any{
			"kind": "switch_esim_profile", "modem_imei": imei, "target_iccid": iccid,
		},
		quote: fmt.Sprintf("要切换 eSIM profile 吗？\n\n模组 %s\n目标 ICCID %s\n\n"+
			"切换会让模组重新附着网络，期间该模组不可用；"+
			"若目标 profile 注册不上，模组会失去连接。",
			imei, iccid),
		done: commandQueued("切换已入队"),
	}, nil
}

// commandQueued renders the gateway's answer to POST /v1/commands.
//
// It says "queued" rather than "done" because that is what happened: the
// relay is asynchronous, and a bot that reported success at enqueue time would
// be reporting something it does not know.
func commandQueued(headline string) func(Answer) string {
	return func(answer Answer) string {
		var body struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		}
		if json.Unmarshal(answer.Body, &body) != nil || body.ID == "" {
			return headline + "。"
		}
		return fmt.Sprintf("%s：%s（%s）。设备执行完在控制台看结果。",
			headline, body.ID, body.Status)
	}
}

// ── The poll loop ────────────────────────────────────────────────────────

// Source supplies the bot's configuration, re-read on every poll.
type Source func(ctx context.Context) (Config, error)

// SettingsSource reads the configuration out of a tenant's settings.
func SettingsSource(store settings.Store, tenantID string) Source {
	return func(ctx context.Context) (Config, error) {
		if store == nil {
			return Config{}, errors.New("telegram: no settings store")
		}
		document, err := store.Get(ctx, tenantID, settings.SectionNotifications)
		if err != nil {
			return Config{}, err
		}
		return ReadConfig(document), nil
	}
}

// PollTimeout is how long Telegram holds an empty getUpdates open. Long enough
// that an idle bot makes two or three requests a minute; short enough that a
// shutdown is not waiting on it for long.
const PollTimeout = 25 * time.Second

// idleBackoff is how long to wait before re-reading settings when the bot is
// switched off, and after an error.
const idleBackoff = 30 * time.Second

// Run polls Telegram until ctx is done.
//
// One goroutine, in the shape the notification dispatcher already established:
// it owns its state, it never blocks anything else, and every error it meets
// is logged and slept on rather than propagated. A bot that stopped answering
// because settings were briefly unreadable would be worse than one that
// answers late.
func (bot *Bot) Run(ctx context.Context, source Source) {
	var offset int64
	polling := false
	for {
		if ctx.Err() != nil {
			return
		}
		config, err := source(ctx)
		if err != nil {
			bot.log().Warn("telegram bot settings unreadable", "error", err)
			if !sleep(ctx, idleBackoff) {
				return
			}
			continue
		}
		if !config.Enabled {
			if polling {
				bot.log().Info("telegram bot stopped: no longer configured")
				polling = false
			}
			if !sleep(ctx, idleBackoff) {
				return
			}
			continue
		}
		if !polling {
			bot.log().Info("telegram bot polling", "operators", config.Operators())
			polling = true
		}
		updates, err := bot.fetch(ctx, config, offset)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			bot.log().Warn("telegram getUpdates failed", "error", err)
			if !sleep(ctx, idleBackoff) {
				return
			}
			continue
		}
		for _, update := range updates {
			// The offset advances whether or not handling succeeded. An update
			// that makes the handler fail would otherwise be redelivered
			// forever and fail the same way every time -- the poison-message
			// loop this system has already produced once, on the device
			// outbox, where it repeatedly took down the session.
			if update.UpdateID >= offset {
				offset = update.UpdateID + 1
			}
			bot.HandleUpdate(ctx, config, update)
		}
	}
}

func (bot *Bot) fetch(ctx context.Context, config Config, offset int64) ([]Update, error) {
	body := map[string]any{
		"timeout":         int(PollTimeout / time.Second),
		"allowed_updates": []string{"message", "callback_query"},
	}
	if offset > 0 {
		body["offset"] = offset
	}
	// Slightly past the long-poll window, so the deadline belongs to this
	// request rather than racing Telegram's own timer.
	ctx, cancel := context.WithTimeout(ctx, PollTimeout+20*time.Second)
	defer cancel()
	var updates []Update
	if err := bot.Telegram.Call(ctx, config, "getUpdates", body, &updates); err != nil {
		return nil, err
	}
	return updates, nil
}

func sleep(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
