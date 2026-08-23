package settings

import (
	"encoding/json"
	"strings"
	"testing"
)

func decode(t *testing.T, raw string) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// The console never receives a secret, so it cannot send one back. Without the
// merge, saving any notification setting would silently wipe every credential
// in the section — the failure would surface later as notifications that
// stopped arriving, with nothing in the settings page to explain it.
func TestSavingSettingsKeepsSecretsTheConsoleNeverSaw(t *testing.T) {
	t.Parallel()

	stored := decode(t, `{
		"webhook": {"enabled": true, "urls": ["https://hooks.example.com/x"], "secret": "s3cr3t"},
		"email": {"enabled": false, "password": "hunter2"}
	}`)

	shown := Redact(SectionNotifications, stored)
	if got := shown["webhook"].(map[string]any)["secret"]; got != Redacted {
		t.Fatalf("secret = %v, want it redacted", got)
	}
	// Redacting must not damage what it was given.
	if stored["webhook"].(map[string]any)["secret"] != "s3cr3t" {
		t.Fatal("Redact modified the stored document")
	}

	// The console posts back exactly what it was shown.
	merged := Merge(SectionNotifications, deepCopy(shown), stored)
	if got := merged["webhook"].(map[string]any)["secret"]; got != "s3cr3t" {
		t.Fatalf("merged secret = %v, want the stored one", got)
	}
	if got := merged["email"].(map[string]any)["password"]; got != "hunter2" {
		t.Fatalf("merged password = %v, want the stored one", got)
	}
}

// Changing a secret has to work, or it is write-only in the wrong direction.
func TestARealNewSecretReplacesTheStoredOne(t *testing.T) {
	t.Parallel()

	stored := decode(t, `{"webhook": {"enabled": true, "secret": "old"}}`)
	incoming := decode(t, `{"webhook": {"enabled": true, "secret": "new"}}`)

	merged := Merge(SectionNotifications, incoming, stored)
	if got := merged["webhook"].(map[string]any)["secret"]; got != "new" {
		t.Fatalf("secret = %v, want the new one", got)
	}
}

// The placeholder is only meaningful against something stored. Saving it when
// nothing was there would store the literal dots as the credential.
func TestThePlaceholderIsDroppedWhenNothingWasStored(t *testing.T) {
	t.Parallel()

	incoming := decode(t, `{"webhook": {"enabled": true, "secret": "`+Redacted+`"}}`)
	merged := Merge(SectionNotifications, incoming, map[string]any{})

	webhook := merged["webhook"].(map[string]any)
	if _, present := webhook["secret"]; present {
		t.Fatalf("secret = %v, want it absent", webhook["secret"])
	}
}

func TestValidationRejectsChannelsThatCannotDeliver(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		section string
		body    string
		wants   string
	}{
		{"webhook with no url", SectionNotifications,
			`{"webhook":{"enabled":true,"urls":[]}}`, "no urls"},
		{"webhook pointing nowhere", SectionNotifications,
			`{"webhook":{"enabled":true,"urls":["not a url"]}}`, "must be http or https"},
		{"email with no host", SectionNotifications,
			`{"email":{"enabled":true,"to_addresses":["a@b.c"],"smtp_port":587}}`, "no smtp_host"},
		{"email with no recipient", SectionNotifications,
			`{"email":{"enabled":true,"smtp_host":"smtp.example.com","smtp_port":587}}`, "no recipients"},
		{"email on an impossible port", SectionNotifications,
			`{"email":{"enabled":true,"smtp_host":"h","to_addresses":["a@b.c"],"smtp_port":70000}}`,
			"between 1 and 65535"},
		{"telegram with a chat but no bot", SectionNotifications,
			`{"telegram":{"enabled":true,"chat_id":"-100777"}}`, "no bot_token"},
		{"telegram with a bot but no chat", SectionNotifications,
			`{"telegram":{"enabled":true,"bot_token":"1234:AAE"}}`, "no chat_id"},
		{"feishu with no webhook", SectionNotifications,
			`{"feishu":{"enabled":true}}`, "no webhook_url"},
		{"feishu pointing nowhere", SectionNotifications,
			`{"feishu":{"enabled":true,"webhook_url":"open.feishu.cn/hook/x"}}`,
			"must be http or https"},
		{"wecom with no webhook", SectionNotifications,
			`{"wecom":{"enabled":true}}`, "no webhook_url"},
		{"pushplus with no token", SectionNotifications,
			`{"pushplus":{"enabled":true}}`, "no token"},
		{"negative rate limit", SectionSMS, `{"hourly_limit":-1}`, "zero or more"},
		{"a session that never expires", SectionSecurity,
			`{"session_ttl_hours":0}`, "between 1 and 720"},
		{"a section nobody defined", "colours", `{}`, "unknown section"},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			_, err := Validate(testCase.section, decode(t, testCase.body))
			if err == nil {
				t.Fatal("expected a rejection")
			}
			if !strings.Contains(err.Error(), testCase.wants) {
				t.Fatalf("error = %q, want it to mention %q", err, testCase.wants)
			}
		})
	}
}

