package wss

import (
	"encoding/json"
	"fmt"
	"strings"
)

// The contract declares these as closed enums. Nothing enforced them: the
// gateway stores payloads opaquely, so an edge build that sent `Registered`
// where the schema says `registered`, and the bearer name `cellular` where it
// says `supported`, was accepted for twenty thousand envelopes and surfaced
// only as a wrong column in the console.
var (
	modemStates        = []string{"online", "offline", "recovering", "unknown"}
	modemRegistrations = []string{"registered", "searching", "denied", "unregistered", "unknown"}
	bearerSupport      = []string{"supported", "degraded", "unsupported", "unknown"}
)

// deviceStateViolations names every enum field in a DeviceState payload whose
// value is outside the contract.
//
// It reports rather than rejects. A non-conformant value is a bug in the
// sender, but dropping the envelope would lose real observations from a device
// that cannot be upgraded on demand — and the projection stores what it is
// given either way. Losing the data as well as the correctness helps nobody.
//
// Absent fields are not violations; the schema makes them optional and the
// projection already treats a missing value as unknown.
func deviceStateViolations(payload []byte) []string {
	var body struct {
		Modems []struct {
			IMEI         string `json:"modem_imei"`
			State        *string
			Registration *string
			Capability   *struct {
				SmsMo *string `json:"sms_mo"`
				SmsMt *string `json:"sms_mt"`
			}
		}
	}
	if err := json.Unmarshal(payload, &body); err != nil {
		return []string{"payload is not a DeviceState object"}
	}

	var violations []string
	for index, modem := range body.Modems {
		// The IMEI is what makes a violation actionable, but a modem entry
		// without one is dropped by the projection anyway, so it is named by
		// position instead.
		who := modem.IMEI
		if who == "" {
			who = fmt.Sprintf("modems[%d]", index)
		}
		check := func(field string, value *string, allowed []string) {
			if value == nil || contains(allowed, *value) {
				return
			}
			violations = append(violations, fmt.Sprintf(
				"%s %s=%q not in {%s}", who, field, *value, strings.Join(allowed, ",")))
		}
		check("state", modem.State, modemStates)
		check("registration", modem.Registration, modemRegistrations)
		if modem.Capability != nil {
			check("capability.sms_mo", modem.Capability.SmsMo, bearerSupport)
			check("capability.sms_mt", modem.Capability.SmsMt, bearerSupport)
		}
	}
	return violations
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}
