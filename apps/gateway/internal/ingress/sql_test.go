package ingress

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestParseWindowDecodesDecimalRanges(t *testing.T) {
	t.Parallel()

	window, err := parseWindow(2, json.RawMessage(`[{"from":"3","through":"4"}]`), true)
	if err != nil {
		t.Fatal(err)
	}
	if window.CommittedThrough != 2 || !window.MoreMissing {
		t.Fatalf("window = %+v", window)
	}
	if len(window.MissingRanges) != 1 || window.MissingRanges[0] != (Range{From: 3, Through: 4}) {
		t.Fatalf("ranges = %+v", window.MissingRanges)
	}
}

func TestMapSQLErrorDetectsSequenceConflict(t *testing.T) {
	t.Parallel()

	err := mapSQLError(errors.New("ERROR: sequence conflict for device x seq 1 (SQLSTATE 23P01)"))
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("err = %v, want ErrConflict", err)
	}
}
