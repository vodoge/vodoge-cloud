package commands

import (
	"encoding/json"
	"math"
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
			"usbnet mode left out",
			Request{DeviceID: "d", Kind: "set_usbnet_mode", ModemIMEI: benchIMEI},
			"usbnet_mode must be one of",
		},
		{
			"usbnet mode the module has never heard of",
			Request{
				DeviceID: "d", Kind: "set_usbnet_mode",
				ModemIMEI: benchIMEI, UsbnetMode: "ncm",
			},
			"usbnet_mode must be one of",
		},
		{
			// The operator's vocabulary reaching the wrong command. Sharing one
			// Mode field between these two would have made this request valid.
			"an operator selection mode sent to usbnet",
			Request{
				DeviceID: "d", Kind: "set_usbnet_mode",
				ModemIMEI: benchIMEI, Mode: "automatic",
			},
			"usbnet_mode must be one of",
		},
		{
			"data network with no direction",
			Request{DeviceID: "d", Kind: "set_data_network", ModemIMEI: benchIMEI},
			"enabled must be given explicitly",
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

// Every mode the contract offers has to survive validation. A typo in the
// allowed set would show up as one button that never works, which is the kind
// of thing that gets found by a customer rather than by a test.
func TestEveryUsbnetModeTheContractOffersIsAccepted(t *testing.T) {
	t.Parallel()

	for _, mode := range []string{"rmnet", "ecm", "mbim", "rndis"} {
		_, payload, err := BuildPayload(Request{
			DeviceID: "d", Kind: "set_usbnet_mode", ModemIMEI: benchIMEI, UsbnetMode: mode,
		})
		if err != nil {
			t.Fatalf("%s: %v", mode, err)
		}
		var decoded map[string]any
		if err := json.Unmarshal(payload, &decoded); err != nil {
			t.Fatalf("%s: %v", mode, err)
		}
		// The console's field is usbnet_mode; the contract's is mode.
		if decoded["mode"] != mode {
			t.Fatalf("%s produced mode %v", mode, decoded["mode"])
		}
	}
}

// A rescan is about the module that has not been seen yet, so requiring the
// IMEI of one would make the command useless exactly when it is wanted.
func TestARescanDoesNotNeedAModem(t *testing.T) {
	t.Parallel()

	spec, payload, err := BuildPayload(Request{DeviceID: "d", Kind: "refresh_modems"})
	if err != nil {
		t.Fatal(err)
	}
	if spec.NeedsModem {
		t.Fatal("refresh_modems must not require an imei")
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if _, named := decoded["modem_imei"]; named {
		t.Fatalf("payload names a modem: %v", decoded)
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
		request.UsbnetMode = "rmnet"
		request.Version = "0.2.0"
		request.URL = "https://releases.example.com/vodoge-edge"
		request.SHA256 = strings.Repeat("a", 64)
		request.Signature = strings.Repeat("s", 32)
		// Zero on purpose: it is a real sequence number, and a build that
		// treated it as "not given" would fail here rather than in the field.
		sequence := int64(0)
		request.SequenceNumber = &sequence
		request.ActivationCode = "LPA:1$smdp.example.com$QQ111-22222-33333-44444"
		// One is a real context and the other a real APN: configure_apn
		// addresses a row on the module, and a zero cid is not one.
		cid := 1
		request.CID = &cid
		request.APN = "cmnet"
		request.CandidateKey = "usb-1-3:1.2"
		request.ProfileICCID = "89852351225042214201"
		nickname := "bench"
		request.Nickname = &nickname
		// create_modem 要它，而且是**必填**：它建的那一根 agent 从没观测过，
		// 型号推不出来，而闸按 (型号 × 运营商) 查规则。留空建出来的是一条
		// 永远过不了闸的记录，所以校验在 Build 里而不是靠调用方自觉。
		request.Family = "EC20"

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

	// refresh_modems asks the edge to look at /dev, which is what its poll
	// loop does every eight seconds regardless. Nothing on the device
	// changes, so confirming it would be noise.
	//
	// read_esim_info and retrieve_esim_notification both talk to the eUICC and
	// both only read it: the chip's identity, its capabilities, and the
	// notifications it still owes an SM-DP+. Marking either of them mutating
	// would put a confirmation prompt in front of a reading.
	//
	// initiate_esim_authentication reaches a real SM-DP+, which sounds like it
	// belongs on the other list, but the function it calls needs no activation
	// code and leaves nothing behind at either end: a challenge out, a signed
	// answer back, and no profile and no notification move.
	//
	// read_logs returns the agent's own recent output. It touches no module at
	// all, and putting a confirmation in front of reading a log is how an
	// operator stops reading logs.
	readOnly := map[string]bool{
		"modem_report": true, "list_esim_profiles": true, "refresh_modems": true,
		"read_esim_info": true, "retrieve_esim_notification": true,
		"initiate_esim_authentication": true, "read_logs": true,
	}
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

// Zero is a sequence number, not a missing field.
//
// Both eUICCs on the bench report their oldest pending notification as
// seqNumber 0, so a validator that read an absent field as zero would silently
// fetch the wrong notification, and one that rejected zero would make the most
// common one unreachable.
func TestARetrievalTellsAnAbsentSequenceNumberFromZero(t *testing.T) {
	t.Parallel()

	if _, _, err := BuildPayload(Request{
		DeviceID: "d", Kind: "retrieve_esim_notification", ModemIMEI: benchIMEI,
	}); err == nil {
		t.Fatal("an omitted sequence_number must be refused, not read as zero")
	}

	zero := int64(0)
	_, payload, err := BuildPayload(Request{
		DeviceID: "d", Kind: "retrieve_esim_notification",
		ModemIMEI: benchIMEI, SequenceNumber: &zero,
	})
	if err != nil {
		t.Fatalf("explicit zero: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["sequence_number"] != float64(0) {
		t.Fatalf("sequence_number = %v, want 0", decoded["sequence_number"])
	}
	if decoded["kind"] != "RetrieveEsimNotification" {
		t.Fatalf("kind = %v", decoded["kind"])
	}

	// Outside what the contract's integer range allows, refused here rather
	// than by the edge minutes later.
	for _, bad := range []int64{-1, math.MaxInt32 + 1} {
		value := bad
		if _, _, err := BuildPayload(Request{
			DeviceID: "d", Kind: "retrieve_esim_notification",
			ModemIMEI: benchIMEI, SequenceNumber: &value,
		}); err == nil {
			t.Fatalf("sequence_number %d was accepted", bad)
		}
	}
}

// A chip reading names the modem it is about.
//
// An eUICC command with no IMEI would be sent to whichever module the edge
// picked first, and on this bench that is not even always an eUICC.
func TestReadingAChipNamesItsModem(t *testing.T) {
	t.Parallel()

	spec, payload, err := BuildPayload(Request{
		DeviceID: "d", Kind: "read_esim_info", ModemIMEI: benchIMEI,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !spec.NeedsModem {
		t.Fatal("read_esim_info must name a modem")
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["modem_imei"] != benchIMEI {
		t.Fatalf("modem_imei = %v", decoded["modem_imei"])
	}
	if _, _, err := BuildPayload(Request{DeviceID: "d", Kind: "read_esim_info"}); err == nil {
		t.Fatal("a chip reading with no imei was accepted")
	}
}

// The SM-DP+ address is optional, and an omitted one is not an empty one.
//
// The normal path is to let the edge ask the chip: on both bench eUICCs
// GetEuiccConfiguredAddresses returns no default SM-DP+, so the address comes
// off a pending notification. Sending "smdp_address": "" instead of omitting
// the field would fail the contract's pattern at the edge, minutes later, as
// something that reads like a DNS problem.
func TestAnAbsentSmdpAddressMeansAskTheChip(t *testing.T) {
	t.Parallel()

	_, payload, err := BuildPayload(Request{
		DeviceID: "d", Kind: "initiate_esim_authentication", ModemIMEI: benchIMEI,
	})
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if _, present := decoded["smdp_address"]; present {
		t.Fatalf("an omitted address became %v", decoded["smdp_address"])
	}

	_, payload, err = BuildPayload(Request{
		DeviceID: "d", Kind: "initiate_esim_authentication", ModemIMEI: benchIMEI,
		SmdpAddress: "  wbg.prod.ondemandconnectivity.com  ",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["smdp_address"] != "wbg.prod.ondemandconnectivity.com" {
		t.Fatalf("smdp_address = %v", decoded["smdp_address"])
	}
}

// An address that is not a host name is refused here rather than at the edge.
func TestAnUnusableSmdpAddressIsRefused(t *testing.T) {
	t.Parallel()

	for _, address := range []string{
		"https://wbg.prod.ondemandconnectivity.com",
		"wbg.prod.ondemandconnectivity.com/gsma",
		"localhost",
		"-leading.dash.example.com",
		"has space.example.com",
	} {
		if _, _, err := BuildPayload(Request{
			DeviceID: "d", Kind: "initiate_esim_authentication", ModemIMEI: benchIMEI,
			SmdpAddress: address,
		}); err == nil {
			t.Fatalf("%q was accepted as an SM-DP+ address", address)
		}
	}
}

// Downloading a profile is the one action here that cannot be undone from the
// console, so a code that cannot possibly work is refused while the operator
// is still on the page rather than at an SM-DP+ that may consume the order.
func TestAnActivationCodeIsCheckedBeforeItLeaves(t *testing.T) {
	t.Parallel()

	good := []string{
		"LPA:1$smdp.example.com$QQ111-22222-33333-44444",
		"1$smdp.example.com$QQ111-22222-33333-44444",
		"1$smdp.example.com$AAAA$1.3.6.1.4.1.31746",
		"1$smdp.example.com$AAAA$$1",
	}
	for _, code := range good {
		if _, _, err := BuildPayload(Request{
			DeviceID: "d", Kind: "download_esim_profile", ModemIMEI: benchIMEI,
			ActivationCode: code,
		}); err != nil {
			t.Fatalf("%q was refused: %v", code, err)
		}
	}

	bad := []string{
		"",
		"QQ111-22222-33333-44444",
		"LPA:2$smdp.example.com$AAAA",
		"1$smdp.example.com",
		"1$smdp.example.com$AAAA BBBB",
		"https://smdp.example.com/AAAA",
	}
	for _, code := range bad {
		if _, _, err := BuildPayload(Request{
			DeviceID: "d", Kind: "download_esim_profile", ModemIMEI: benchIMEI,
			ActivationCode: code,
		}); err == nil {
			t.Fatalf("%q was accepted as an activation code", code)
		}
	}
}

// A refusal must not repeat the code back. An activation code in an error
// message is an activation code in a log, and this one is a credential that
// can be spent exactly once.
func TestARefusedActivationCodeIsNotEchoed(t *testing.T) {
	t.Parallel()

	const secret = "1$smdp.example.com$SECRET MATCHING ID"
	_, _, err := BuildPayload(Request{
		DeviceID: "d", Kind: "download_esim_profile", ModemIMEI: benchIMEI,
		ActivationCode: secret,
	})
	if err == nil {
		t.Fatal("expected a refusal")
	}
	if strings.Contains(err.Error(), "SECRET") {
		t.Fatalf("the refusal repeated the code: %v", err)
	}
}

// An omitted confirmation code is absent from the payload rather than empty.
// The contract gives it a minimum length, so an empty string would be rejected
// at the edge as a malformed envelope instead of as a field nobody set.
func TestAnAbsentConfirmationCodeIsOmitted(t *testing.T) {
	t.Parallel()

	_, payload, err := BuildPayload(Request{
		DeviceID: "d", Kind: "download_esim_profile", ModemIMEI: benchIMEI,
		ActivationCode: "1$smdp.example.com$AAAA", ConfirmationCode: "  ",
	})
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if _, present := decoded["confirmation_code"]; present {
		t.Fatalf("confirmation_code should be absent, got %v", decoded)
	}
	if decoded["activation_code"] != "1$smdp.example.com$AAAA" {
		t.Fatalf("activation_code = %v", decoded["activation_code"])
	}

	_, payload, err = BuildPayload(Request{
		DeviceID: "d", Kind: "download_esim_profile", ModemIMEI: benchIMEI,
		ActivationCode: "1$smdp.example.com$AAAA", ConfirmationCode: "13572468",
	})
	if err != nil {
		t.Fatal(err)
	}
	decoded = map[string]any{}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["confirmation_code"] != "13572468" {
		t.Fatalf("confirmation_code = %v", decoded["confirmation_code"])
	}
}

// A context identifier is the whole address of the thing being rewritten, so
// an absent one must not arrive as 0 and be rejected for its value: the two
// faults read the same in a log and mean different things to whoever sent it.
func TestConfigureApnNeedsAContextItCanAddress(t *testing.T) {
	t.Parallel()

	if _, _, err := BuildPayload(Request{
		DeviceID: "d", Kind: "configure_apn", ModemIMEI: benchIMEI, APN: "cmnet",
	}); err == nil {
		t.Fatal("an omitted cid was accepted")
	}
	for _, cid := range []int{0, 16, 255} {
		if _, _, err := BuildPayload(Request{
			DeviceID: "d", Kind: "configure_apn", ModemIMEI: benchIMEI,
			APN: "cmnet", CID: &cid,
		}); err == nil {
			t.Fatalf("cid %d is outside what the contract allows and was accepted", cid)
		}
	}
}

// Every method the contract offers has to survive validation, and one it does
// not must not. `pap_or_chap` is the one only AT+QICSGP can express -- the
// +CGAUTH on the module that has it stops at 2 -- so it is the one most likely
// to be left out of an allowed set written from the standard.
func TestConfigureApnAcceptsEveryAuthenticationTheContractOffers(t *testing.T) {
	t.Parallel()

	cid := 1
	for _, auth := range []string{"none", "pap", "chap", "pap_or_chap"} {
		_, payload, err := BuildPayload(Request{
			DeviceID: "d", Kind: "configure_apn", ModemIMEI: benchIMEI,
			APN: "cmnet", CID: &cid, Auth: auth,
		})
		if err != nil {
			t.Fatalf("%s: %v", auth, err)
		}
		var decoded map[string]any
		if err := json.Unmarshal(payload, &decoded); err != nil {
			t.Fatal(err)
		}
		if decoded["auth"] != auth {
			t.Fatalf("auth = %v, want %s", decoded["auth"], auth)
		}
	}
	if _, _, err := BuildPayload(Request{
		DeviceID: "d", Kind: "configure_apn", ModemIMEI: benchIMEI,
		APN: "cmnet", CID: &cid, Auth: "eap",
	}); err == nil {
		t.Fatal("an invented authentication method was accepted")
	}
}

// Clearing a username is how a context stops authenticating, so naming one
// half of the pair has to send both -- a payload carrying a new username and
// keeping the old password is a context nobody asked for.
func TestConfigureApnSendsBothHalvesOfACredential(t *testing.T) {
	t.Parallel()

	cid := 2
	user := "user"
	_, payload, err := BuildPayload(Request{
		DeviceID: "d", Kind: "configure_apn", ModemIMEI: benchIMEI,
		APN: "cmnet", CID: &cid, Username: &user,
	})
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["username"] != "user" {
		t.Fatalf("username = %v", decoded["username"])
	}
	// 🔴 The password must NOT ride along: the edge reads an absent one as
	// "keep what the module has", and sending "" here would clear a password
	// on every username edit.
	if _, present := decoded["password"]; present {
		t.Fatal("changing a username sent a password the caller never named")
	}

	// An explicit empty string is how a credential is cleared, and it has to
	// survive as one rather than being dropped for being empty.
	blank := ""
	_, cleared, err := BuildPayload(Request{
		DeviceID: "d", Kind: "configure_apn", ModemIMEI: benchIMEI,
		APN: "cmnet", CID: &cid, Password: &blank,
	})
	if err != nil {
		t.Fatal(err)
	}
	var clearing map[string]any
	if err := json.Unmarshal(cleared, &clearing); err != nil {
		t.Fatal(err)
	}
	password, present := clearing["password"]
	if !present || password != "" {
		t.Fatalf("password = %v (present %v), want an explicit empty string", password, present)
	}

	// And a request naming neither carries neither, so an edit that only
	// changes the APN does not blank credentials the context already had.
	_, bare, err := BuildPayload(Request{
		DeviceID: "d", Kind: "configure_apn", ModemIMEI: benchIMEI,
		APN: "cmnet", CID: &cid,
	})
	if err != nil {
		t.Fatal(err)
	}
	var plain map[string]any
	if err := json.Unmarshal(bare, &plain); err != nil {
		t.Fatal(err)
	}
	if _, present := plain["username"]; present {
		t.Fatal("a request naming no credential still sent one")
	}
	if _, present := plain["password"]; present {
		t.Fatal("a request naming no credential still sent one")
	}
}
