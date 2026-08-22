package commands

import (
	"encoding/json"
	"fmt"
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

	// SendUssd
	Code  string `json:"code"`
	Stage string `json:"stage"`

	// SetRadio
	Enabled *bool `json:"enabled"`

	// SelectOperator
	Mode string `json:"mode"`
	PLMN string `json:"plmn"`

	// SwitchEsimProfile
	TargetICCID string `json:"target_iccid"`
}

// ErrInvalid is returned for a request the caller can fix.
type ErrInvalid struct{ Reason string }

func (err ErrInvalid) Error() string { return err.Reason }

var (
	imeiPattern  = regexp.MustCompile(`^[0-9]{15}$`)
	iccidPattern = regexp.MustCompile(`^[0-9]{19,20}$`)
	phonePattern = regexp.MustCompile(`^\+?[0-9]{1,15}$`)
	plmnPattern  = regexp.MustCompile(`^[0-9]{3}-[0-9]{2,3}$`)
)

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
	"list_esim_profiles": {
		Kind: "list_esim_profiles", ContractKind: "ListEsimProfiles", NeedsModem: true,
		Build: func(request Request) (map[string]any, error) {
			return map[string]any{"kind": "ListEsimProfiles", "modem_imei": request.ModemIMEI}, nil
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
