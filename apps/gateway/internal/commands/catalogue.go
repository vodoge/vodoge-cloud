package commands

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strings"
)

// Every action the console can ask a device to perform.
//
// The handler used to carry a two-case switch with a body struct whose `to`
// field meant a phone number for one command and an IMEI for the other. Adding
// the panel's remaining actions that way would have produced a switch nobody
// could read and errors nobody could act on, so each command declares what it
// needs and validates itself.
//
// Validation happens here rather than at the edge because a command that
// cannot succeed should be refused while the caller is still on the phone —
// the alternative is a queued command that fails minutes later with a reason
// the console has to go looking for.
type Spec struct {
	// Kind as the console sends it, snake_case.
	Kind string
	// Kind as the contract names it, for the envelope the edge receives.
	ContractKind string
	// Whether the action targets one module rather than the device.
	NeedsModem bool
	// Builds the contract payload, or explains what is wrong with the request.
	Build func(Request) (map[string]any, error)
	// True for actions that change the device's state rather than read it.
	// The console uses this to decide how loudly to ask.
	Mutating bool
}

// Request is one console-supplied command before validation.
type Request struct {
	DeviceID  string `json:"device_id"`
	Kind      string `json:"kind"`
	ModemIMEI string `json:"modem_imei"`

	// SendSms
	To   string `json:"to"`
	Body string `json:"body"`

	// RunAtCommand
	Command   string `json:"command"`
	TimeoutMs int64  `json:"timeout_ms"`
	// Force sends a command the edge classifies as disruptive anyway. The
	// gateway does not classify: the edge holds the list because it is the
	// side that knows what the command reaches, and duplicating it here would
	// give two answers to maintain and one of them would drift.
	Force bool `json:"force"`

	// SendUssd
	Code  string `json:"code"`
	Stage string `json:"stage"`

	// SetRadio
	Enabled *bool `json:"enabled"`

	// SelectOperator
	Mode string `json:"mode"`
	PLMN string `json:"plmn"`

	// SetUsbnetMode
	//
	// Not folded into Mode above. Both are "a mode", but the value sets are
	// disjoint, and one shared field would mean no single request could be
	// valid for both commands — which is the failure this struct's comment
	// already describes for an earlier field that meant two things.
	UsbnetMode string `json:"usbnet_mode"`

	// SwitchEsimProfile
	TargetICCID string `json:"target_iccid"`

	// RetrieveEsimNotification.
	//
	// A pointer because zero is a real sequence number: both eUICCs on the
	// bench report their oldest pending notification as seqNumber 0, so an
	// omitted field and a deliberate 0 have to be told apart.
	SequenceNumber *int64 `json:"sequence_number"`

	// InitiateEsimAuthentication. Empty means "ask the chip".
	SmdpAddress string `json:"smdp_address"`

	// DownloadEsimProfile.
	//
	// A one-time credential. It is validated here and forwarded, and it is
	// never written to a log line, an error message or a command result: this
	// struct is the only place in the cloud that ever holds it, and the
	// payload it goes into is stored because the edge has to be able to read
	// it after a reconnect.
	ActivationCode   string `json:"activation_code"`
	ConfirmationCode string `json:"confirmation_code"`

	// SelfUpdate
	Version   string `json:"version"`
	URL       string `json:"url"`
	SHA256    string `json:"sha256"`
	Signature string `json:"signature"`
}

// ErrInvalid is returned for a request the caller can fix.
type ErrInvalid struct{ Reason string }

func (err ErrInvalid) Error() string { return err.Reason }

