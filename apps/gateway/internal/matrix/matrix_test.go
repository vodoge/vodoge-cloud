package matrix

import (
	"context"
	"encoding/json"
	"testing"
)

func TestParseFillsVersionAndDigest(t *testing.T) {
	t.Parallel()

	// fixture 里带一条规则：这条测的是 version 与摘要，规则内容无关紧要，
	// 但不能为空 —— 空矩阵现在会被 Parse 拒绝，理由见那里（一份没有规则的
	// 矩阵会清空收到它的每一台设备）。
	overlay, err := Parse([]byte(`{"version":"hot-1","rule":[{"modem_family":"EC20","carrier":"CN-Mobile","sms_mo":{"kind":"probe"}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if overlay.Version != "hot-1" {
		t.Fatalf("version = %q", overlay.Version)
	}
	if overlay.SHA256 == "" {
		t.Fatal("sha256 is empty")
	}

	again, err := Parse(overlay.Document)
	if err != nil {
		t.Fatal(err)
	}
	if again.SHA256 != overlay.SHA256 {
		t.Fatalf("canonical digest drifted: %s vs %s", again.SHA256, overlay.SHA256)
	}
}

func TestParseRejectsANonObject(t *testing.T) {
	t.Parallel()
	if _, err := Parse([]byte(`["nope"]`)); err == nil {
		t.Fatal("expected error")
	}
}

func TestCommandPayloadEmbedsTheMatrixObject(t *testing.T) {
	t.Parallel()
	// 同上：这条测的是 CommandPayload 的包装。
	overlay, err := Parse([]byte(`{"version":"hot-1","rule":[{"modem_family":"EC20","carrier":"CN-Mobile","sms_mo":{"kind":"probe"}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	payload, err := CommandPayload(overlay)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatal(err)
	}
	if body["kind"] != "UpdateCapabilityMatrix" {
		t.Fatalf("kind = %#v", body["kind"])
	}
	matrix, ok := body["matrix"].(map[string]any)
	if !ok || matrix["version"] != "hot-1" {
		t.Fatalf("matrix = %#v", body["matrix"])
	}
}

func TestMemoryStoreIsTenantScoped(t *testing.T) {
	t.Parallel()
	store := &Memory{}
	// 同上：这条测的是租户隔离，规则内容无关紧要，但不能为空。
	first, err := Parse([]byte(`{"version":"a","rule":[{"modem_family":"EC20","carrier":"CN-Mobile","sms_mo":{"kind":"probe"}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Put(context.Background(), "t-a", first); err != nil {
		t.Fatal(err)
	}
	_, ok, err := store.Get(context.Background(), "t-b")
	if err != nil || ok {
		t.Fatalf("tenant b saw tenant a overlay ok=%v err=%v", ok, err)
	}
}

// 🔴 一份没有规则的矩阵不该被接受。
//
// `{"version":"x"}` 此前一路畅通：Parse 只看「是合法 JSON、是对象、
// version 非空」，于是它落库、被推给该租户的**每一台设备**，而边缘端也接受
// 它——`MatrixDocument.rule` 是 `#[serde(default)]`，所以它解析成一个**空矩阵**。
//
// 实测（2026-09-05，edge-core）：
//
//	接受了。version=attack
//	规则数=0
//	EC20 x CN-Mobile 的来源=Fallback
//
// 后果是整个机队的能力矩阵清零：每一对都读作「从没测过」，短信全被拒，
// 而纳管的追溯执行会把每一根都判进隔离。一次普通租户会话的 PUT 就能做到。
//
// 清空矩阵如果真有正当用途，它该是一个**明确的、另外的**动作，
// 而不是一份少写了字段的请求体的副产品。
func TestAnEmptyMatrixIsRefused(t *testing.T) {
	for _, body := range []string{
		`{"version":"attack"}`,
		`{"version":"attack","rule":[]}`,
		`{"version":"attack","fallback":{"sms_mo":{"kind":"probe"}}}`,
	} {
		if _, err := Parse([]byte(body)); err == nil {
			t.Fatalf("接受了一份没有规则的矩阵，它会清空整个机队: %s", body)
		}
	}
}

// 阴性对照：有规则的照旧通过。
//
// 没有这条，上面那条可以靠「拒绝一切」通过，而那会让矩阵再也推不下去。
func TestAMatrixWithRulesIsStillAccepted(t *testing.T) {
	body := `{"version":"2026-09-01","rule":[{"modem_family":"EC20","carrier":"CN-Mobile",` +
		`"sms_mo":{"kind":"supported","bearer":"cellular"}}]}`
	overlay, err := Parse([]byte(body))
	if err != nil {
		t.Fatalf("拒绝了一份正常的矩阵: %v", err)
	}
	if overlay.Version != "2026-09-01" {
		t.Fatalf("version 解析错了: %q", overlay.Version)
	}
	if overlay.SHA256 == "" {
		t.Fatalf("摘要空了")
	}
}
