package ledger

import (
	"context"
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
	document := Document("test-1", []Entry{entry("EC20", "CN-Mobile")}, nil)
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
	document := Document("test-1", []Entry{entry("EC20", "CN-Mobile")}, nil)
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
	document := Document("test-1", []Entry{item}, nil)
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
	first, _ := json.Marshal(Document("test-1", entries, nil))
	reversed := []Entry{entries[1], entries[0]}
	second, _ := json.Marshal(Document("test-1", reversed, nil))
	if string(first) != string(second) {
		t.Fatalf("input order changed the document:\n%s\n%s", first, second)
	}
}

// 🔴 目录为空时，渲染出来的文档里**根本没有** `device` 键。
//
// 边缘端的 DeviceGate 分得很清：没有这个段是 NotStated（放行，向后兼容），
// 有段而某个硬件不在里面是 Absent（拒）。所以一个空的 `[[device]]` 列表会
// 拒掉**每一块**硬件 —— 和 `PUT /v1/capability-matrix` 收下
// `{"version":"x"}` 是同一个形状的灾难，那个已经在 matrix.Parse 里堵上了。
//
// 这一条尤其要紧，因为 app.supported_devices 建表之后**本来就是空的**：
// 少了这条规则，0057 上线那一刻整个机队全体过不了闸 1。
func TestAnEmptyCatalogueRendersNoDeviceSectionAtAll(t *testing.T) {
	for _, devices := range [][]SupportedDevice{nil, {}} {
		document := Document("test-1", []Entry{entry("EC20", "CN-Mobile")}, devices)
		if _, present := document["device"]; present {
			t.Fatalf("空目录渲染出了 device 段，那会拒掉每一块硬件: %#v", document["device"])
		}
	}
}

// 阴性对照：有条目就要渲染出来，而且形状要和边缘端的解析器对得上。
//
// 没有这条，上面那条可以靠「永远不渲染 device」通过 —— 那会让整个目录
// 功能静默失效，而且看起来一切正常。
func TestACatalogueWithEntriesIsRenderedForTheEdgeParser(t *testing.T) {
	note := "EC20 / EC25-CN / EG25-G，2026-08 台架验证"
	document := Document("test-1", []Entry{entry("EC20", "CN-Mobile")}, []SupportedDevice{
		{UsbVendor: "2c7c", UsbProduct: "0125", Strategy: "quectel-ec", Enabled: true, Note: &note},
		{UsbVendor: "2c7c", UsbProduct: "0901", Strategy: "quectel-ec200u", Enabled: false},
	})
	devices, ok := document["device"].([]map[string]any)
	if !ok || len(devices) != 2 {
		t.Fatalf("device = %#v", document["device"])
	}
	// 边缘端读的是 "vendor:product" 这一个串，不是两列。
	if devices[0]["usb"] != "2c7c:0125" {
		t.Fatalf("usb 拼错了: %#v", devices[0]["usb"])
	}
	if devices[0]["strategy"] != "quectel-ec" || devices[0]["enabled"] != true {
		t.Fatalf("第一条不对: %#v", devices[0])
	}
	if devices[0]["note"] != note {
		t.Fatalf("note 丢了: %#v", devices[0]["note"])
	}
	// enabled=false 必须原样传下去 —— 它是「明确停用」，和「不在列表里」
	// 在边缘端是两个不同的答案。
	if devices[1]["enabled"] != false {
		t.Fatalf("停用状态丢了: %#v", devices[1])
	}
	// 没有 note 的不该凭空长出一个空串。
	if _, present := devices[1]["note"]; present {
		t.Fatalf("给没有 note 的条目编了一个: %#v", devices[1])
	}
}

// NoDevices 渲染成「没有目录」，也就是这个能力上线前的行为。
func TestTheNoDevicesStandInRendersAsNoCatalogue(t *testing.T) {
	devices, err := NoDevices{}.ListSupportedDevices(context.Background())
	if err != nil {
		t.Fatalf("NoDevices 不该出错: %v", err)
	}
	document := Document("test-1", []Entry{entry("EC20", "CN-Mobile")}, devices)
	if _, present := document["device"]; present {
		t.Fatal("NoDevices 渲染出了 device 段")
	}
}
