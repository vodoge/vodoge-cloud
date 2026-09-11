package wss

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/dispatch"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/identity"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/ingress"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/session"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/wakeup"
	contract "github.com/vodoge/vodoge-cloud/packages/contract"
)

// 台架那张卡。SmsReceivedPayload.Iccid 现在是 *string —— 契约把它改成了
// 「必填但可为 null」，因为一条短信收下时未必读得出卡号，而空串会被下游
// 读成「这条没有卡」，是个看着合理的错答案。
var benchCard = "89860000000000000000"

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
		Iccid:      &benchCard,
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

func TestServeDevicePublishesNewUplinkEvents(t *testing.T) {
	t.Parallel()

	device := identity.Device{
		TenantID: "11111111-1111-1111-1111-111111111111",
		DeviceID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		Region:   "cn",
	}
	now := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	smsPayload, err := json.Marshal(contract.SmsReceivedPayload{
		ModemImei: "867018069509705", Peer: "10086", Body: "ok",
		ReceivedAt: now.UnixMilli(), Iccid: &benchCard,
		Bearer: "sim1", Encoding: "gsm7",
	})
	if err != nil {
		t.Fatal(err)
	}

	publisher := &recordingWakeups{}
	server := &Server{
		Region:  "cn",
		Hub:     session.NewHub(),
		Journal: ingress.NewJournal(),
		Wakeups: publisher,
		Now:     func() time.Time { return now },
	}
	conn := newMemoryConn(
		mustEnvelope(t, contract.Envelope{
			V: contract.ProtocolVersion, Kind: contract.MessageKindResume,
			ID: "11111111-1111-4111-8111-111111111111", Ts: now.UnixMilli(), DeviceID: device.DeviceID,
			Payload: mustJSON(t, contract.ResumePayload{
				ConnectionID:    "22222222-2222-4222-8222-222222222222",
				LastAssignedSeq: "1", LastAckedSeq: "0",
				PendingGapIds: []string{}, CapabilityMatrixVersion: "1",
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
	if err := server.ServeDevice(device, conn); !errors.Is(err, io.EOF) {
		t.Fatalf("ServeDevice() error = %v, want EOF", err)
	}
	if conn.nwrites() != 3 {
		t.Fatalf("writes = %d, want ResumeAck + two UplinkAck", conn.nwrites())
	}
	if len(publisher.devices) == 0 {
		t.Fatal("resume must register device presence")
	}
	if len(publisher.events) != 1 {
		t.Fatalf("events = %d, want 1 new uplink (duplicate must not republish)", len(publisher.events))
	}
	got := publisher.events[0]
	if got.TenantID != device.TenantID || got.DeviceID != device.DeviceID || got.Seq != 1 || got.Kind != string(contract.MessageKindSmsReceived) {
		t.Fatalf("event = %+v", got)
	}
}

func TestServeDeviceAcksUplinkWhenWakeupPublisherFails(t *testing.T) {
	t.Parallel()

	device := identity.Device{TenantID: "t", DeviceID: "dev-1", Region: "intl"}
	now := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	smsPayload, err := json.Marshal(contract.SmsReceivedPayload{
		ModemImei: "867018069509705", Peer: "10086", Body: "ok",
		ReceivedAt: now.UnixMilli(), Iccid: &benchCard,
		Bearer: "sim1", Encoding: "gsm7",
	})
	if err != nil {
		t.Fatal(err)
	}

	server := &Server{
		Hub:     session.NewHub(),
		Journal: ingress.NewJournal(),
		Wakeups: wakeup.Failing{},
		Now:     func() time.Time { return now },
	}
	conn := newMemoryConn(
		mustEnvelope(t, contract.Envelope{
			V: contract.ProtocolVersion, Kind: contract.MessageKindResume,
			ID: "11111111-1111-4111-8111-111111111111", Ts: now.UnixMilli(), DeviceID: device.DeviceID,
			Payload: mustJSON(t, contract.ResumePayload{
				ConnectionID: "conn-1", LastAssignedSeq: "1", LastAckedSeq: "0",
				PendingGapIds: []string{}, CapabilityMatrixVersion: "1",
			}),
		}),
		mustEnvelope(t, contract.Envelope{
			V: contract.ProtocolVersion, Kind: contract.MessageKindSmsReceived,
			ID: "33333333-3333-4333-8333-333333333333", Ts: now.UnixMilli(), DeviceID: device.DeviceID,
			Seq: stringPtr("1"), Payload: smsPayload,
		}),
	)
	if err := server.ServeDevice(device, conn); !errors.Is(err, io.EOF) {
		t.Fatalf("ServeDevice() error = %v, want EOF (failed publish must not fail Accept)", err)
	}
	if conn.nwrites() != 2 {
		t.Fatalf("writes = %d, want ResumeAck + UplinkAck", conn.nwrites())
	}
	uplink := decodeWritten(t, conn.written(1))
	if uplink.Kind != contract.MessageKindUplinkAck {
		t.Fatalf("second write = %s, want UplinkAck", uplink.Kind)
	}
	window, err := server.Journal.Snapshot(device.TenantID, device.DeviceID)
	if err != nil {
		t.Fatal(err)
	}
	if window.CommittedThrough != 1 {
		t.Fatalf("committed = %d, want 1", window.CommittedThrough)
	}
}

type recordingWakeups struct {
	devices []string
	events  []wakeup.Event
}

func (r *recordingWakeups) PublishWakeup(context.Context, dispatch.Wakeup) error { return nil }

func (r *recordingWakeups) RegisterDevice(_ context.Context, deviceID string) error {
	r.devices = append(r.devices, deviceID)
	return nil
}

func (r *recordingWakeups) PublishEvent(_ context.Context, event wakeup.Event) error {
	r.events = append(r.events, event)
	return nil
}

type staticPending struct {
	items []dispatch.PendingCommand
}

func (s staticPending) PendingForDevice(string, string, time.Time) []dispatch.PendingCommand {
	return s.items
}

func TestServeDeviceDeliversQueuedCommandsAfterResume(t *testing.T) {
	t.Parallel()

	device := identity.Device{TenantID: "t", DeviceID: "dev-1", Region: "cn"}
	now := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	conn := newMemoryConn(mustEnvelope(t, contract.Envelope{
		V: contract.ProtocolVersion, Kind: contract.MessageKindResume,
		ID: "11111111-1111-4111-8111-111111111111", Ts: now.UnixMilli(), DeviceID: device.DeviceID,
		Payload: mustJSON(t, contract.ResumePayload{
			ConnectionID: "conn-1", LastAssignedSeq: "0", LastAckedSeq: "0",
			PendingGapIds: []string{}, CapabilityMatrixVersion: "1",
		}),
	}))
	server := &Server{
		Hub:     session.NewHub(),
		Journal: ingress.NewJournal(),
		Now:     func() time.Time { return now },
		Commands: staticPending{items: []dispatch.PendingCommand{{
			Attempt: 1,
			Command: dispatch.Command{
				TenantID: device.TenantID, ID: "cmd-1", DeviceID: device.DeviceID,
				Kind: "send_sms", Payload: []byte(`{"kind":"send_sms","to":"10086","body":"hi"}`),
				IssuedAt: now, ExpiresAt: now.Add(time.Hour),
			},
		}}},
	}
	if err := server.ServeDevice(device, conn); !errors.Is(err, io.EOF) {
		t.Fatalf("ServeDevice() error = %v", err)
	}
	if conn.nwrites() < 2 {
		t.Fatalf("writes = %d, want ResumeAck + CommandDeliver", conn.nwrites())
	}
	deliver := decodeWritten(t, conn.written(1))
	if deliver.Kind != contract.MessageKindCommandDeliver {
		t.Fatalf("second write = %s, want CommandDeliver", deliver.Kind)
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

// A command issued to a device that is already connected used to sit in the
// queue until the link happened to drop, because pending commands were
// delivered only at Resume.
//
// Hooking it to the heartbeat was the first fix and did not work: a device
// that polls its modems every eight seconds never goes idle long enough to
// send one, so the commands sat queued while the session was healthy. Any
// inbound envelope triggers the check now — here, an uplink record rather
// than a Ping, which is what a busy device actually sends.
func TestTrafficFromABusyDeviceDeliversQueuedWork(t *testing.T) {
	t.Parallel()

	device := identity.Device{TenantID: "t", DeviceID: "dev-1", Region: "cn"}
	now := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)

	// A session that resumes with nothing queued, then heartbeats.
	pending := &appearingPending{}
	conn := newMemoryConn(
		mustEnvelope(t, contract.Envelope{
			V: contract.ProtocolVersion, Kind: contract.MessageKindResume,
			ID: "11111111-1111-4111-8111-111111111111", Ts: now.UnixMilli(),
			DeviceID: device.DeviceID,
			Payload: mustJSON(t, contract.ResumePayload{
				ConnectionID: "conn-1", LastAssignedSeq: "0", LastAckedSeq: "0",
				PendingGapIds: []string{}, CapabilityMatrixVersion: "1",
			}),
		}),
		mustEnvelope(t, contract.Envelope{
			V: contract.ProtocolVersion, Kind: contract.MessageKindPing,
			ID: "22222222-2222-4222-8222-222222222222", Ts: now.UnixMilli(),
			DeviceID: device.DeviceID,
			Payload:  mustJSON(t, contract.PingPayload{ConnectionID: "conn-1"}),
		}),
	)
	server := &Server{
		Hub:     session.NewHub(),
		Journal: ingress.NewJournal(),
		// The pending check is rate limited to five seconds, so the clock has
		// to move past that between the resume and the envelope.
		Now:      advancingClock(now),
		Commands: pending,
	}
	if err := server.ServeDevice(device, conn); !errors.Is(err, io.EOF) {
		t.Fatalf("ServeDevice() error = %v", err)
	}

	var delivered bool
	for i := 0; i < conn.nwrites(); i++ {
		if decodeWritten(t, conn.written(i)).Kind == contract.MessageKindCommandDeliver {
			delivered = true
		}
	}
	if !delivered {
		t.Fatal("a command queued mid-session was never delivered")
	}
}

// Answers nothing on the first ask and one command afterwards, standing in for
// a console issuing a command while the session is already up.
type appearingPending struct {
	asked int
}

func (p *appearingPending) PendingForDevice(
	tenantID, deviceID string,
	now time.Time,
) []dispatch.PendingCommand {
	p.asked++
	if p.asked == 1 {
		return nil
	}
	return []dispatch.PendingCommand{{
		Attempt: 1,
		Command: dispatch.Command{
			TenantID: tenantID, ID: "cmd-late", DeviceID: deviceID,
			Kind:     "modem_report",
			Payload:  []byte(`{"kind":"ModemReport","modem_imei":"867018069514820"}`),
			IssuedAt: now, ExpiresAt: now.Add(time.Hour),
		},
	}}
}

// advancingClock returns a clock that moves ten seconds each time it is read,
// so the rate-limited pending check is past its interval by the time the
// second envelope arrives.
func advancingClock(start time.Time) func() time.Time {
	current := start
	return func() time.Time {
		current = current.Add(10 * time.Second)
		return current
	}
}

// seqPointer is the sequenced-envelope helper the other tests inline.
func seqPointer(value string) *string { return &value }

// A CommandDeliver's payload has to reach the device as an object.
//
// `type Command json.RawMessage` is a defined type and does not inherit
// RawMessage's MarshalJSON, so encoding/json fell back to the []byte rule and
// sent every command as a base64 string. Every device rejected every command
// it was ever given, and since nothing read that log the commands just stayed
// queued.
func TestACommandReachesTheDeviceAsAnObject(t *testing.T) {
	t.Parallel()

	device := identity.Device{TenantID: "t", DeviceID: "dev-1", Region: "cn"}
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	conn := newMemoryConn(mustEnvelope(t, contract.Envelope{
		V: contract.ProtocolVersion, Kind: contract.MessageKindResume,
		ID: "11111111-1111-4111-8111-111111111111", Ts: now.UnixMilli(),
		DeviceID: device.DeviceID,
		Payload: mustJSON(t, contract.ResumePayload{
			ConnectionID: "conn-1", LastAssignedSeq: "0", LastAckedSeq: "0",
			PendingGapIds: []string{}, CapabilityMatrixVersion: "1",
		}),
	}))
	server := &Server{
		Hub:     session.NewHub(),
		Journal: ingress.NewJournal(),
		Now:     func() time.Time { return now },
		Commands: staticPending{items: []dispatch.PendingCommand{{
			Attempt: 1,
			Command: dispatch.Command{
				TenantID: device.TenantID, ID: "cmd-1", DeviceID: device.DeviceID,
				Kind:     "run_at_command",
				Payload:  []byte(`{"kind":"RunAtCommand","modem_imei":"867018069509705","command":"AT+CSQ"}`),
				IssuedAt: now, ExpiresAt: now.Add(time.Hour),
			},
		}}},
	}
	if err := server.ServeDevice(device, conn); !errors.Is(err, io.EOF) {
		t.Fatalf("ServeDevice() error = %v", err)
	}

	var delivered []byte
	for i := 0; i < conn.nwrites(); i++ {
		if decodeWritten(t, conn.written(i)).Kind == contract.MessageKindCommandDeliver {
			delivered = conn.written(i)
		}
	}
	if delivered == nil {
		t.Fatal("no command was delivered")
	}

	// The command must be a nested object. A base64 string here is what the
	// devices were actually receiving.
	var frame struct {
		Payload struct {
			Command map[string]any `json:"command"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(delivered, &frame); err != nil {
		t.Fatalf("the command did not arrive as an object: %v\nframe: %s", err, delivered)
	}
	if frame.Payload.Command["kind"] != "RunAtCommand" {
		t.Fatalf("command = %#v, want the kind preserved", frame.Payload.Command)
	}
}

// A delivery receipt is its own uplink kind, and the kind list here is what
// decides whether it survives the connection at all.
//
// It is a hardcoded switch: a kind the schema declares and this line does not
// falls through to the default and takes the device's session down with it, so
// the envelope is lost and the modem's only copy has already been deleted.
// Reusing SmsReceived instead would have avoided this line at the cost of one
// ingress kind carrying two events with two projections -- and of firing the
// "new SMS" notification for every delivery receipt.
func TestADeliveryReceiptIsAcceptedAsItsOwnKind(t *testing.T) {
	t.Parallel()

	device := identity.Device{
		TenantID: "11111111-1111-1111-1111-111111111111",
		DeviceID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		Region:   "cn",
	}
	now := time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC)
	delivered := now.UnixMilli()
	statusCode := int64(0)
	reportPayload, err := json.Marshal(contract.SmsStatusReportPayload{
		ModemImei:   "867018069509705",
		Peer:        "10086",
		Reference:   42,
		Status:      "delivered",
		StatusCode:  &statusCode,
		ReportedAt:  now.UnixMilli(),
		DeliveredAt: &delivered,
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
				LastAssignedSeq:         "0",
				LastAckedSeq:            "0",
				PendingGapIds:           []string{},
				CapabilityMatrixVersion: "1",
			}),
		}),
		mustEnvelope(t, contract.Envelope{
			V: contract.ProtocolVersion, Kind: contract.MessageKindSmsStatusReport,
			ID: "44444444-4444-4444-8444-444444444444", Ts: now.UnixMilli(), DeviceID: device.DeviceID,
			Seq: stringPtr("1"), Payload: reportPayload,
		}),
	)

	var seen []string
	server := &Server{
		Region:  "cn",
		Hub:     session.NewHub(),
		Journal: ingress.NewJournal(),
		Now:     func() time.Time { return now },
		AfterInsert: func(_, _ string, kind string, _ []byte) {
			seen = append(seen, kind)
		},
	}
	if err := server.ServeDevice(device, conn); !errors.Is(err, io.EOF) {
		t.Fatalf("ServeDevice() error = %v, want EOF", err)
	}
	if len(seen) != 1 || seen[0] != string(contract.MessageKindSmsStatusReport) {
		t.Fatalf("projected kinds = %v, want one SmsStatusReport", seen)
	}
	if conn.nwrites() != 2 {
		t.Fatalf("writes = %d, want ResumeAck + UplinkAck", conn.nwrites())
	}
	if kind := decodeWritten(t, conn.written(1)).Kind; kind != contract.MessageKindUplinkAck {
		t.Fatalf("second write kind = %s, want an ack rather than a protocol error", kind)
	}
}

// The enum in the payload has to reach the conformance check. A named $def
// would have generated an untyped value on all three sides with no error, and
// the constraint table would have had nothing to check against.
func TestADeliveryStatusOutsideTheEnumIsReported(t *testing.T) {
	t.Parallel()

	found := violations(contract.MessageKindSmsStatusReport, []byte(
		`{"modem_imei":"867018069509705","peer":"10086","reference":1,`+
			`"status":"arrived","reported_at":1}`))
	if len(found) != 1 {
		t.Fatalf("violations = %v, want the bad status named", found)
	}
}

// 边缘报的故障要变成一次通知。
//
// 🔴 app.alerts 是 0053 建的，那份迁移开头写着这张表存在的理由：
//
//	「a fault nobody thinks to look for is a fault nobody hears about」。
//	而它从建表那天起就没有出口 —— 告警由一个数据库触发器投影进表，这一侧的
//	Go 代码里连「Alert」这个概念都没有，`notify` 的七种 kind 里也没有一种
//	对应它。2026-09-11 在生产上查到 263 条告警，一条都没有变成通知。
func TestAnEdgeAlertReachesTheNotifier(t *testing.T) {
	t.Parallel()

	device := identity.Device{
		TenantID: "11111111-1111-1111-1111-111111111111",
		DeviceID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		Region:   "cn",
	}
	now := time.Date(2026, 9, 11, 12, 0, 0, 0, time.UTC)

	conn := newMemoryConn(
		resumeFrame(t, device, now),
		alertFrame(t, device, now, 1, "44444444-4444-4444-8444-444444444441",
			contract.AlertPayload{
				Level: "error", Code: "qmi_poll_failed",
				Message:    "/dev/cdc-wdm1 transport error",
				OccurredAt: now.UnixMilli(), Context: map[string]any{"repeats": 3},
			}),
	)

	var seen []Alert
	server := &Server{
		Region:  "cn",
		Hub:     session.NewHub(),
		Journal: ingress.NewJournal(),
		Now:     func() time.Time { return now },
		OnAlert: func(_ identity.Device, alert Alert, _ time.Time) {
			seen = append(seen, alert)
		},
	}
	if err := server.ServeDevice(device, conn); !errors.Is(err, io.EOF) {
		t.Fatalf("ServeDevice() error = %v, want EOF", err)
	}

	if len(seen) != 1 {
		t.Fatalf("通知了 %d 次，想要 1 次 —— 边缘报的故障没有出口", len(seen))
	}
	if seen[0].Level != "error" || seen[0].Code != "qmi_poll_failed" {
		t.Fatalf("递出去的告警不对: %+v", seen[0])
	}
	if seen[0].Message != "/dev/cdc-wdm1 transport error" {
		t.Fatalf("边缘那句话没有原样递出去: %q", seen[0].Message)
	}
}

// 🔴 重放的同一条告警**不许**再通知一次。
//
// 补洞重传会把同一条告警再送一遍，数据库按 envelope id 幂等。通知这一侧
// 必须跟上：否则每次重连都把历史告警重新推给运维一遍，而那比不推更坏 ——
// 人会开始忽略这个通道，然后下一次真故障也就没人看了。
func TestAReplayedAlertDoesNotNotifyTwice(t *testing.T) {
	t.Parallel()

	device := identity.Device{
		TenantID: "11111111-1111-1111-1111-111111111111",
		DeviceID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		Region:   "cn",
	}
	now := time.Date(2026, 9, 11, 12, 0, 0, 0, time.UTC)
	payload := contract.AlertPayload{
		Level: "error", Code: "agent_silent", Message: "no poll for 90s",
		OccurredAt: now.UnixMilli(), Context: map[string]any{},
	}
	// 同一个 envelope id、同一个 seq，送两遍 —— 这就是补洞重传的形状。
	const envelopeID = "44444444-4444-4444-8444-444444444442"

	conn := newMemoryConn(
		resumeFrame(t, device, now),
		alertFrame(t, device, now, 1, envelopeID, payload),
		alertFrame(t, device, now, 1, envelopeID, payload),
	)

	var count int
	server := &Server{
		Region:  "cn",
		Hub:     session.NewHub(),
		Journal: ingress.NewJournal(),
		Now:     func() time.Time { return now },
		OnAlert: func(_ identity.Device, _ Alert, _ time.Time) { count++ },
	}
	if err := server.ServeDevice(device, conn); !errors.Is(err, io.EOF) {
		t.Fatalf("ServeDevice() error = %v, want EOF", err)
	}
	if count != 1 {
		t.Fatalf("同一条告警通知了 %d 次 —— 每次重连都会把历史告警重新推一遍", count)
	}
}

// 读不懂的告警不许中断会话。
//
// ⚠️ 告警是这台机器在说自己有毛病。一条读不懂的告警让它连带说不出别的话，
//
//	是这个仓库反复在防的形状：一条坏记录锁死整条上行。
func TestAnUnreadableAlertDoesNotEndTheSession(t *testing.T) {
	t.Parallel()

	device := identity.Device{
		TenantID: "11111111-1111-1111-1111-111111111111",
		DeviceID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		Region:   "cn",
	}
	now := time.Date(2026, 9, 11, 12, 0, 0, 0, time.UTC)

	conn := newMemoryConn(
		resumeFrame(t, device, now),
		mustEnvelope(t, contract.Envelope{
			V: contract.ProtocolVersion, Kind: contract.MessageKindAlert,
			ID: "44444444-4444-4444-8444-444444444443", Ts: now.UnixMilli(),
			DeviceID: device.DeviceID, Seq: stringPtr("1"),
			// level 本该是字符串
			Payload: []byte(`{"level":42,"code":"x","message":"y","occurred_at":1,"context":{}}`),
		}),
	)

	var count int
	server := &Server{
		Region:  "cn",
		Hub:     session.NewHub(),
		Journal: ingress.NewJournal(),
		Now:     func() time.Time { return now },
		OnAlert: func(_ identity.Device, _ Alert, _ time.Time) { count++ },
	}
	err := server.ServeDevice(device, conn)
	if !errors.Is(err, io.EOF) {
		t.Fatalf("一条读不懂的告警把会话弄断了: %v", err)
	}
	if count != 0 {
		t.Fatalf("读不懂却通知了 %d 次", count)
	}
}

func resumeFrame(t *testing.T, device identity.Device, now time.Time) []byte {
	t.Helper()
	return mustEnvelope(t, contract.Envelope{
		V: contract.ProtocolVersion, Kind: contract.MessageKindResume,
		ID: "11111111-1111-4111-8111-111111111111", Ts: now.UnixMilli(),
		DeviceID: device.DeviceID,
		Payload: mustJSON(t, contract.ResumePayload{
			ConnectionID:            "22222222-2222-4222-8222-222222222222",
			LastAssignedSeq:         "0",
			LastAckedSeq:            "0",
			PendingGapIds:           []string{},
			CapabilityMatrixVersion: "1",
		}),
	})
}

func alertFrame(
	t *testing.T, device identity.Device, now time.Time,
	seq int, envelopeID string, payload contract.AlertPayload,
) []byte {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return mustEnvelope(t, contract.Envelope{
		V: contract.ProtocolVersion, Kind: contract.MessageKindAlert,
		ID: envelopeID, Ts: now.UnixMilli(), DeviceID: device.DeviceID,
		Seq: stringPtr(strconv.Itoa(seq)), Payload: body,
	})
}