var (
	imeiPattern   = regexp.MustCompile(`^[0-9]{15}$`)
	iccidPattern  = regexp.MustCompile(`^[0-9]{19,20}$`)
	phonePattern  = regexp.MustCompile(`^\+?[0-9]{1,15}$`)
	plmnPattern   = regexp.MustCompile(`^[0-9]{3}-[0-9]{2,3}$`)
	sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
	// Must match SmdpAddress in the contract schema. A value the schema would
	// reject should be refused while the caller is still here rather than at
	// the edge, where it surfaces as a DNS failure minutes later.
	smdpAddressPattern = regexp.MustCompile(
		`^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$`)
	// An SGP.22 activation code: `1$<SM-DP+ address>$<matching id>` with two
	// optional trailing fields. Checked here rather than only at the edge
	// because the failure this prevents is expensive in a way a bad phone
	// number is not -- a mistyped code that reaches an SM-DP+ can consume an
	// order, and the operator is still on the page while this runs.
	activationCodePattern = regexp.MustCompile(
		`^(?:LPA:)?1\$[^$\s]{4,253}\$[^$\s]{1,128}(?:\$[^$\s]{0,255})?(?:\$1)?$`)
)

// The USB network functions a module can expose. Quectel's `usbnet` setting
// accepts a fifth value, but it is NCM on some firmware and undefined on
// others, so it is not offered.
var usbnetModes = map[string]bool{
	"rmnet": true, "ecm": true, "mbim": true, "rndis": true,
}

