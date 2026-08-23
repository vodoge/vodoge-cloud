// Package settings holds the tenant-scoped configuration the console edits.
package settings

import (
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// Section names, matching the database's CHECK constraint.
const (
	SectionNotifications = "notifications"
	SectionSMS           = "sms"
	SectionSecurity      = "security"
	SectionDevices       = "devices"
)

// Sections lists every section, in the order the console renders them.
func Sections() []string {
	return []string{SectionNotifications, SectionSMS, SectionSecurity, SectionDevices}
}

// notificationChannels is every channel the notifications section can hold
// configuration for.
//
// This list is one half of a pair: the gateway must have a sender for each of
// these names, or the console offers a form that quietly does nothing when
// saved. That is not hypothetical — telegram and pushplus had slots here, and
// redaction rules for their credentials, for as long as the section has
// existed, with no sender behind either. Nothing complained; notifications
// simply never arrived. notify.Registry() is the other half, and a test in that
// package compares the two sets.
var notificationChannels = []string{
	"webhook", "email", "bark", "telegram", "feishu", "wecom", "pushplus",
}

// NotificationChannels lists the channel keys the notifications section
// accepts, in the order the console renders them.
func NotificationChannels() []string {
	return append([]string(nil), notificationChannels...)
}

// Redacted is what a stored secret looks like on the way out, and what the
// console sends back to mean "leave it alone".
//
// Returning a webhook secret or an SMTP password to the browser so it can be
// posted back unchanged would put a credential in a page's HTML on every
// visit. This keeps secrets write-only from the console's point of view.
const Redacted = "••••••••"

// A stored secret's field path, as section plus dotted key. Only these are
// redacted on read and preserved on write.
var secretFields = map[string][]string{
	SectionNotifications: {
		"webhook.secret",
		"email.password",
		"bark.token",
		"telegram.bot_token",
		"feishu.secret",
		"pushplus.token",
	},
}

// SecretPaths lists a section's stored secrets, as section-relative dotted
// paths. Exported so the notify package's drift test can check that every
// redaction rule belongs to a channel that still exists.
func SecretPaths(section string) []string {
	return append([]string(nil), secretFields[section]...)
}

// ErrInvalid explains a rejected settings document to whoever sent it.
type ErrInvalid struct{ Reason string }

func (err ErrInvalid) Error() string { return err.Reason }

// Validate checks one section's document and returns the canonical form to
// store.
//
// Validation is deliberately shallow: it rejects what cannot work — a webhook
// with no URL, a negative rate limit — and leaves the rest alone. Enumerating
// every optional field here would mean a code change for each one, which is
// the cost the jsonb column exists to avoid.
func Validate(section string, document map[string]any) (map[string]any, error) {
	switch section {
	case SectionNotifications:
		return validateNotifications(document)
	case SectionSMS:
		return validateSMS(document)
	case SectionSecurity:
		return validateSecurity(document)
	case SectionDevices:
		// No constrained fields yet. The section exists so a deployment can
		// hold device defaults without another migration.
		return document, nil
	default:
		return nil, ErrInvalid{fmt.Sprintf(
			"unknown section %q, expected one of %s", section, strings.Join(Sections(), ", "))}
	}
}

func validateNotifications(document map[string]any) (map[string]any, error) {
	// Checked whether or not the telegram channel itself is switched on: the
	// bot and the outbound channel share a token but are independent
	// features, and a deployment may well want one without the other.
	if err := validateTelegramBot(document); err != nil {
		return nil, err
	}
	for _, channel := range notificationChannels {
		raw, present := document[channel]
		if !present {
			continue
		}
		config, ok := raw.(map[string]any)
		if !ok {
			return nil, ErrInvalid{fmt.Sprintf("%s must be an object", channel)}
		}
		// A channel that is switched off is not checked: half-filled settings
		// for a disabled channel are a draft, not an error.
		if enabled, _ := config["enabled"].(bool); !enabled {
			continue
		}
		if err := validateEnabledChannel(channel, config); err != nil {
			return nil, err
		}
	}
	return document, nil
}

func validateEnabledChannel(channel string, config map[string]any) error {
	switch channel {
	case "webhook":
		urls := stringList(config["urls"])
		if len(urls) == 0 {
			return ErrInvalid{"webhook is enabled but has no urls"}
		}
		for _, raw := range urls {
			if err := checkHTTPURL("webhook", "url", raw); err != nil {
				return err
			}
		}
	case "email":
		if asString(config["smtp_host"]) == "" {
			return ErrInvalid{"email is enabled but has no smtp_host"}
		}
		if len(stringList(config["to_addresses"])) == 0 {
			return ErrInvalid{"email is enabled but has no recipients"}
		}
		port, ok := asInt(config["smtp_port"])
		if !ok || port <= 0 || port > 65535 {
			return ErrInvalid{"smtp_port must be between 1 and 65535"}
		}
	case "bark":
		if len(stringList(config["urls"])) == 0 {
			return ErrInvalid{"bark is enabled but has no urls"}
		}
	case "telegram":
		if asString(config["chat_id"]) == "" {
			return ErrInvalid{"telegram is enabled but has no chat_id"}
		}
		// Secrets are merged in before validation runs, so an empty one here
		// means nothing was ever stored — the tenant enabled a channel that
		// cannot send. Saying so at the point of saving is the whole reason
		// this section is validated at all.
		if asString(config["bot_token"]) == "" {
			return ErrInvalid{"telegram is enabled but has no bot_token"}
		}
	case "feishu":
		raw := asString(config["webhook_url"])
		if raw == "" {
			return ErrInvalid{"feishu is enabled but has no webhook_url"}
		}
		if err := checkHTTPURL("feishu", "webhook_url", raw); err != nil {
			return err
		}
	case "wecom":
		raw := asString(config["webhook_url"])
		if raw == "" {
			return ErrInvalid{"wecom is enabled but has no webhook_url"}
		}
		if err := checkHTTPURL("wecom", "webhook_url", raw); err != nil {
			return err
		}
	case "pushplus":
		if asString(config["token"]) == "" {
			return ErrInvalid{"pushplus is enabled but has no token"}
		}
	}
	return nil
}

// ── Telegram bot ─────────────────────────────────────────────────────────

// TelegramOperator maps one Telegram account to a console account.
//
// The bot is a second front door to the same API the console serves, so the
// question "who is this" has to have the same answer on both. The bot does not
// get a permission model of its own: a chat names an account, the account
// carries the role, and every action is performed as that account. A chat that
// names nothing is nobody.
type TelegramOperator struct {
	// ChatID is the sender's numeric Telegram id, which in a private chat is
	// also the chat id. It is matched against the sender of a message rather
	// than the conversation it arrived in, so putting the bot in a group does
	// not hand the group whatever the group's id happened to be mapped to.
	ChatID string
	// Email is the console account this chat acts as. It has to exist and be
	// active; the bot resolves it at the moment of use instead of caching a
	// role, so disabling the account disables the chat with it.
	Email string
}

// One stored mapping is the line "<telegram id>=<email>".
//
// A list of strings rather than a list of objects because the settings form
// renders a jsonb document through a fixed set of field kinds and a string
// list is one of them; a richer shape would have meant changing the shared
// form component for this one field.
var (
	telegramChatPattern  = regexp.MustCompile(`^-?[0-9]{1,20}$`)
	telegramEmailPattern = regexp.MustCompile(`^[^\s@]+@[^\s@]+$`)
)

// TelegramOperators parses notifications.telegram.bot.operators.
//
// Exported so the bot and this package's validation read the mapping through
// the same code. Two parsers for one authorisation table is how a chat ends up
// authorised by the thing that saves it and unrecognised by the thing that
// checks it, or the reverse.
func TelegramOperators(notifications map[string]any) ([]TelegramOperator, error) {
	bot, ok := telegramBotBlock(notifications)
	if !ok {
		return nil, nil
	}
	raw, present := bot["operators"]
	if !present || raw == nil {
		return nil, nil
	}
	items, ok := raw.([]any)
	if !ok {
		return nil, ErrInvalid{
			`telegram bot operators must be a list of "<telegram id>=<account email>" lines`}
	}
	seen := map[string]string{}
	out := make([]TelegramOperator, 0, len(items))
	for _, item := range items {
		line := strings.TrimSpace(asString(item))
		if line == "" {
			continue
		}
		chatID, email, found := strings.Cut(line, "=")
		chatID = strings.TrimSpace(chatID)
		email = strings.ToLower(strings.TrimSpace(email))
		if !found ||
			!telegramChatPattern.MatchString(chatID) ||
			!telegramEmailPattern.MatchString(email) {
			return nil, ErrInvalid{fmt.Sprintf(
				`telegram bot operator %q must read "<telegram id>=<account email>"`, line)}
		}
		// Two accounts for one chat is an ambiguous identity, and resolving it
		// either way would be choosing a privilege level by accident.
		if previous, clash := seen[chatID]; clash {
			if previous != email {
				return nil, ErrInvalid{fmt.Sprintf(
					"telegram bot operator %s is mapped to two accounts", chatID)}
			}
			continue
		}
		seen[chatID] = email
		out = append(out, TelegramOperator{ChatID: chatID, Email: email})
	}
	return out, nil
}

// TelegramBotEnabled reports whether the tenant asked for the bot to run.
func TelegramBotEnabled(notifications map[string]any) bool {
	bot, ok := telegramBotBlock(notifications)
	if !ok {
		return false
	}
	enabled, _ := bot["enabled"].(bool)
	return enabled
}

// TelegramBotToken returns the credential the bot and the notification channel
// share. One bot, one token: a second slot would mean two things to rotate.
func TelegramBotToken(notifications map[string]any) string {
	channel, ok := notifications["telegram"].(map[string]any)
	if !ok {
		return ""
	}
	return asString(channel["bot_token"])
}

// TelegramAPIBase returns the endpoint override a test, or a tenant behind a
// relay, may set. Absent, the real service is used.
func TelegramAPIBase(notifications map[string]any) string {
	channel, ok := notifications["telegram"].(map[string]any)
	if !ok {
		return ""
	}
	return asString(channel["api_base"])
}

func telegramBotBlock(notifications map[string]any) (map[string]any, bool) {
	channel, ok := notifications["telegram"].(map[string]any)
	if !ok {
		return nil, false
	}
	bot, ok := channel["bot"].(map[string]any)
	return bot, ok
}

// validateTelegramBot refuses a bot configuration that cannot work.
//
// An enabled bot with no operators is the case worth naming: it would poll,
// answer every message with a refusal, and read as a broken bot rather than an
// unfinished setting.
func validateTelegramBot(document map[string]any) error {
	channel, ok := document["telegram"].(map[string]any)
	if !ok {
		return nil
	}
	bot, present := telegramBotBlock(document)
	if !present {
		if channel["bot"] != nil {
			return ErrInvalid{"telegram bot must be an object"}
		}
		return nil
	}
	operators, err := TelegramOperators(document)
	if err != nil {
		return err
	}
	if enabled, _ := bot["enabled"].(bool); !enabled {
		return nil
	}
	if len(operators) == 0 {
		return ErrInvalid{"telegram bot is enabled but has no operators"}
	}
	// Secrets are merged in before validation runs, so an empty one here means
	// nothing was ever stored -- the tenant enabled a bot that cannot speak.
	if TelegramBotToken(document) == "" {
		return ErrInvalid{"telegram bot is enabled but has no bot_token"}
	}
	return nil
}

// checkHTTPURL rejects an address nothing could be posted to. A channel whose
// URL has no scheme fails at delivery time with an error that reads like a
// network fault, hours after the person who typed it has moved on.
func checkHTTPURL(channel, field, raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return ErrInvalid{fmt.Sprintf("%s %s %q must be http or https", channel, field, raw)}
	}
	if parsed.Host == "" {
		return ErrInvalid{fmt.Sprintf("%s %s %q has no host", channel, field, raw)}
	}
	return nil
}

