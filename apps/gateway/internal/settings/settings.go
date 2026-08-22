// Package settings holds the tenant-scoped configuration the console edits.
package settings

import (
	"encoding/json"
	"fmt"
	"net/url"
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
		"pushplus.token",
	},
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
	for _, channel := range []string{"webhook", "email", "bark", "telegram", "pushplus"} {
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
			parsed, err := url.Parse(raw)
			if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
				return ErrInvalid{fmt.Sprintf("webhook url %q must be http or https", raw)}
			}
			if parsed.Host == "" {
				return ErrInvalid{fmt.Sprintf("webhook url %q has no host", raw)}
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
	case "pushplus":
		// The token is a secret, so an unchanged one arrives redacted and is
		// merged in afterwards; emptiness cannot be judged here.
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