var catalogue = map[string]Spec{
	"send_sms": {
		Kind: "send_sms", ContractKind: "SendSms", NeedsModem: true, Mutating: true,
		Build: func(request Request) (map[string]any, error) {
			if !phonePattern.MatchString(request.To) {
				return nil, ErrInvalid{"to must be a phone number, optionally with a leading +"}
			}
			if request.Body == "" {
				return nil, ErrInvalid{"body must not be empty"}
			}
			return map[string]any{
				"kind": "SendSms", "to": request.To, "body": request.Body,
				"modem_imei": request.ModemIMEI,
			}, nil
		},
	},
	"restart_modem": {
		Kind: "restart_modem", ContractKind: "RestartModem", NeedsModem: true, Mutating: true,
		Build: func(request Request) (map[string]any, error) {
			return map[string]any{"kind": "RestartModem", "modem_imei": request.ModemIMEI}, nil
		},
	},
	"run_at_command": {
		Kind: "run_at_command", ContractKind: "RunAtCommand", NeedsModem: true, Mutating: true,
		Build: func(request Request) (map[string]any, error) {
			command := strings.TrimSpace(request.Command)
			// Anything shorter than "AT" cannot be a command, and the edge
			// would spend a timeout finding that out.
			if len(command) < 2 || !strings.HasPrefix(strings.ToUpper(command), "AT") {
				return nil, ErrInvalid{"command must start with AT"}
			}
			payload := map[string]any{"kind": "RunAtCommand", "modem_imei": request.ModemIMEI, "command": command}
			// Only carried when true. An absent field and a false one mean the
			// same thing to the edge, and omitting it keeps an ordinary
			// command's payload byte-identical to what it was before the flag
			// existed -- which is what the idempotency key is derived from.
			if request.Force {
				payload["force"] = true
			}
			if request.TimeoutMs != 0 {
				if request.TimeoutMs < 100 || request.TimeoutMs > 300000 {
					return nil, ErrInvalid{"timeout_ms must be between 100 and 300000"}
				}
				payload["timeout_ms"] = request.TimeoutMs
			}
			return payload, nil
		},
	},
	"send_ussd": {
		Kind: "send_ussd", ContractKind: "SendUssd", NeedsModem: true, Mutating: true,
		Build: func(request Request) (map[string]any, error) {
			stage := request.Stage
			if stage == "" {
				stage = "start"
			}
			switch stage {
			case "start", "continue", "cancel":
			default:
				return nil, ErrInvalid{"stage must be start, continue or cancel"}
			}
			// A cancel carries no code, but the contract requires the field,
			// so it is sent empty-but-present rather than rejected here.
			if stage != "cancel" && strings.TrimSpace(request.Code) == "" {
				return nil, ErrInvalid{"code is required unless stage is cancel"}
			}
			return map[string]any{
				"kind": "SendUssd", "modem_imei": request.ModemIMEI,
				"code": request.Code, "stage": stage,
			}, nil
		},
	},
	"set_radio": {
		Kind: "set_radio", ContractKind: "SetRadio", NeedsModem: true, Mutating: true,
		Build: func(request Request) (map[string]any, error) {
			// Absent is not false: turning a radio off because a field was
			// omitted is exactly the mistake this refuses to make.
			if request.Enabled == nil {
				return nil, ErrInvalid{"enabled must be given explicitly"}
			}
			return map[string]any{
				"kind": "SetRadio", "modem_imei": request.ModemIMEI, "enabled": *request.Enabled,
			}, nil
		},
	},
	"scan_operators": {
		Kind: "scan_operators", ContractKind: "ScanOperators", NeedsModem: true, Mutating: true,
		Build: func(request Request) (map[string]any, error) {
			return map[string]any{"kind": "ScanOperators", "modem_imei": request.ModemIMEI}, nil
		},
	},
	"select_operator": {
		Kind: "select_operator", ContractKind: "SelectOperator", NeedsModem: true, Mutating: true,
		Build: func(request Request) (map[string]any, error) {
			mode := request.Mode
			if mode == "" {
				mode = "automatic"
			}
			if mode != "automatic" && mode != "manual" {
				return nil, ErrInvalid{"mode must be automatic or manual"}
			}
			payload := map[string]any{"kind": "SelectOperator", "modem_imei": request.ModemIMEI, "mode": mode}
			if mode == "manual" {
				if !plmnPattern.MatchString(request.PLMN) {
					return nil, ErrInvalid{"manual selection needs a plmn like 460-01"}
				}
				payload["plmn"] = request.PLMN
			}
			return payload, nil
		},
	},
	"modem_report": {
		Kind: "modem_report", ContractKind: "ModemReport", NeedsModem: true,
		Build: func(request Request) (map[string]any, error) {
			return map[string]any{"kind": "ModemReport", "modem_imei": request.ModemIMEI}, nil
		},
	},
	"reset_modem_usb": {
		Kind: "reset_modem_usb", ContractKind: "ResetModemUsb", NeedsModem: true, Mutating: true,
		Build: func(request Request) (map[string]any, error) {
			return map[string]any{"kind": "ResetModemUsb", "modem_imei": request.ModemIMEI}, nil
		},
	},
	"set_data_network": {
		Kind: "set_data_network", ContractKind: "SetDataNetwork", NeedsModem: true, Mutating: true,
		Build: func(request Request) (map[string]any, error) {
			// Same reasoning as set_radio: an omitted field must not read as
			// "off". These two are the only commands that can take a working
			// modem off the air by saying nothing at all.
			if request.Enabled == nil {
				return nil, ErrInvalid{"enabled must be given explicitly"}
			}
			return map[string]any{
				"kind": "SetDataNetwork", "modem_imei": request.ModemIMEI, "enabled": *request.Enabled,
			}, nil
		},
	},
	"set_usbnet_mode": {
		Kind: "set_usbnet_mode", ContractKind: "SetUsbnetMode", NeedsModem: true, Mutating: true,
		Build: func(request Request) (map[string]any, error) {
			// No default. Every value here changes which USB function the
			// module exposes at its next restart, and three of the four take
			// away the QMI port the agent reaches it through, so guessing one
			// is how a modem leaves the fleet.
			if !usbnetModes[request.UsbnetMode] {
				return nil, ErrInvalid{"usbnet_mode must be one of rmnet, ecm, mbim, rndis"}
			}
			return map[string]any{
				"kind": "SetUsbnetMode", "modem_imei": request.ModemIMEI, "mode": request.UsbnetMode,
			}, nil
		},
	},
	"reregister_network": {
		Kind: "reregister_network", ContractKind: "ReregisterNetwork", NeedsModem: true, Mutating: true,
		Build: func(request Request) (map[string]any, error) {
			return map[string]any{"kind": "ReregisterNetwork", "modem_imei": request.ModemIMEI}, nil
		},
	},
	"refresh_modems": {
		// No modem: the point is the module that is not in the inventory yet,
		// so there is no IMEI to name. Not mutating either — it asks the edge
		// to look, and looking is what the poll loop does anyway.
		Kind: "refresh_modems", ContractKind: "RefreshModems",
		Build: func(Request) (map[string]any, error) {
			return map[string]any{"kind": "RefreshModems"}, nil
		},
	},
	"list_esim_profiles": {
		Kind: "list_esim_profiles", ContractKind: "ListEsimProfiles", NeedsModem: true,
		Build: func(request Request) (map[string]any, error) {
			return map[string]any{"kind": "ListEsimProfiles", "modem_imei": request.ModemIMEI}, nil
		},
	},
	"read_esim_info": {
		// Not mutating. It reads the chip's own identity, its capabilities and
		// the notifications it still owes an SM-DP+, and changes none of them.
		Kind: "read_esim_info", ContractKind: "ReadEsimInfo", NeedsModem: true,
		Build: func(request Request) (map[string]any, error) {
			return map[string]any{"kind": "ReadEsimInfo", "modem_imei": request.ModemIMEI}, nil
		},
	},
	"retrieve_esim_notification": {
		// Also not mutating, and the name says fetch rather than retry on
		// purpose: this gets the signed notification off the card. Handing it
		// to the SM-DP+ is ES9+ over HTTPS and removing it afterwards is a
		// write, and neither happens here.
		Kind: "retrieve_esim_notification", ContractKind: "RetrieveEsimNotification",
		NeedsModem: true,
		Build: func(request Request) (map[string]any, error) {
			if request.SequenceNumber == nil {
				return nil, ErrInvalid{"sequence_number is required"}
			}
			// Bounded rather than merely non-negative: the contract declares an
			// int32 range, and a value the schema rejects should be refused
			// while the caller is still here rather than at the edge.
			if *request.SequenceNumber < 0 || *request.SequenceNumber > math.MaxInt32 {
				return nil, ErrInvalid{"sequence_number must be between 0 and 2147483647"}
			}
			return map[string]any{
				"kind": "RetrieveEsimNotification", "modem_imei": request.ModemIMEI,
				"sequence_number": *request.SequenceNumber,
			}, nil
		},
	},
	"initiate_esim_authentication": {
		// Not mutating, and that is a property of this particular ES9+
		// function rather than of ES9+ in general. InitiateAuthentication
		// needs no activation code and leaves nothing behind at either end:
		// the card generates a challenge, the SM-DP+ signs an answer, and the
		// exchange stops there. Downloading a profile or delivering a
		// notification would be a different matter and is a different command.
		Kind: "initiate_esim_authentication", ContractKind: "InitiateEsimAuthentication",
		NeedsModem: true,
		Build: func(request Request) (map[string]any, error) {
			payload := map[string]any{
				"kind": "InitiateEsimAuthentication", "modem_imei": request.ModemIMEI,
			}
			// Optional on purpose: the usual path is to let the edge ask the
			// chip, which knows either a configured SM-DP+ or the address its
			// pending notifications name. An operator overriding it is the
			// exception, so an empty field means "ask the chip" rather than
			// being an error.
			address := strings.TrimSpace(request.SmdpAddress)
			if address != "" {
				if !smdpAddressPattern.MatchString(address) {
					return nil, ErrInvalid{"smdp_address must be a host name"}
				}
				payload["smdp_address"] = address
			}
			return payload, nil
		},
	},
	"download_esim_profile": {
		// The one command in this catalogue that cannot be undone from the
		// console. It writes a profile into an eUICC nobody can physically
		// reach, and a Profile Policy Rule that arrives with it is permanent.
		// The edge reads those rules and refuses before installing; this end
		// only makes sure a malformed code never gets that far.
		Kind: "download_esim_profile", ContractKind: "DownloadEsimProfile",
		NeedsModem: true, Mutating: true,
		Build: func(request Request) (map[string]any, error) {
			code := strings.TrimSpace(request.ActivationCode)
			if code == "" {
				return nil, ErrInvalid{"activation_code is required"}
			}
			if !activationCodePattern.MatchString(code) {
				// Deliberately does not echo the value. An activation code in
				// an error message is an activation code in a log.
				return nil, ErrInvalid{
					"activation_code must look like 1$<SM-DP+ address>$<matching id>",
				}
			}
			payload := map[string]any{
				"kind": "DownloadEsimProfile", "modem_imei": request.ModemIMEI,
				"activation_code": code,
			}
			// Optional, and only present when it has a value: an empty string
			// would fail the contract's minLength and be rejected at the edge
			// as a malformed envelope rather than as a missing field.
			if confirmation := strings.TrimSpace(request.ConfirmationCode); confirmation != "" {
				if len(confirmation) > 128 {
					return nil, ErrInvalid{"confirmation_code is too long"}
				}
				payload["confirmation_code"] = confirmation
			}
			return payload, nil
		},
	},
	"self_update": {
		Kind: "self_update", ContractKind: "SelfUpdate", Mutating: true,
		Build: func(request Request) (map[string]any, error) {
			// Every field is checked here because the failure mode is a fleet
			// that downloads and installs the wrong thing. The edge verifies
			// the digest and signature before staging, but a malformed
			// request should never get as far as a device.
			if strings.TrimSpace(request.Version) == "" {
				return nil, ErrInvalid{"version is required"}
			}
			if !strings.HasPrefix(request.URL, "https://") {
				// Plain HTTP for a binary a fleet will execute is not a
				// configuration mistake worth supporting.
				return nil, ErrInvalid{"url must be https"}
			}
			if !sha256Pattern.MatchString(request.SHA256) {
				return nil, ErrInvalid{"sha256 must be 64 hex characters"}
			}
			if len(request.Signature) < 16 {
				return nil, ErrInvalid{"signature is required"}
			}
			return map[string]any{
				"kind": "SelfUpdate", "version": request.Version, "url": request.URL,
				"sha256": request.SHA256, "signature": request.Signature,
			}, nil
		},
	},
	"rotate_ip": {
		Kind: "rotate_ip", ContractKind: "RotateIp", NeedsModem: true, Mutating: true,
		Build: func(request Request) (map[string]any, error) {
			return map[string]any{"kind": "RotateIp", "modem_imei": request.ModemIMEI}, nil
		},
	},
	"switch_esim_profile": {
		Kind: "switch_esim_profile", ContractKind: "SwitchEsimProfile", NeedsModem: true, Mutating: true,
		Build: func(request Request) (map[string]any, error) {
			if !iccidPattern.MatchString(request.TargetICCID) {
				return nil, ErrInvalid{"target_iccid must be 19 or 20 digits"}
			}
			return map[string]any{
				"kind": "SwitchEsimProfile", "modem_imei": request.ModemIMEI,
				"target_iccid": request.TargetICCID,
			}, nil
		},
	},
}