// A channel that is switched off is a draft, not an error. Refusing to save it
// would mean a half-configured channel could never be put down and picked up
// again.
func TestADisabledChannelIsNotChecked(t *testing.T) {
	t.Parallel()

	if _, err := Validate(SectionNotifications,
		decode(t, `{"webhook":{"enabled":false,"urls":[]}}`)); err != nil {
		t.Fatalf("a disabled channel should save as a draft: %v", err)
	}
}

// Requiring a credential is only safe because the caller merges the stored one
// in first: the console never holds a secret, so it posts the placeholder back,
// and by the time validation runs the real value is there again. If that order
// were ever reversed, saving an unchanged telegram configuration would start
// failing with "has no bot_token" — a rejection with no field to fix.
func TestASavedCredentialSurvivesAResaveThroughTheMergeThenValidateOrder(t *testing.T) {
	t.Parallel()

	stored := decode(t, `{"telegram":{"enabled":true,"chat_id":"-100777","bot_token":"1234:AAE"}}`)
	// What the console sends back after showing the redacted form.
	incoming := decode(t, `{"telegram":{"enabled":true,"chat_id":"-100777","bot_token":"`+
		Redacted+`"}}`)

	merged := Merge(SectionNotifications, incoming, stored)
	saved, err := Validate(SectionNotifications, merged)
	if err != nil {
		t.Fatalf("resaving an unchanged channel was rejected: %v", err)
	}
	if got := saved["telegram"].(map[string]any)["bot_token"]; got != "1234:AAE" {
		t.Fatalf("bot_token = %v, want the stored one", got)
	}

	// Validating the console's document on its own must fail, which is the
	// same check seen from the other side: the placeholder is not a token.
	if _, err := Validate(SectionNotifications,
		decode(t, `{"telegram":{"enabled":true,"chat_id":"1"}}`)); err == nil {
		t.Fatal("a channel with no credential at all should be refused")
	}
}

// Every channel the console can configure is one the gateway can deliver
// through, and every stored secret belongs to one of them. The equality with
// notify.Registry() is asserted in that package, where both sides are visible;
// this end holds the list itself steady.
func TestTheNotificationChannelListCoversItsSecrets(t *testing.T) {
	t.Parallel()

	known := map[string]bool{}
	for _, channel := range NotificationChannels() {
		known[channel] = true
	}
	for _, path := range SecretPaths(SectionNotifications) {
		channel := strings.SplitN(path, ".", 2)[0]
		if !known[channel] {
			t.Fatalf("secret %q belongs to %q, which is not a configurable channel",
				path, channel)
		}
	}
	// A caller must not be able to shorten the list for everyone else.
	NotificationChannels()[0] = "mutated"
	if NotificationChannels()[0] == "mutated" {
		t.Fatal("NotificationChannels returned the package's own slice")
	}
}

// JSON has no integers, so a limit arrives as a float. A fractional one is a
// mistake worth reporting rather than truncating.
func TestWholeNumbersOnlyForCounts(t *testing.T) {
	t.Parallel()

	saved, err := Validate(SectionSMS, decode(t, `{"hourly_limit": 100}`))
	if err != nil {
		t.Fatal(err)
	}
	if saved["hourly_limit"] != 100 {
		t.Fatalf("hourly_limit = %#v, want the int 100", saved["hourly_limit"])
	}
	if _, err := Validate(SectionSMS, decode(t, `{"hourly_limit": 1.5}`)); err == nil {
		t.Fatal("a fractional limit should be refused, not truncated")
	}
}
