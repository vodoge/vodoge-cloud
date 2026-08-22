package commands

import (
	"encoding/json"
	"strings"
	"testing"
)

const benchIMEI = "867018069514820"

// A malformed command must be refused here, not queued and then failed at the
// edge minutes later with a reason the console has to hunt for.
func TestValidationRejectsWhatTheEdgeCannotRun(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		request Request
		wants   string
	}{
		{
			"unknown kind",
			Request{DeviceID: "d", Kind: "make_coffee"},
			"unsupported command kind",
		},
		{
			"no device",
			Request{Kind: "modem_report", ModemIMEI: benchIMEI},
			"device_id is required",
		},
		{
			"imei that is not an imei",
			Request{DeviceID: "d", Kind: "modem_report", ModemIMEI: "867018"},
			"modem_imei must be 15 digits",
		},
		{
			"at command that is not one",
			Request{DeviceID: "d", Kind: "run_at_command", ModemIMEI: benchIMEI, Command: "reboot"},
			"must start with AT",
		},
		{
			"manual operator selection with no operator",
			Request{DeviceID: "d", Kind: "select_operator", ModemIMEI: benchIMEI, Mode: "manual"},
			"needs a plmn",
		},
		{
			"ussd with no code",
			Request{DeviceID: "d", Kind: "send_ussd", ModemIMEI: benchIMEI},
			"code is required",
		},
		{
			"sms to something that is not a number",
			Request{DeviceID: "d", Kind: "send_sms", ModemIMEI: benchIMEI, To: "not-a-number", Body: "hi"},
			"must be a phone number",
		},
		{
			"profile switch to a non-ICCID",
			Request{DeviceID: "d", Kind: "switch_esim_profile", ModemIMEI: benchIMEI, TargetICCID: "1234"},
			"19 or 20 digits",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			_, _, err := BuildPayload(testCase.request)
			if err == nil {
				t.Fatal("expected a rejection")
			}
			if !strings.Contains(err.Error(), testCase.wants) {
				t.Fatalf("error = %q, want it to mention %q", err, testCase.wants)
			}
		})
	}
}

// Turning a radio off because a field was absent is the one mistake this must
// never make, so absent and false are kept apart.
func TestSetRadioNeedsAnExplicitValue(t *testing.T) {
	t.Parallel()

	if _, _, err := BuildPayload(Request{
		DeviceID: "d", Kind: "set_radio", ModemIMEI: benchIMEI,
	}); err == nil {
		t.Fatal("an omitted `enabled` must be refused, not read as off")
	}

	off := false
	_, payload, err := BuildPayload(Request{
		DeviceID: "d", Kind: "set_radio", ModemIMEI: benchIMEI, Enabled: &off,
	})
	if err != nil {
		t.Fatalf("explicit false: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["enabled"] != false {
		t.Fatalf("enabled = %v, want false", decoded["enabled"])
	}
}

// The payload the edge receives has to name a contract command kind, not the
// console's snake_case one.
func TestPayloadsUseTheContractKind(t *testing.T) {
	t.Parallel()

	for _, kind := range Kinds() {
		spec, _ := Lookup(kind)
		request := Request{DeviceID: "d", Kind: kind, ModemIMEI: benchIMEI}
		// Fill whatever each command additionally requires.
		enabled := true
		request.Enabled = &enabled
		request.To, request.Body = "+8613800138000", "hello"
		request.Command = "AT+CSQ"
		request.Code = "*101#"
		request.TargetICCID = "89852351225042214201"
		request.Version = "0.2.0"
		request.URL = "https://releases.example.com/vodoge-edge"
		request.SHA256 = strings.Repeat("a", 64)
		request.Signature = strings.Repeat("s", 32)

		_, payload, err := BuildPayload(request)
		if err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		var decoded map[string]any
		if err := json.Unmarshal(payload, &decoded); err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		if decoded["kind"] != spec.ContractKind {
			t.Fatalf("%s produced kind %v, want %s", kind, decoded["kind"], spec.ContractKind)
		}
	}
}

// An omitted kind still means SMS: the first version of this endpoint only
// sent SMS and callers still leave the field out.
func TestAnOmittedKindIsStillSms(t *testing.T) {
	t.Parallel()

	spec, _, err := BuildPayload(Request{
		DeviceID: "d", ModemIMEI: benchIMEI, To: "10086", Body: "ye",
	})
	if err != nil {
		t.Fatal(err)
	}
	if spec.Kind != "send_sms" {
		t.Fatalf("kind = %s, want send_sms", spec.Kind)
	}
}

// Read-only actions must not be marked mutating: the console asks for
// confirmation based on this flag, and a confirmation prompt on every signal
// reading trains people to click through them.
func TestOnlyStateChangingActionsAreMutating(t *testing.T) {
	t.Parallel()

	readOnly := map[string]bool{"modem_report": true, "list_esim_profiles": true}
	// rotate_ip drops the data session, so it belongs with the disruptive
	// actions even though it reads as a small thing.
	// rotate_ip drops the data session, so it belongs with the disruptive
	// actions even though it reads as a small thing.
	for _, kind := range Kinds() {
		spec, _ := Lookup(kind)
		if readOnly[kind] && spec.Mutating {
			t.Fatalf("%s reads only but is marked mutating", kind)
		}
		if !readOnly[kind] && !spec.Mutating {
			t.Fatalf("%s changes the device but is not marked mutating", kind)
		}
	}
}


// A self-update points a fleet at a binary it will execute. Every field is
// checked, because the failure mode is every device installing the wrong
// thing at once.
func TestSelfUpdateRefusesAnythingUnverifiable(t *testing.T) {
	t.Parallel()

	good := Request{
		DeviceID: "d", Kind: "self_update", Version: "0.2.0",
		URL:       "https://releases.example.com/vodoge-edge",
		SHA256:    strings.Repeat("a", 64),
		Signature: strings.Repeat("s", 32),
	}
	if _, _, err := BuildPayload(good); err != nil {
		t.Fatalf("a complete request was refused: %v", err)
	}

	cases := map[string]func(*Request){
		"no version":       func(r *Request) { r.Version = "" },
		"plain http":       func(r *Request) { r.URL = "http://releases.example.com/x" },
		"digest too short": func(r *Request) { r.SHA256 = "abc" },
		"digest not hex":   func(r *Request) { r.SHA256 = strings.Repeat("z", 64) },
		"no signature":     func(r *Request) { r.Signature = "" },
	}
	for name, break_ := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			request := good
			break_(&request)
			if _, _, err := BuildPayload(request); err == nil {
				t.Fatal("expected a rejection")
			}
		})
	}
}