func validateSMS(document map[string]any) (map[string]any, error) {
	if raw, present := document["hourly_limit"]; present {
		limit, ok := asInt(raw)
		if !ok || limit < 0 {
			return nil, ErrInvalid{"hourly_limit must be zero or more, where zero means no limit"}
		}
		document["hourly_limit"] = limit
	}
	return document, nil
}

func validateSecurity(document map[string]any) (map[string]any, error) {
	if raw, present := document["session_ttl_hours"]; present {
		hours, ok := asInt(raw)
		// A session that never expires is not a setting anyone should be able
		// to choose from a web form.
		if !ok || hours < 1 || hours > 720 {
			return nil, ErrInvalid{"session_ttl_hours must be between 1 and 720"}
		}
		document["session_ttl_hours"] = hours
	}
	return document, nil
}

// Redact replaces stored secrets with a placeholder for the console.
func Redact(section string, document map[string]any) map[string]any {
	paths, ok := secretFields[section]
	if !ok {
		return document
	}
	clone := deepCopy(document)
	for _, path := range paths {
		if value, found := lookup(clone, path); found && asString(value) != "" {
			set(clone, path, Redacted)
		}
	}
	return clone
}

// Merge carries stored secrets into an incoming document wherever the console
// sent the placeholder back untouched.
//
// Without this, saving any notification setting would wipe every secret in the
// section, because the console never had them to send.
func Merge(section string, incoming, stored map[string]any) map[string]any {
	paths, ok := secretFields[section]
	if !ok {
		return incoming
	}
	for _, path := range paths {
		value, found := lookup(incoming, path)
		if !found || asString(value) != Redacted {
			continue
		}
		if previous, had := lookup(stored, path); had {
			set(incoming, path, previous)
		} else {
			// Nothing was stored, so the placeholder means nothing. Removing
			// it stops the literal dots from being saved as the secret.
			unset(incoming, path)
		}
	}
	return incoming
}

