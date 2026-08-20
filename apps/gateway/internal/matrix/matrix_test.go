package matrix

import (
	"context"
	"encoding/json"
	"testing"
)

func TestParseFillsVersionAndDigest(t *testing.T) {
	t.Parallel()

	overlay, err := Parse([]byte(`{"version":"hot-1","rule":[]}`))
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
	overlay, err := Parse([]byte(`{"version":"hot-1","rule":[]}`))
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
	first, err := Parse([]byte(`{"version":"a"}`))
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
