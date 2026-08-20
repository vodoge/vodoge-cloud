package audit

import (
	"context"
	"testing"
)

func TestMemoryLogIsTenantScoped(t *testing.T) {
	t.Parallel()
	log := &Memory{}
	if err := log.Append(context.Background(), "t-a", Event{Actor: "gateway", Action: "update_capability_matrix", Target: "matrix"}); err != nil {
		t.Fatal(err)
	}
	if err := log.Append(context.Background(), "t-b", Event{Actor: "gateway", Action: "update_rule", Target: "rule"}); err != nil {
		t.Fatal(err)
	}
	a := log.ForTenant("t-a")
	if len(a) != 1 || a[0].Action != "update_capability_matrix" {
		t.Fatalf("tenant a = %+v", a)
	}
	if len(log.ForTenant("t-missing")) != 0 {
		t.Fatal("missing tenant saw events")
	}
}
