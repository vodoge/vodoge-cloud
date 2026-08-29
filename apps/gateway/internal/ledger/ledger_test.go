package ledger

import (
	"encoding/json"
	"testing"
)

func value(text string) *string { return &text }

func entry(family, carrier string) Entry {
	return Entry{
		ModemFamily: family,
		Carrier:     carrier,
		SmsMo:       value("supported"),
		Bearer:      "cellular",
		TestedBy:    "yuanshuai",
	}
}

// A row is a claim somebody made, so it has to name them.
func TestAMeasurementNamesWhoTookIt(t *testing.T) {
	item := entry("EC20", "CN-Mobile")
	item.TestedBy = "  "
	if err := Validate(&item); err == nil {
		t.Fatal("a row with nobody behind it was accepted")
	}
}

// A row that measured nothing is not a measurement, and admitting one would
// put a pairing in the ledger -- making it supported -- on an empty form.
func TestARowThatMeasuredNothingIsRejected(t *testing.T) {
	item := Entry{ModemFamily: "EC20", Carrier: "CN-Mobile", TestedBy: "yuanshuai"}
	if err := Validate(&item); err == nil {
		t.Fatal("an empty measurement was accepted")
	}
}

// The names travel into the pushed document as keys. One with a quote or a
// newline would reach every device and match no module on any of them.
func TestANameThatCannotBeAMatrixKeyIsRejected(t *testing.T) {
	for _, bad := range []string{"EC20\"", "CN Mobile", "EC20\nEC25", ""} {
		item := entry(bad, "CN-Mobile")
		if err := Validate(&item); err == nil {
			t.Fatalf("%q was accepted as a modem family", bad)
		}
	}
}

func TestAnUnknownSupportValueIsRejected(t *testing.T) {
	item := entry("EC20", "CN-Mobile")
	item.SmsMo = value("maybe")
	if err := Validate(&item); err == nil {
		t.Fatal("an invented support value was accepted")
	}
}

// The rendered document is what the edge parses, and the edge treats a pairing
// with no rule as untested. A fallback emitted here would override that with
// whatever this console happened to think.
func TestTheRenderedDocumentCarriesNoFallback(t *testing.T) {
	document := Document("test-1", []Entry{entry("EC20", "CN-Mobile")})
	if _, present := document["fallback"]; present {
		t.Fatal("a fallback would decide for hardware nobody has measured")
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var round map[string]any
	if err := json.Unmarshal(encoded, &round); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	rules, ok := round["rule"].([]any)
	if !ok || len(rules) != 1 {
		t.Fatalf("expected one rule, got %v", round["rule"])
	}
	rule := rules[0].(map[string]any)
	if rule["modem_family"] != "EC20" || rule["carrier"] != "CN-Mobile" {
		t.Fatalf("the key did not survive rendering: %v", rule)
	}
	smsMo := rule["sms_mo"].(map[string]any)
	if smsMo["kind"] != "supported" || smsMo["bearer"] != "cellular" {
		t.Fatalf("sms_mo rendered as %v", smsMo)
	}
}

// An operation the measurement did not cover must be absent from the rule, not
// present as something. Emitting `probe` for it would record a decision nobody
// made; emitting `supported` would be a claim nobody tested.
func TestAnUnmeasuredOperationIsAbsentFromTheRule(t *testing.T) {
	document := Document("test-1", []Entry{entry("EC20", "CN-Mobile")})
	rule := document["rule"].([]map[string]any)[0]
	for _, absent := range []string{"sms_mt", "data", "voice"} {
		if _, present := rule[absent]; present {
			t.Fatalf("%s was not measured but appears in the rule", absent)
		}
	}
}

// A measured refusal carries its reason to the device, which is what turns a
// refusal into something an operator can act on.
func TestAMeasuredRefusalCarriesItsReason(t *testing.T) {
	item := entry("EC20", "CN-Telecom")
	item.SmsMo = value("unsupported")
	item.Reason = value("no_cdma_fallback_and_no_ct_volte_mbn")
	document := Document("test-1", []Entry{item})
	rule := document["rule"].([]map[string]any)[0]
	smsMo := rule["sms_mo"].(map[string]any)
	if smsMo["kind"] != "unsupported" {
		t.Fatalf("sms_mo rendered as %v", smsMo)
	}
	if smsMo["reason"] != "no_cdma_fallback_and_no_ct_volte_mbn" {
		t.Fatalf("the reason did not survive: %v", smsMo)
	}
}

// Rendering is ordered, so pushing an unchanged ledger produces unchanged
// bytes -- which is what the device's digest check compares.
func TestRenderingIsStable(t *testing.T) {
	entries := []Entry{entry("EG25-G", "CN-Unicom"), entry("EC20", "CN-Mobile")}
	first, _ := json.Marshal(Document("test-1", entries))
	reversed := []Entry{entries[1], entries[0]}
	second, _ := json.Marshal(Document("test-1", reversed))
	if string(first) != string(second) {
		t.Fatalf("input order changed the document:\n%s\n%s", first, second)
	}
}
