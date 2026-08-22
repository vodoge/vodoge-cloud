package wss

import (
	"strings"
	"testing"
)

// The exact payload the edge sent for twenty thousand envelopes. Every one of
// these three values was accepted and stored.
func TestTheHistoricalNonConformantPayloadIsCaught(t *testing.T) {
	t.Parallel()

	payload := []byte(`{"observed_at":1787362330292,"modems":[{
		"modem_imei":"867018069514820",
		"state":"Registered",
		"registration":"Registered",
		"capability":{"sms_mo":"cellular","sms_mt":"cellular"}
	}]}`)

	violations := deviceStateViolations(payload)
	if len(violations) != 4 {
		t.Fatalf("violations = %#v, want 4", violations)
	}
	for _, violation := range violations {
		if !strings.HasPrefix(violation, "867018069514820 ") {
			t.Fatalf("violation should name the modem: %q", violation)
		}
	}
}

// What the edge sends now.
func TestAConformantPayloadIsSilent(t *testing.T) {
	t.Parallel()

	payload := []byte(`{"observed_at":1787375120426,"modems":[{
		"modem_imei":"867018069514820",
		"state":"online",
		"registration":"registered",
		"home_plmn":"454-00",
		"serving_plmn":"460-01",
		"signal_dbm":-51,
		"capability":{"sms_mo":"unknown","sms_mt":"unknown","matrix_version":"2026-08-20"}
	}]}`)

	if violations := deviceStateViolations(payload); len(violations) != 0 {
		t.Fatalf("violations = %#v, want none", violations)
	}
}

// Optional fields are optional. Flagging their absence would make every
// snapshot from a modem whose serving system could not be read look broken.
func TestAbsentFieldsAreNotViolations(t *testing.T) {
	t.Parallel()

	payload := []byte(`{"observed_at":1,"modems":[{"modem_imei":"862547055142811"}]}`)
	if violations := deviceStateViolations(payload); len(violations) != 0 {
		t.Fatalf("violations = %#v, want none", violations)
	}
}

// A modem entry with no IMEI is dropped by the projection, so the violation
// has to be findable some other way.
func TestAViolationWithoutAnImeiIsLocatedByPosition(t *testing.T) {
	t.Parallel()

	payload := []byte(`{"observed_at":1,"modems":[{"state":"Registered"}]}`)
	violations := deviceStateViolations(payload)
	if len(violations) != 1 {
		t.Fatalf("violations = %#v, want 1", violations)
	}
	if !strings.HasPrefix(violations[0], "modems[0] ") {
		t.Fatalf("violation = %q, want it to name the position", violations[0])
	}
}
