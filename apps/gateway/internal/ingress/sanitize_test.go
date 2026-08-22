package ingress

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestStripNullsLeavesCleanPayloadsAlone(t *testing.T) {
	payload := []byte(`{"peer":"10086","body":"hello","received_at":1755800000000}`)
	out, changed := stripNulls(payload)
	if changed {
		t.Fatalf("clean payload reported as changed")
	}
	if string(out) != string(payload) {
		t.Fatalf("clean payload was rewritten:\n got %s\nwant %s", out, payload)
	}
}

func TestStripNullsRemovesNulFromBody(t *testing.T) {
	payload := []byte(`{"peer":"10086","body":"hi\u0000there"}`)
	out, changed := stripNulls(payload)
	if !changed {
		t.Fatalf("payload carrying a NUL reported as unchanged")
	}
	var decoded map[string]any
	if err := json.Unmarshal(out, &decoded); err != nil {
		t.Fatalf("result is not JSON: %v", err)
	}
	if decoded["body"] != "hithere" {
		t.Fatalf("body = %q, want %q", decoded["body"], "hithere")
	}
	if decoded["peer"] != "10086" {
		t.Fatalf("peer was disturbed: %q", decoded["peer"])
	}
	if strings.Contains(string(out), `\u0000`) {
		t.Fatalf("escape survived: %s", out)
	}
}

// An escaped backslash followed by the characters "u0000" is not a NUL. It
// matches the byte scan that opens stripNulls, so this is the case that
// distinguishes decoding from substring surgery.
func TestStripNullsKeepsLiteralBackslashUZeros(t *testing.T) {
	payload := []byte(`{"body":"\\u0000"}`)
	out, changed := stripNulls(payload)
	if changed {
		t.Fatalf("literal backslash sequence was treated as a NUL")
	}
	var decoded map[string]any
	if err := json.Unmarshal(out, &decoded); err != nil {
		t.Fatalf("result is not JSON: %v", err)
	}
	if decoded["body"] != `\u0000` {
		t.Fatalf("body = %q, want %q", decoded["body"], `\u0000`)
	}
}

// A 64-bit epoch must survive re-encoding exactly. Decoded through float64 it
// would come back as 1.7558e+12 and the projection would store the wrong time.
func TestStripNullsPreservesLargeIntegers(t *testing.T) {
	payload := []byte(`{"body":"x\u0000","received_at":1755800000123,"seq":9007199254740993}`)
	out, changed := stripNulls(payload)
	if !changed {
		t.Fatalf("payload carrying a NUL reported as unchanged")
	}
	if !strings.Contains(string(out), "1755800000123") {
		t.Fatalf("epoch was reformatted: %s", out)
	}
	if !strings.Contains(string(out), "9007199254740993") {
		t.Fatalf("integer beyond float64 precision was rounded: %s", out)
	}
}

func TestStripNullsHandlesNestedAndKeys(t *testing.T) {
	payload := []byte(`{"modems":[{"imei":"86\u00007018"}],"a\u0000b":"c"}`)
	out, changed := stripNulls(payload)
	if !changed {
		t.Fatalf("nested NUL reported as unchanged")
	}
	var decoded map[string]any
	if err := json.Unmarshal(out, &decoded); err != nil {
		t.Fatalf("result is not JSON: %v", err)
	}
	if _, ok := decoded["ab"]; !ok {
		t.Fatalf("key was not cleaned: %s", out)
	}
	modems, ok := decoded["modems"].([]any)
	if !ok || len(modems) != 1 {
		t.Fatalf("array was lost: %s", out)
	}
	entry, ok := modems[0].(map[string]any)
	if !ok || entry["imei"] != "867018" {
		t.Fatalf("nested value not cleaned: %s", out)
	}
}

// Anything that is not JSON is handed back untouched for Accept's own
// validation to reject, rather than being silently replaced with something else.
func TestStripNullsPassesThroughUndecodablePayloads(t *testing.T) {
	payload := []byte(`{"body":"\u0000`)
	out, changed := stripNulls(payload)
	if changed {
		t.Fatalf("truncated payload reported as changed")
	}
	if string(out) != string(payload) {
		t.Fatalf("truncated payload was rewritten")
	}
}
