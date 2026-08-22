// Package ingress is the cloud-side sequenced uplink journal.
//
// PostgreSQL is the durable home; this in-memory type is the policy used by
// both unit tests and a later SQL adapter. Duplicate (device_id, seq) with the
// same envelope is a no-op. The same seq with different bytes is a conflict.
package ingress

import (
	"bytes"
	"errors"
	"fmt"
	"sync"
)

const (
	// MaxMissingRanges is the protocol cap on recovery-hole hints.
	MaxMissingRanges = 128
)

var (
	// ErrConflict indicates the same device sequence arrived with different content.
	ErrConflict = errors.New("sequence conflict")
	// ErrInvalidRecord indicates a sequenced envelope is missing required fields.
	ErrInvalidRecord = errors.New("invalid ingress record")
)

// Store is the cloud ingress journal. PostgreSQL is the durable home; the
// in-memory Journal is the unit-test double and the policy prototype.
type Store interface {
	Accept(record Record) (Result, error)
	Snapshot(tenantID, deviceID string) (Window, error)
	// RecordUnstorable fills a sequence the real record can never occupy, so
	// the contiguous prefix can advance past it. See ErrMalformed.
	RecordUnstorable(record Record, reason string) error
}

// Record is one sequenced uplink envelope after authentication.
type Record struct {
	TenantID   string
	DeviceID   string
	EnvelopeID string
	Seq        uint64
	Kind       string
	Payload    []byte
}

// Status is the durable outcome of one Accept call.
type Status int

const (
	// StatusInserted means this sequence was new.
	StatusInserted Status = iota
	// StatusDuplicate means a retry of identical content.
	StatusDuplicate
)

// Range is an inclusive sequence hole above the contiguous cursor.
type Range struct {
	From    uint64
	Through uint64
}

// Window is the durable contiguous prefix and a bounded hint of holes above it.
type Window struct {
	CommittedThrough uint64
	MissingRanges    []Range
	MoreMissing      bool
}

// Result is returned after a successful Accept.
type Result struct {
	Status Status
	Window Window
}

// Journal holds per-device sequence state.
type Journal struct {
	mu      sync.Mutex
	devices map[string]*deviceJournal
}

type deviceJournal struct {
	bySeq     map[uint64]Record
	committed uint64
}

// NewJournal returns an empty ingress journal.
func NewJournal() *Journal {
	return &Journal{devices: make(map[string]*deviceJournal)}
}

// Accept records a sequenced envelope and advances the contiguous cursor.
func (journal *Journal) Accept(record Record) (Result, error) {
	if record.DeviceID == "" || record.EnvelopeID == "" || record.Seq == 0 || record.Kind == "" {
		return Result{}, fmt.Errorf("%w: device, envelope, seq, and kind are required", ErrInvalidRecord)
	}

	journal.mu.Lock()
	defer journal.mu.Unlock()

	device := journal.devices[record.DeviceID]
	if device == nil {
		device = &deviceJournal{bySeq: make(map[uint64]Record)}
		journal.devices[record.DeviceID] = device
	}

	if existing, ok := device.bySeq[record.Seq]; ok {
		if existing.EnvelopeID != record.EnvelopeID || existing.Kind != record.Kind || !bytes.Equal(existing.Payload, record.Payload) {
			return Result{}, fmt.Errorf("%w: device %s seq %d", ErrConflict, record.DeviceID, record.Seq)
		}
		return Result{Status: StatusDuplicate, Window: device.window()}, nil
	}

	device.bySeq[record.Seq] = record
	for {
		next := device.committed + 1
		if _, ok := device.bySeq[next]; !ok {
			break
		}
		device.committed = next
	}
	return Result{Status: StatusInserted, Window: device.window()}, nil
}

// RecordUnstorable stands in for a record this store cannot hold, so the
// contiguous prefix advances past it instead of stopping on it.
//
// The in-memory journal has no storage constraints to violate, so nothing
// reaches here in practice; it exists so tests and the memory-backed
// deployment satisfy Store with the same semantics as PostgreSQL.
func (journal *Journal) RecordUnstorable(record Record, reason string) error {
	tombstone := record
	tombstone.Kind = "Unstorable"
	tombstone.Payload = []byte(`{"original_kind":"` + record.Kind + `"}`)
	_ = reason
	_, err := journal.Accept(tombstone)
	if errors.Is(err, ErrConflict) {
		// The sequence is already filled. That is the outcome we wanted.
		return nil
	}
	return err
}

// Snapshot is the durable contiguous prefix for a device.
func (journal *Journal) Snapshot(tenantID, deviceID string) (Window, error) {
	_ = tenantID
	journal.mu.Lock()
	defer journal.mu.Unlock()
	device := journal.devices[deviceID]
	if device == nil {
		return Window{MissingRanges: []Range{}}, nil
	}
	return device.window(), nil
}

// CommittedThrough is the contiguous prefix durably recorded for a device.
func (journal *Journal) CommittedThrough(deviceID string) uint64 {
	window, _ := journal.Snapshot("", deviceID)
	return window.CommittedThrough
}

func (device *deviceJournal) window() Window {
	var last uint64
	for seq := range device.bySeq {
		if seq > last {
			last = seq
		}
	}

	ranges := make([]Range, 0)
	more := false
	inHole := false
	var from, through uint64
	for seq := device.committed + 1; seq <= last; seq++ {
		_, have := device.bySeq[seq]
		if !have {
			if !inHole {
				if len(ranges) == MaxMissingRanges {
					more = true
					break
				}
				from = seq
				inHole = true
			}
			through = seq
			continue
		}
		if inHole {
			ranges = append(ranges, Range{From: from, Through: through})
			inHole = false
		}
	}
	if inHole {
		if len(ranges) == MaxMissingRanges {
			more = true
		} else {
			ranges = append(ranges, Range{From: from, Through: through})
		}
	}
	return Window{
		CommittedThrough: device.committed,
		MissingRanges:    ranges,
		MoreMissing:      more,
	}
}
