package wss

import (
	"encoding/json"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/identity"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/ingress"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/session"
	contract "github.com/vodoge/vodoge-cloud/packages/contract"
)

func TestServeDeviceAcksResumeAndIdempotentIngest(t *testing.T) {
	t.Parallel()

	device := identity.Device{
		TenantID: "11111111-1111-1111-1111-111111111111",
		DeviceID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		Region:   "cn",
	}
	now := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	smsPayload, err := json.Marshal(contract.SmsReceivedPayload{
		ModemImei:  "867018069509705",
		Peer:       "10086",
		Body:       "ok",
		ReceivedAt: now.UnixMilli(),
		Iccid:      "89860000000000000000",
		Bearer:     "sim1",
		Encoding:   "gsm7",
	})
	if err != nil {
		t.Fatal(err)
	}

	conn := newMemoryConn(
		mustEnvelope(t, contract.Envelope{
			V: contract.ProtocolVersion, Kind: contract.MessageKindResume,
			ID: "11111111-1111-4111-8111-111111111111", Ts: now.UnixMilli(), DeviceID: device.DeviceID,
			Payload: mustJSON(t, contract.ResumePayload{
				ConnectionID:            "22222222-2222-4222-8222-222222222222",
				LastAssignedSeq:         "1",
				LastAckedSeq:            "0",
				PendingGapIds:           []string{},
				CapabilityMatrixVersion: "1",
			}),
		}),
		mustEnvelope(t, contract.Envelope{
			V: contract.ProtocolVersion, Kind: contract.MessageKindSmsReceived,
			ID: "33333333-3333-4333-8333-333333333333", Ts: now.UnixMilli(), DeviceID: device.DeviceID,
			Seq: stringPtr("1"), Payload: smsPayload,
		}),
		mustEnvelope(t, contract.Envelope{
			V: contract.ProtocolVersion, Kind: contract.MessageKindSmsReceived,
			ID: "33333333-3333-4333-8333-333333333333", Ts: now.UnixMilli(), DeviceID: device.DeviceID,
			Seq: stringPtr("1"), Payload: smsPayload,
		}),
	)

	server := &Server{
		Region:  "cn",
		Hub:     session.NewHub(),
		Journal: ingress.NewJournal(),
		Now:     func() time.Time { return now },
	}
	if err := server.ServeDevice(device, conn); !errors.Is(err, io.EOF) {
		t.Fatalf("ServeDevice() error = %v, want EOF", err)
	}

	if conn.nwrites() != 3 {
		t.Fatalf("writes = %d, want ResumeAck + two UplinkAck", conn.nwrites())
	}
	resumeAck := decodeWritten(t, conn.written(0))
	if resumeAck.Kind != contract.MessageKindResumeAck {
		t.Fatalf("first write kind = %s", resumeAck.Kind)
	}
	var ack contract.ResumeAckPayload
	if err := json.Unmarshal(resumeAck.Payload, &ack); err != nil {
		t.Fatal(err)
	}
	if ack.ConnectionID != "22222222-2222-4222-8222-222222222222" || ack.CommittedThrough != "0" {
		t.Fatalf("resume ack = %+v", ack)
	}

	first := decodeWritten(t, conn.written(1))
	second := decodeWritten(t, conn.written(2))
	if first.Kind != contract.MessageKindUplinkAck || second.Kind != contract.MessageKindUplinkAck {
		t.Fatalf("ingest writes = %s, %s", first.Kind, second.Kind)
	}
	var uplink contract.UplinkAckPayload
	if err := json.Unmarshal(first.Payload, &uplink); err != nil {
		t.Fatal(err)
	}
	if uplink.CommittedThrough != "1" {
		t.Fatalf("committed = %s, want 1", uplink.CommittedThrough)
	}
	window, err := server.Journal.Snapshot(device.TenantID, device.DeviceID)
	if err != nil {
		t.Fatal(err)
	}
	if window.CommittedThrough != 1 {
		t.Fatal("duplicate ingest must not create a second sequence")
	}
	if _, online := server.Hub.Lookup(device.DeviceID); online {
		t.Fatal("connection must unbind when the socket ends")
	}
}

