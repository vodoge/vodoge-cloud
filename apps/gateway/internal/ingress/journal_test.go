package ingress

import (
	"errors"
	"testing"
)

func TestAcceptAdvancesOnlyTheContiguousPrefix(t *testing.T) {
	t.Parallel()

	journal := NewJournal()
	for _, seq := range []uint64{1, 2, 4, 5} {
		result, err := journal.Accept(Record{
			DeviceID:   "dev-1",
			EnvelopeID: envelope(seq),
			Seq:        seq,
			Kind:       "SmsReceived",
			Payload:    []byte{byte(seq)},
		})
		if err != nil {
			t.Fatalf("seq %d: %v", seq, err)
		}
		if result.Status != StatusInserted {
			t.Fatalf("seq %d status = %v", seq, result.Status)
		}
	}
	window := journal.Snapshot("dev-1")
	if window.CommittedThrough != 2 {
		t.Fatalf("committed after hole = %d, want 2", window.CommittedThrough)
	}
	if len(window.MissingRanges) != 1 || window.MissingRanges[0] != (Range{From: 3, Through: 3}) {
		t.Fatalf("missing after hole = %+v, want [3,3]", window.MissingRanges)
	}

	result, err := journal.Accept(Record{
		DeviceID:   "dev-1",
		EnvelopeID: envelope(3),
		Seq:        3,
		Kind:       "SmsReceived",
		Payload:    []byte{3},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Window.CommittedThrough != 5 {
		t.Fatalf("committed after fill = %d, want 5", result.Window.CommittedThrough)
	}
	if len(result.Window.MissingRanges) != 0 {
		t.Fatalf("missing after fill = %+v", result.Window.MissingRanges)
	}
}

func TestAcceptDuplicateIsNoopAndConflictIsRejected(t *testing.T) {
	t.Parallel()

	journal := NewJournal()
	first, err := journal.Accept(Record{
		DeviceID: "dev-1", EnvelopeID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		Seq: 1, Kind: "SmsReceived", Payload: []byte("hello"),
	})
	if err != nil || first.Status != StatusInserted {
		t.Fatalf("first = %+v err=%v", first, err)
	}

	dup, err := journal.Accept(Record{
		DeviceID: "dev-1", EnvelopeID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		Seq: 1, Kind: "SmsReceived", Payload: []byte("hello"),
	})
	if err != nil || dup.Status != StatusDuplicate || dup.Window.CommittedThrough != 1 {
		t.Fatalf("duplicate = %+v err=%v", dup, err)
	}

	_, err = journal.Accept(Record{
		DeviceID: "dev-1", EnvelopeID: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
		Seq: 1, Kind: "SmsReceived", Payload: []byte("other"),
	})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("conflict err = %v", err)
	}
}

func TestAcceptRejectsInvalidRecords(t *testing.T) {
	t.Parallel()

	journal := NewJournal()
	_, err := journal.Accept(Record{DeviceID: "dev-1", EnvelopeID: "id", Seq: 0, Kind: "SmsReceived"})
	if !errors.Is(err, ErrInvalidRecord) {
		t.Fatalf("seq 0 err = %v", err)
	}
}

func envelope(seq uint64) string {
	return "00000000-0000-0000-0000-00000000000" + string('0'+rune(seq))
}
