package enroll

import (
	"context"
	"crypto/rand"
	"fmt"
	"strings"
	"sync"
	"time"
)

type memoryCode struct {
	TenantID  string
	Region    string
	ExpiresAt time.Time
	UsedAt    time.Time
	DeviceID  string
}

// Memory is an in-process issuer used by tests and CA-less local runs.
type Memory struct {
	mu    sync.Mutex
	codes map[string]memoryCode
	certs []CertificateRecord
	now   func() time.Time
	newID func() (string, error)
}

// NewMemory returns an empty enrollment issuer.
func NewMemory() *Memory {
	return &Memory{codes: make(map[string]memoryCode)}
}

func (memory *Memory) clock() time.Time {
	if memory != nil && memory.now != nil {
		return memory.now()
	}
	return time.Now()
}

// Put stores a one-time code for tenantID. Region is copied onto the certificate OU.
func (memory *Memory) Put(tenantID, code, region string, expiresAt time.Time) {
	memory.mu.Lock()
	defer memory.mu.Unlock()
	if memory.codes == nil {
		memory.codes = make(map[string]memoryCode)
	}
	memory.codes[strings.TrimSpace(code)] = memoryCode{
		TenantID:  strings.TrimSpace(tenantID),
		Region:    strings.TrimSpace(region),
		ExpiresAt: expiresAt,
	}
}

// Issue consumes the code, signs through sign, and records serial/fingerprint.
func (memory *Memory) Issue(ctx context.Context, tenantID, code, hint string, sign func(Consumed) (CertificateRecord, error)) (CertificateRecord, error) {
	_ = ctx
	_ = hint
	memory.mu.Lock()
	defer memory.mu.Unlock()

	tenantID = strings.TrimSpace(tenantID)
	code = strings.TrimSpace(code)
	record, ok := memory.codes[code]
	if !ok {
		return CertificateRecord{}, ErrNotFound
	}
	if record.TenantID != tenantID {
		return CertificateRecord{}, ErrWrongTenant
	}
	if !record.UsedAt.IsZero() {
		return CertificateRecord{}, ErrUsed
	}
	if !record.ExpiresAt.After(memory.clock()) {
		return CertificateRecord{}, ErrExpired
	}

	deviceID, err := memory.allocateID()
	if err != nil {
		return CertificateRecord{}, err
	}
	consumed := Consumed{TenantID: tenantID, DeviceID: deviceID, Region: record.Region}
	issued, err := sign(consumed)
	if err != nil {
		return CertificateRecord{}, err
	}

	record.UsedAt = memory.clock()
	record.DeviceID = deviceID
	memory.codes[code] = record
	memory.certs = append(memory.certs, issued)
	return issued, nil
}

func (memory *Memory) allocateID() (string, error) {
	if memory.newID != nil {
		return memory.newID()
	}
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:]), nil
}
