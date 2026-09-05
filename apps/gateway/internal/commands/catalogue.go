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

	// RenameEsimProfile, DisableEsimProfile, DeleteEsimProfile
	//
	// Separate from TargetICCID above: that one names the profile to switch
	// TO, and these name the profile to act ON. One field meaning both is how
	// a rename ends up applied to whatever was enabled last.
	ProfileICCID string `json:"iccid"`
	// A pointer so that clearing a name is something the caller said rather
	// than something a forgotten field did.
	Nickname *string `json:"nickname"`

	// ClaimModemCandidate
	CandidateKey string `json:"candidate_key"`

	// RegisterModem
	Note string `json:"note"`
	// 型号。只有 create_modem 用：它建的那一根 agent 从没观测过，型号推不出来，
	// 而闸按 (型号 × 运营商) 查规则 —— 留空就是建了一条永远过不了闸的记录。
	Family string `json:"family"`

	// ReadLogs
	//
	// LogAfter is a pointer so that resuming from the very first line -- a
	// cursor of 0, which the edge reads as "everything you still hold" -- is
	// distinguishable from not asking to resume at all. They happen to mean
	// the same thing today, and a field that quietly relies on that is one
	// refactor away from meaning something else.
	LogAfter    *uint64 `json:"log_after"`
	LogLimit    *int    `json:"log_limit"`
	LogContains string  `json:"log_contains"`

	// ConfigureApn
	//
	// CID is a pointer for the same reason Enabled is: context 0 is not a
	// context anybody writes, but a missing field arriving as 0 and being
	// rejected for its value would report the wrong fault.
	CID     *int   `json:"cid"`
	PDPType string `json:"pdp_type"`
	APN     string `json:"apn"`
	// Pointers because absent and empty mean different things all the way
	// down: AT+QICSGP rewrites every field, so the edge reads an omitted
	// credential as "keep what the context has" and an explicit "" as "clear
	// it". A plain string could not tell an operator clearing a username from
	// one who never touched the box.
	Username *string `json:"username"`
	// 🔴 Write-only. It is carried to the edge and stripped from every read of
	// the command row -- see the payload column in catalog.ListCommands.
	Password *string `json:"password"`
	Auth     string  `json:"auth"`

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
	"configure_apn": {
		Kind: "configure_apn", ContractKind: "ConfigureApn", NeedsModem: true, Mutating: true,
		Build: func(request Request) (map[string]any, error) {
			if request.CID == nil {
				return nil, ErrInvalid{"cid is required"}
			}
			// The contract's own bound. Writing outside it is not a context
			// the module will act on, and finding that out at the edge costs a
			// round trip to learn what is knowable here.
			if *request.CID < 1 || *request.CID > 15 {
				return nil, ErrInvalid{"cid must be between 1 and 15"}
			}
			payload := map[string]any{
				"kind": "ConfigureApn", "modem_imei": request.ModemIMEI,
				"cid": *request.CID, "apn": request.APN,
			}
			if request.PDPType != "" {
				switch request.PDPType {
				case "IP", "IPV6", "IPV4V6":
					payload["pdp_type"] = request.PDPType
				default:
					return nil, ErrInvalid{"pdp_type must be IP, IPV6 or IPV4V6"}
				}
			}
			if request.Auth != "" {
				switch request.Auth {
				case "none", "pap", "chap", "pap_or_chap":
					payload["auth"] = request.Auth
				default:
					return nil, ErrInvalid{"auth must be none, pap, chap or pap_or_chap"}
				}
			}
			// Each half travels on its own. Sending the pair together
			// whenever either was named would make "change the username"
			// silently clear the password, and the edge cannot tell that
			// apart from an operator who meant it.
			if request.Username != nil {
				payload["username"] = *request.Username
			}
			if request.Password != nil {
				payload["password"] = *request.Password
			}
			return payload, nil
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
	"rename_esim_profile": {
		Kind: "rename_esim_profile", ContractKind: "RenameEsimProfile",
		NeedsModem: true, Mutating: true,
		Build: func(request Request) (map[string]any, error) {
			if !iccidPattern.MatchString(request.ProfileICCID) {
				return nil, ErrInvalid{"iccid must be 19 or 20 digits"}
			}
			if request.Nickname == nil {
				return nil, ErrInvalid{"nickname is required; send an empty string to clear it"}
			}
			// SGP.22's own limit, in bytes rather than characters: the field
			// is a UTF8String and the card counts octets, so a name of
			// twenty-two Chinese characters is over it.
			if len(*request.Nickname) > 64 {
				return nil, ErrInvalid{"nickname must be 64 bytes or fewer"}
			}
			return map[string]any{
				"kind": "RenameEsimProfile", "modem_imei": request.ModemIMEI,
				"iccid": request.ProfileICCID, "nickname": *request.Nickname,
			}, nil
		},
	},
	"disable_esim_profile": {
		Kind: "disable_esim_profile", ContractKind: "DisableEsimProfile",
		NeedsModem: true, Mutating: true,
		Build: func(request Request) (map[string]any, error) {
			if !iccidPattern.MatchString(request.ProfileICCID) {
				return nil, ErrInvalid{"iccid must be 19 or 20 digits"}
			}
			return map[string]any{
				"kind": "DisableEsimProfile", "modem_imei": request.ModemIMEI,
				"iccid": request.ProfileICCID,
			}, nil
		},
	},
	"delete_esim_profile": {
		// Irreversible in a way nothing else in this catalogue is: the card
		// keeps no copy, and a profile that was paid for generally cannot be
		// re-downloaded without the operator issuing a fresh activation code.
		// The console guards it; this only refuses what is malformed.
		Kind: "delete_esim_profile", ContractKind: "DeleteEsimProfile",
		NeedsModem: true, Mutating: true,
		Build: func(request Request) (map[string]any, error) {
			if !iccidPattern.MatchString(request.ProfileICCID) {
				return nil, ErrInvalid{"iccid must be 19 or 20 digits"}
			}
			return map[string]any{
				"kind": "DeleteEsimProfile", "modem_imei": request.ModemIMEI,
				"iccid": request.ProfileICCID,
			}, nil
		},
	},
	"claim_modem_candidate": {
		// No modem: the whole point is an endpoint that has no IMEI yet.
		// Mutating: approving one lets the agent write AT to a port it has so
		// far only looked at, and that is the line this command crosses.
		Kind: "claim_modem_candidate", ContractKind: "ClaimModemCandidate", Mutating: true,
		Build: func(request Request) (map[string]any, error) {
			key := strings.TrimSpace(request.CandidateKey)
			if key == "" {
				return nil, ErrInvalid{"candidate_key is required"}
			}
			if len(key) > 128 {
				return nil, ErrInvalid{"candidate_key must be 128 characters or fewer"}
			}
			// Only a key travels. A port or an IMEI here would let the cloud
			// describe hardware nobody has looked at, and the agent would have
			// to either trust it or check it -- the first is wrong and the
			// second makes the field pointless.
			return map[string]any{"kind": "ClaimModemCandidate", "candidate_key": key}, nil
		},
	},
	"revoke_modem_candidate": {
		// Mutating, and the mirror of claim_modem_candidate: somebody nodded
		// at a serial port and this is the way to take that back. Without it
		// an approval was permanent -- the profile row stayed forever and the
		// candidate stayed `claimed` in the console with no way out.
		//
		// NeedsModem is deliberately false. The subject is an endpoint, not a
		// module: the whole point is that it may never have produced an IMEI.
		Kind: "revoke_modem_candidate", ContractKind: "RevokeModemCandidate", Mutating: true,
		Build: func(request Request) (map[string]any, error) {
			key := strings.TrimSpace(request.CandidateKey)
			if key == "" {
				return nil, ErrInvalid{"candidate_key is required"}
			}
			if len(key) > 128 {
				return nil, ErrInvalid{"candidate_key must be 128 characters or fewer"}
			}
			// The edge refuses when the module behind this endpoint is
			// currently managed, and that check stays there rather than being
			// mirrored here: only the agent knows what it is managing right
			// now, and a copy of that judgement in the cloud would be the one
			// that goes stale.
			return map[string]any{"kind": "RevokeModemCandidate", "candidate_key": key}, nil
		},
	},
	"register_modem": {
		// Mutating: it changes what the agent manages, which is a decision
		// worth confirming. The edge refuses an IMEI it has not identified, so
		// the failure mode is a clear refusal rather than a phantom device.
		Kind: "register_modem", ContractKind: "RegisterModem", NeedsModem: true, Mutating: true,
		Build: func(request Request) (map[string]any, error) {
			payload := map[string]any{
				"kind": "RegisterModem", "modem_imei": request.ModemIMEI,
			}
			if note := strings.TrimSpace(request.Note); note != "" {
				if len(note) > 256 {
					return nil, ErrInvalid{"note must be 256 characters or fewer"}
				}
				payload["note"] = note
			}
			return payload, nil
		},
	},
	"unregister_modem": {
		Kind: "unregister_modem", ContractKind: "UnregisterModem", NeedsModem: true, Mutating: true,
		Build: func(request Request) (map[string]any, error) {
			return map[string]any{
				"kind": "UnregisterModem", "modem_imei": request.ModemIMEI,
			}, nil
		},
	},
	"create_modem": {
		// The C that register_modem does not cover: adopting a module the agent
		// has never seen. That one refuses an unobserved IMEI, which is right
		// when the hardware is on the bus and wrong when somebody is building
		// the register ahead of the machine arriving.
		//
		// NeedsModem is false on purpose -- the whole point is that this IMEI is
		// not in app.modems yet. Requiring it would make the command impossible
		// to issue for exactly the case it exists for.
		//
		// 🔴 The record it creates has NOT passed the adoption gates. The edge
		// says so in the receipt (gates_passed: false) rather than letting a
		// green tick imply it was checked.
		Kind: "create_modem", ContractKind: "CreateModem", Mutating: true,
		Build: func(request Request) (map[string]any, error) {
			imei := strings.TrimSpace(request.ModemIMEI)
			if !imeiPattern.MatchString(imei) {
				return nil, ErrInvalid{"modem_imei must be 15 digits"}
			}
			family := strings.TrimSpace(request.Family)
			if family == "" {
				return nil, ErrInvalid{
					"family is required: the gates look up rules by (family, carrier) " +
						"and nothing can infer it for a module nobody has observed",
				}
			}
			if len(family) > 64 {
				return nil, ErrInvalid{"family must be 64 characters or fewer"}
			}
			payload := map[string]any{
				"kind": "CreateModem", "modem_imei": imei, "family": family,
			}
			if note := strings.TrimSpace(request.Note); note != "" {
				if len(note) > 256 {
					return nil, ErrInvalid{"note must be 256 characters or fewer"}
				}
				payload["note"] = note
			}
			return payload, nil
		},
	},
	"update_modem": {
		// The U in this catalogue's CRUD. Adoption could be created, listed and
		// deleted from day one; the record itself could never be edited, so a
		// note written wrong stayed wrong -- or got "fixed" by unregistering and
		// re-adopting, which rewrites registered_at and registered_by to today.
		//
		// Mutating because it writes, but it touches no hardware: the module
		// keeps working through it either way.
		Kind: "update_modem", ContractKind: "UpdateModem", NeedsModem: true, Mutating: true,
		Build: func(request Request) (map[string]any, error) {
			payload := map[string]any{
				"kind": "UpdateModem", "modem_imei": request.ModemIMEI,
			}
			note := strings.TrimSpace(request.Note)
			if len(note) > 256 {
				return nil, ErrInvalid{"note must be 256 characters or fewer"}
			}
			// An absent note clears it. There is deliberately no way to say
			// "leave it alone": a caller who wants that does not send this.
			if note != "" {
				payload["note"] = note
			}
			return payload, nil
		},
	},
	"reconfirm_modem": {
		// Re-runs the adoption gates against a module they have marked.
		//
		// Mutating, because it can clear the mark or restart the quarantine
		// countdown -- but it is emphatically not a "make the alarm stop"
		// button: the edge clears the mark only when the gates pass again,
		// and otherwise keeps it while restarting the clock, so somebody
		// fixing the real cause (usually by publishing a matrix) is not raced
		// by the grace period.
		//
		// The result carries `cleared` and `restarted` separately for that
		// reason. A console that collapsed both into a green tick would tell
		// an operator they fixed something when they did not.
		Kind: "reconfirm_modem", ContractKind: "ReconfirmModem", NeedsModem: true, Mutating: true,
		Build: func(request Request) (map[string]any, error) {
			return map[string]any{
				"kind": "ReconfirmModem", "modem_imei": request.ModemIMEI,
			}, nil
		},
	},
	"read_logs": {
		// No modem and not mutating: these are the agent's own lines, not any
		// one module's, and reading them changes nothing. It is here because
		// the alternative to reading them from the cloud is an SSH session on
		// the edge machine, which is the access a cloud operator does not have.
		Kind: "read_logs", ContractKind: "ReadLogs",
		Build: func(request Request) (map[string]any, error) {
			payload := map[string]any{"kind": "ReadLogs"}
			if request.LogAfter != nil {
				payload["after"] = *request.LogAfter
			}
			if request.LogLimit != nil {
				// The edge ring holds 500. Asking for more is not an error
				// worth a round trip to discover, but it is worth refusing
				// here rather than silently sending a number the contract
				// rejects on arrival.
				if *request.LogLimit < 1 || *request.LogLimit > 500 {
					return nil, ErrInvalid{"log_limit must be between 1 and 500"}
				}
				payload["limit"] = *request.LogLimit
			}
			if request.LogContains != "" {
				if len(request.LogContains) > 64 {
					return nil, ErrInvalid{"log_contains must be 64 characters or fewer"}
				}
				payload["contains"] = request.LogContains
			}
			return payload, nil
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
