package cards

import (
	"context"
	"strings"
	"testing"
)

func TestAPolicyMustNameARealCard(t *testing.T) {
	t.Parallel()

	// A policy for something that is not an ICCID is pushed to every device
	// and matches no card on any of them — a silent no-op, which is worse
	// than an error because nothing ever reports it.
	for _, iccid := range []string{"", "8985", "not-a-number", "898520001463217957100"} {
		policy := Policy{ICCID: iccid}
		if err := Validate(&policy); err == nil {
			t.Fatalf("iccid %q should be refused", iccid)
		}
	}
	policy := Policy{ICCID: "8985200014632179571"}
	if err := Validate(&policy); err != nil {
		t.Fatal(err)
	}
	if policy.Vertical != "cn" {
		t.Fatalf("vertical = %q, want the cn default", policy.Vertical)
	}
}

// An empty APN means "no override". Storing it as an empty string would push
// one to the modem, which is a different instruction entirely.
func TestAnEmptyApnBecomesNoOverride(t *testing.T) {
	t.Parallel()

	blank := "   "
	policy := Policy{ICCID: "8985200014632179571", APN: &blank}
	if err := Validate(&policy); err != nil {
		t.Fatal(err)
	}
	if policy.APN != nil {
		t.Fatalf("apn = %q, want it absent", *policy.APN)
	}

	real := "  cmnet  "
	policy = Policy{ICCID: "8985200014632179571", APN: &real}
	if err := Validate(&policy); err != nil {
		t.Fatal(err)
	}
	if policy.APN == nil || *policy.APN != "cmnet" {
		t.Fatalf("apn = %v, want it trimmed", policy.APN)
	}
}

func TestVerticalIsAClosedSet(t *testing.T) {
	t.Parallel()

	policy := Policy{ICCID: "8985200014632179571", Vertical: "moon"}
	err := Validate(&policy)
	if err == nil || !strings.Contains(err.Error(), "cn or intl") {
		t.Fatalf("err = %v, want the allowed values named", err)
	}
}

// The version answers one question — is what a device holds the current set —
// so it has to move on every kind of change, including a deletion.
func TestTheVersionMovesOnEveryChange(t *testing.T) {
	t.Parallel()

	store := &Memory{}
	ctx := context.Background()
	first, _ := store.Version(ctx, "t")

	_ = store.Save(ctx, "t", Policy{ICCID: "8985200014632179571", CellularEnabled: true})
	afterAdd, _ := store.Version(ctx, "t")
	if afterAdd == first {
		t.Fatal("adding a policy did not move the version")
	}

	_ = store.Delete(ctx, "t", "8985200014632179571")
	afterDelete, _ := store.Version(ctx, "t")
	if afterDelete == afterAdd {
		t.Fatal("deleting a policy did not move the version")
	}
}

func TestPoliciesAreScopedToATenant(t *testing.T) {
	t.Parallel()

	store := &Memory{}
	ctx := context.Background()
	_ = store.Save(ctx, "t-a", Policy{ICCID: "8985200014632179571", CellularEnabled: true})
	_ = store.Save(ctx, "t-b", Policy{ICCID: "89852351225042214201", CellularEnabled: false})

	list, _ := store.List(ctx, "t-a")
	if len(list) != 1 || list[0].ICCID != "8985200014632179571" {
		t.Fatalf("tenant a sees %#v", list)
	}
}
