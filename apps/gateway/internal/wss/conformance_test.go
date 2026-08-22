package wss

import (
	"strings"
	"testing"

	contract "github.com/vodoge/vodoge-cloud/packages/contract"
)

// The exact payload the edge sent for twenty thousand envelopes. Every one of
// these values was accepted and stored.
func TestTheHistoricalNonConformantPayloadIsCaught(t *testing.T) {
	t.Parallel()

	payload := []byte(`{"observed_at":1787362330292,"modems":[{
		"modem_imei":"867018069514820",
		"state":"Registered",
		"registration":"Registered",
		"capability":{"sms_mo":"cellular","sms_mt":"cellular"}
	}]}`)

	found := violations(contract.MessageKindDeviceState, payload)
	if len(found) != 4 {
		t.Fatalf("violations = %#v, want 4", found)
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

	if found := violations(contract.MessageKindDeviceState, payload); len(found) != 0 {
		t.Fatalf("violations = %#v, want none", found)
	}
}

// Generating the constraints from the schema is the point: this kind was
// never mentioned in the hand-written version, and its `bearer` field turned
// out to be wrong on the edge for exactly as long.
func TestOtherMessageKindsAreCheckedToo(t *testing.T) {
	t.Parallel()

	payload := []byte(`{"modem_imei":"867018069514820","peer":"10086","body":"hi",
		"received_at":1,"iccid":"","bearer":"cellular","encoding":"gsm7"}`)

	found := violations(contract.MessageKindSmsReceived, payload)
	if len(found) != 1 {
		t.Fatalf("violations = %#v, want the bearer flagged", found)
	}
	if !strings.Contains(found[0], "bearer") {
		t.Fatalf("violation = %q, want it to name bearer", found[0])
	}
}

// Absent fields are how an older edge deploys, not a defect.
func TestAbsentFieldsAreNotViolations(t *testing.T) {
	t.Parallel()

	payload := []byte(`{"observed_at":1,"modems":[{"modem_imei":"862547055142811"}]}`)
	if found := violations(contract.MessageKindDeviceState, payload); len(found) != 0 {
		t.Fatalf("violations = %#v, want none", found)
	}
}

// One bad entry among several is exactly the case a naive check misses.
func TestEveryArrayEntryIsChecked(t *testing.T) {
	t.Parallel()

	payload := []byte(`{"observed_at":1,"modems":[
		{"modem_imei":"1","state":"online","registration":"registered"},
		{"modem_imei":"2","state":"online","registration":"registered"},
		{"modem_imei":"3","state":"online","registration":"Registered"}
	]}`)

	found := violations(contract.MessageKindDeviceState, payload)
	if len(found) != 1 {
		t.Fatalf("violations = %#v, want the third modem flagged", found)
	}
}

// A kind the schema does not constrain must not produce noise.
func TestAnUnconstrainedKindIsSilent(t *testing.T) {
	t.Parallel()

	if found := violations(contract.MessageKindPing, []byte(`{"connection_id":"x"}`)); found != nil {
		t.Fatalf("violations = %#v, want none", found)
	}
}