// Kinds lists every supported command kind, sorted, for error messages and
// for the console to render without a second hardcoded list.
func Kinds() []string {
	kinds := make([]string, 0, len(catalogue))
	for kind := range catalogue {
		kinds = append(kinds, kind)
	}
	// A stable order keeps error messages and API responses comparable.
	for i := 1; i < len(kinds); i++ {
		for j := i; j > 0 && kinds[j] < kinds[j-1]; j-- {
			kinds[j], kinds[j-1] = kinds[j-1], kinds[j]
		}
	}
	return kinds
}

// Lookup returns the spec for a kind.
func Lookup(kind string) (Spec, bool) {
	spec, ok := catalogue[kind]
	return spec, ok
}

// BuildPayload validates a request and returns the contract payload to queue.
func BuildPayload(request Request) (Spec, []byte, error) {
	kind := request.Kind
	if kind == "" {
		// Historic default: the first version of this endpoint only sent SMS
		// and callers still omit the field.
		kind = "send_sms"
	}
	spec, ok := catalogue[kind]
	if !ok {
		return Spec{}, nil, ErrInvalid{
			fmt.Sprintf("unsupported command kind %q, expected one of %s",
				kind, strings.Join(Kinds(), ", ")),
		}
	}
	if request.DeviceID == "" {
		return Spec{}, nil, ErrInvalid{"device_id is required"}
	}
	if spec.NeedsModem && !imeiPattern.MatchString(request.ModemIMEI) {
		return Spec{}, nil, ErrInvalid{"modem_imei must be 15 digits"}
	}
	payload, err := spec.Build(request)
	if err != nil {
		return Spec{}, nil, err
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return Spec{}, nil, ErrInvalid{"command could not be encoded"}
	}
	return spec, encoded, nil
}