func lookup(document map[string]any, path string) (any, bool) {
	keys := strings.Split(path, ".")
	cursor := document
	for _, key := range keys[:len(keys)-1] {
		next, ok := cursor[key].(map[string]any)
		if !ok {
			return nil, false
		}
		cursor = next
	}
	value, ok := cursor[keys[len(keys)-1]]
	return value, ok
}

func set(document map[string]any, path string, value any) {
	keys := strings.Split(path, ".")
	cursor := document
	for _, key := range keys[:len(keys)-1] {
		next, ok := cursor[key].(map[string]any)
		if !ok {
			next = map[string]any{}
			cursor[key] = next
		}
		cursor = next
	}
	cursor[keys[len(keys)-1]] = value
}

func unset(document map[string]any, path string) {
	keys := strings.Split(path, ".")
	cursor := document
	for _, key := range keys[:len(keys)-1] {
		next, ok := cursor[key].(map[string]any)
		if !ok {
			return
		}
		cursor = next
	}
	delete(cursor, keys[len(keys)-1])
}

func deepCopy(document map[string]any) map[string]any {
	encoded, err := json.Marshal(document)
	if err != nil {
		return document
	}
	var clone map[string]any
	if err := json.Unmarshal(encoded, &clone); err != nil {
		return document
	}
	return clone
}

func asString(value any) string {
	text, _ := value.(string)
	return text
}

// asInt accepts what JSON decoding produces for a whole number, which is a
// float64 — and rejects a fractional one rather than truncating it.
func asInt(value any) (int, bool) {
	switch typed := value.(type) {
	case float64:
		if typed != float64(int(typed)) {
			return 0, false
		}
		return int(typed), true
	case int:
		return typed, true
	case json.Number:
		parsed, err := typed.Int64()
		if err != nil {
			return 0, false
		}
		return int(parsed), true
	default:
		return 0, false
	}
}

func stringList(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if text := asString(item); text != "" {
			out = append(out, text)
		}
	}
	return out
}