func TestServeDeviceAnswersPingAndRejectsWrongFirstKind(t *testing.T) {
	t.Parallel()

	device := identity.Device{TenantID: "t", DeviceID: "dev-1", Region: "intl"}
	now := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	conn := newMemoryConn(
		mustEnvelope(t, contract.Envelope{
			V: contract.ProtocolVersion, Kind: contract.MessageKindResume,
			ID: "11111111-1111-4111-8111-111111111111", Ts: now.UnixMilli(), DeviceID: device.DeviceID,
			Payload: mustJSON(t, contract.ResumePayload{
				ConnectionID:            "conn-1",
				LastAssignedSeq:         "0",
				LastAckedSeq:            "0",
				PendingGapIds:           []string{},
				CapabilityMatrixVersion: "1",
			}),
		}),
		mustEnvelope(t, contract.Envelope{
			V: contract.ProtocolVersion, Kind: contract.MessageKindPing,
			ID: "ping-1", Ts: now.UnixMilli(), DeviceID: device.DeviceID,
			Payload: mustJSON(t, contract.PingPayload{ConnectionID: "conn-1", SentAt: now.UnixMilli()}),
		}),
	)
	server := &Server{Hub: session.NewHub(), Journal: ingress.NewJournal(), Now: func() time.Time { return now }}
	if err := server.ServeDevice(device, conn); !errors.Is(err, io.EOF) {
		t.Fatalf("ServeDevice() error = %v", err)
	}
	pong := decodeWritten(t, conn.written(1))
	if pong.Kind != contract.MessageKindPong {
		t.Fatalf("second write = %s, want Pong", pong.Kind)
	}

	bad := newMemoryConn(mustEnvelope(t, contract.Envelope{
		V: contract.ProtocolVersion, Kind: contract.MessageKindPing,
		ID: "ping-1", Ts: now.UnixMilli(), DeviceID: device.DeviceID,
		Payload: mustJSON(t, contract.PingPayload{ConnectionID: "conn-1", SentAt: now.UnixMilli()}),
	}))
	err := (&Server{Hub: session.NewHub(), Journal: ingress.NewJournal(), Now: func() time.Time { return now }}).
		ServeDevice(device, bad)
	if err == nil || err.Error() != "first envelope must be Resume" {
		t.Fatalf("wrong first kind err = %v", err)
	}
}

type memoryConn struct {
	inbound  [][]byte
	outbound [][]byte
	closed   bool
}

func newMemoryConn(frames ...[]byte) *memoryConn {
	return &memoryConn{inbound: frames}
}

func (conn *memoryConn) ReadMessage() (int, []byte, error) {
	if conn.closed {
		return 0, nil, io.ErrClosedPipe
	}
	if len(conn.inbound) == 0 {
		return 0, nil, io.EOF
	}
	frame := conn.inbound[0]
	conn.inbound = conn.inbound[1:]
	return websocket.BinaryMessage, frame, nil
}

func (conn *memoryConn) WriteMessage(_ int, data []byte) error {
	if conn.closed {
		return io.ErrClosedPipe
	}
	copied := append([]byte(nil), data...)
	conn.outbound = append(conn.outbound, copied)
	return nil
}

func (conn *memoryConn) SetReadDeadline(time.Time) error { return nil }

func (conn *memoryConn) Close() error {
	conn.closed = true
	return nil
}

func (conn *memoryConn) nwrites() int { return len(conn.outbound) }

func (conn *memoryConn) written(i int) []byte { return conn.outbound[i] }

func mustJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func mustEnvelope(t *testing.T, envelope contract.Envelope) []byte {
	t.Helper()
	raw, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func decodeWritten(t *testing.T, frame []byte) contract.Envelope {
	t.Helper()
	var envelope contract.Envelope
	if err := json.Unmarshal(frame, &envelope); err != nil {
		t.Fatal(err)
	}
	return envelope
}

func stringPtr(value string) *string { return &value }
