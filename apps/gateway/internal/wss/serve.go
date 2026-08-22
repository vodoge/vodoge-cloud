// Package wss is the authenticated device WebSocket session.
//
// The HTTP upgrader is a thin adapter around ServeDevice, which is the
// protocol state machine: first frame is Resume, identity comes from the
// certificate, sequenced envelopes go to the ingress journal.
package wss

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/dispatch"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/events"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/identity"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/ingress"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/session"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/wakeup"
	contract "github.com/vodoge/vodoge-cloud/packages/contract"
)

const (
	// ResumeDeadline is how long the gateway waits for the first Resume.
	ResumeDeadline = 10 * time.Second
	// MaxFrameBytes is the encoded envelope limit from the contract.
	MaxFrameBytes = 1 << 20
)

// FrameConn is the subset of a WebSocket used by the device session.
type FrameConn interface {
	ReadMessage() (int, []byte, error)
	WriteMessage(messageType int, data []byte) error
	SetReadDeadline(time.Time) error
	Close() error
}

// PendingCommands loads durable commands for a device that just resumed.
// Offline devices keep commands queued in PostgreSQL; this is called only after
// a live connection is bound.
type PendingCommands interface {
	PendingForDevice(tenantID, deviceID string, now time.Time) []dispatch.PendingCommand
}

// ReceiptHandler records CommandReceipt from the edge.
type ReceiptHandler interface {
	RecordReceipt(tenantID string, receipt dispatch.Receipt, now time.Time) error
}

// ResultHandler records a sequenced CommandResult from the edge.
type ResultHandler interface {
	RecordResult(tenantID string, result dispatch.CommandResult) error
}

// Server holds live connections and the uplink journal.
//
// Wakeups is optional. Redis is a routing hint only; a nil or failing publisher
// must not prevent Accept or UplinkAck.
type Server struct {
	Region      string
	Hub         *session.Hub
	Journal     ingress.Store
	Commands    PendingCommands
	Receipts    ReceiptHandler
	Results     ResultHandler
	AfterInsert func(tenantID, deviceID, kind string, payload []byte)
	Wakeups     wakeup.Publisher
	Events      *events.Bus
	// ResumeReport records what a device says about itself when it connects:
	// which build it is running and how far behind its queue is. Optional, so
	// a gateway without a database still serves.
	ResumeReport func(tenantID, deviceID string, report DeviceReport)
	// Metrics is optional; a gateway without one still serves.
	Metrics interface {
		Add(name string, delta int64, labels ...string)
		AddGauge(name string, delta int64)
	}
	Now func() time.Time
}

// DeviceReport is what a device tells the gateway about itself on Resume.
//
// It arrives on every reconnect and was previously read only to decide what to
// replay, then discarded — so the two questions an operator asks about a fleet,
// what is on the old build and what is backing up, had no answer anywhere.
type DeviceReport struct {
	EdgeVersion   string
	MatrixVersion string
	QueueRecords  int64
	QueueBytes    int64
}

func (server *Server) now() time.Time {
	if server.Now != nil {
		return server.Now()
	}
	return time.Now()
}

// ServeDevice runs one authenticated device connection until it closes.
func (server *Server) ServeDevice(device identity.Device, conn FrameConn) (err error) {
	if server.Hub == nil || server.Journal == nil {
		_ = conn.Close()
		return errors.New("server missing hub or journal")
	}
	if server.Region != "" && device.Region != server.Region {
		_ = conn.Close()
		return fmt.Errorf("certificate region %s does not match gateway %s", device.Region, server.Region)
	}

	var connectionID string
	defer func() {
		if connectionID != "" {
			server.Hub.Unbind(connectionID)
		}
		_ = conn.Close()
	}()

	if err := conn.SetReadDeadline(server.now().Add(ResumeDeadline)); err != nil {
		return err
	}
	envelope, err := readEnvelope(conn)
	if err != nil {
		return err
	}
	if envelope.Kind != contract.MessageKindResume {
		return errors.New("first envelope must be Resume")
	}
	if !device.MatchesEnvelope(envelope.DeviceID) {
		return errors.New("envelope device_id does not match certificate")
	}

	var resume contract.ResumePayload
	if err := json.Unmarshal(envelope.Payload, &resume); err != nil {
		return fmt.Errorf("resume payload: %w", err)
	}
	if resume.ConnectionID == "" {
		return errors.New("resume connection_id is required")
	}

	now := server.now()
	// The connection this one replaces has to be closed, not merely forgotten.
	// Dropping it from the hub leaves its goroutine running: it keeps reading
	// whatever the kernel already buffered, storing it, and writing an ack per
	// record into a socket the device abandoned. Those acks pile up unread
	// until the send buffer fills, at which point the zombie blocks in write
	// while the live session competes with it for the same device journal.
	// Observed on the deployment: two sessions for one device, 542 KB stuck in
	// one direction and 204 KB in the other, and an uplink that stopped moving.
	if previous := server.Hub.Bind(session.Connection{
		ID:           resume.ConnectionID,
		Device:       device,
		ConnectedAt:  now,
		LastPacketAt: now,
		Close:        func() { _ = conn.Close() },
	}); previous != nil && previous.Close != nil {
		slog.Info("closing a device session superseded by a new one",
			"tenant_id", device.TenantID, "device_id", device.DeviceID,
			"superseded", previous.ID, "replacement", resume.ConnectionID)
		previous.Close()
	}
	connectionID = resume.ConnectionID

	snapshot, err := server.Journal.Snapshot(device.TenantID, device.DeviceID)
	if err != nil {
		return err
	}
	if err := writeEnvelope(conn, device.DeviceID, contract.MessageKindResumeAck, contract.ResumeAckPayload{
		ConnectionID:     resume.ConnectionID,
		CommittedThrough: formatSeq(snapshot.CommittedThrough),
		MissingRanges:    toContractRanges(snapshot.MissingRanges),
		MoreMissing:      snapshot.MoreMissing,
		MaxInFlight:      32,
		ServerTime:       now.UnixMilli(),
	}, now); err != nil {
		return err
	}
	server.hintPresence(device.DeviceID)
	// Counted from here rather than from the accept: a connection that never
	// completed a Resume was never a session, and counting it would leave the
	// gauge permanently above the truth.
	if server.Metrics != nil {
		server.Metrics.AddGauge("vodoge_device_sessions_active", 1)
		defer server.Metrics.AddGauge("vodoge_device_sessions_active", -1)
	}
	if server.ResumeReport != nil {
		server.ResumeReport(device.TenantID, device.DeviceID, DeviceReport{
			EdgeVersion:   stringValue(resume.EdgeVersion),
			MatrixVersion: resume.CapabilityMatrixVersion,
			QueueRecords:  int64Value(resume.QueueRecords),
			QueueBytes:    int64Value(resume.QueueBytes),
		})
	}

	if err := server.deliverPending(device, conn, now); err != nil {
		return err
	}

	// Pending commands were delivered only at Resume, so one issued to a
	// device that was already connected waited for the link to drop — hours,
	// for a healthy device.
	//
	// Hooking it to the heartbeat was the first attempt and did not work: a
	// device that polls its modems every eight seconds is never idle long
	// enough to send one, so the commands sat queued while the session was
	// perfectly healthy. It hangs off any inbound traffic now, which covers
	// both a busy device and a quiet one.
	//
	// Rate limited because the check is a database query and a busy device
	// sends far more often than a command arrives. Five seconds bounds the
	// delay to less than an operator notices while keeping the query rare.
	const pendingEvery = 5 * time.Second
	lastPendingCheck := now

	for {
		if err := conn.SetReadDeadline(server.now().Add(session.IdleTimeout)); err != nil {
			return err
		}
		envelope, err = readEnvelope(conn)
		if err != nil {
			return err
		}
		if !device.MatchesEnvelope(envelope.DeviceID) {
			return errors.New("envelope device_id does not match certificate")
		}
		if !server.Hub.Touch(connectionID, server.now()) {
			return errors.New("connection superseded")
		}
		server.hintPresence(device.DeviceID)

		if seen := server.now(); seen.Sub(lastPendingCheck) >= pendingEvery {
			lastPendingCheck = seen
			if err := server.deliverPending(device, conn, seen); err != nil {
				return err
			}
		}

		switch envelope.Kind {
		case contract.MessageKindPing:
			var ping contract.PingPayload
			if err := json.Unmarshal(envelope.Payload, &ping); err != nil {
				return fmt.Errorf("ping payload: %w", err)
			}
			if ping.ConnectionID != connectionID {
				return errors.New("ping connection_id does not match session")
			}
			if err := writeEnvelope(conn, device.DeviceID, contract.MessageKindPong, contract.PongPayload{
				ConnectionID: connectionID,
				PingID:       envelope.ID,
				ServerTime:   server.now().UnixMilli(),
			}, server.now()); err != nil {
				return err
			}

		case contract.MessageKindCommandReceipt:
			if server.Receipts == nil {
				break
			}
			var payload contract.CommandReceiptPayload
			if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
				return fmt.Errorf("command receipt: %w", err)
			}
			receipt := dispatch.Receipt{
				ID:         envelope.ID,
				CommandID:  payload.CmdID,
				DeliveryID: payload.DeliveryID,
				Status:     dispatch.ReceiptStatus(payload.Status),
				ReceivedAt: time.UnixMilli(payload.ReceivedAt),
			}
			if err := server.Receipts.RecordReceipt(device.TenantID, receipt, server.now()); err != nil {
				return err
			}
		case contract.MessageKindSmsReceived, contract.MessageKindDeviceState, contract.MessageKindCommandResult, contract.MessageKindEsimInventory, contract.MessageKindAlert, contract.MessageKindProxyTraffic:
			if envelope.Seq == nil {
				return fmt.Errorf("%s requires seq", envelope.Kind)
			}
			seq, err := parseSeq(*envelope.Seq)
			if err != nil {
				return err
			}
			// Reported, not rejected: see violations. A silent accept is what
			// let four wrong enum values reach storage across two message
			// kinds, none of which anything noticed until a column read wrong.
			if found := violations(envelope.Kind, envelope.Payload); len(found) > 0 {
				if server.Metrics != nil {
					server.Metrics.Add("vodoge_contract_violations_total", 1,
						"kind", string(envelope.Kind))
				}
				slog.Warn("payload violates the contract",
					"tenant_id", device.TenantID,
					"device_id", device.DeviceID,
					"kind", string(envelope.Kind),
					"violations", strings.Join(found, "; "))
			}
			if server.Metrics != nil {
				server.Metrics.Add("vodoge_ingress_records_total", 1,
					"kind", string(envelope.Kind))
			}
			result, err := server.Journal.Accept(ingress.Record{
				TenantID:   device.TenantID,
				DeviceID:   device.DeviceID,
				EnvelopeID: envelope.ID,
				Seq:        seq,
				Kind:       string(envelope.Kind),
				Payload:    append([]byte(nil), envelope.Payload...),
			})
			// A record the database can never store is acknowledged and
			// dropped rather than ending the session.
			//
			// Ending it means the device reconnects, replays the same record,
			// and dies again — a permanent loop in which nothing else that
			// device has to say gets through either. An edge sending a
			// non-UUID envelope id did exactly that, every six seconds, and
			// the only symptom anyone would see is a device that looks
			// perpetually offline.
			//
			// Losing one structurally invalid record is the smaller harm, and
			// it is counted and logged so it is not silent.
			if errors.Is(err, ingress.ErrMalformed) {
				if server.Metrics != nil {
					server.Metrics.Add("vodoge_ingress_rejected_total", 1,
						"kind", string(envelope.Kind))
				}
				slog.Warn("dropping a record this database cannot store",
					"tenant_id", device.TenantID, "device_id", device.DeviceID,
					"kind", string(envelope.Kind), "envelope_id", envelope.ID,
					"seq", seq, "error", err)
				// The sequence still has to be filled. Leaving it empty is
				// not neutral: the contiguous prefix cannot cross a sequence
				// that was never written, so the device replays this record on
				// every reconnect and everything queued behind it waits behind
				// it forever. Three SMS bodies carrying a NUL stalled an entire
				// device's uplink this way.
				//
				// A tombstone records what was lost and why, and lets the
				// prefix move on.
				if tombstoneErr := server.Journal.RecordUnstorable(ingress.Record{
					TenantID:   device.TenantID,
					DeviceID:   device.DeviceID,
					EnvelopeID: envelope.ID,
					Seq:        seq,
					Kind:       string(envelope.Kind),
				}, err.Error()); tombstoneErr != nil {
					// Failing to tombstone is not itself fatal to the record —
					// it is already lost — but the uplink is now stuck, and
					// saying so beats a silent stall.
					slog.Error("could not tombstone an unstorable record; this device's uplink will stall",
						"tenant_id", device.TenantID, "device_id", device.DeviceID,
						"seq", seq, "error", tombstoneErr)
				}
				// The ack must describe the journal as it really is, not as
				// this record would have left it. Claiming committed through
				// the dropped sequence — with no missing ranges — tells the
				// device everything below is safely stored, and it deletes
				// records this side never had. The hole then cannot be filled
				// from either end: the device no longer holds them and the
				// window never advances past the gap, so the whole uplink
				// stops. That is exactly how three thousand records got
				// stranded.
				window, windowErr := server.Journal.Snapshot(device.TenantID, device.DeviceID)
				if windowErr != nil {
					return windowErr
				}
				if err := writeEnvelope(conn, device.DeviceID, contract.MessageKindUplinkAck,
					contract.UplinkAckPayload{
						ConnectionID:     connectionID,
						CommittedThrough: formatSeq(window.CommittedThrough),
						MissingRanges:    toContractRanges(window.MissingRanges),
						MoreMissing:      window.MoreMissing,
						MaxInFlight:      32,
					}, server.now()); err != nil {
					return err
				}
				continue
			}
			if err != nil {
				return err
			}
			if err := writeEnvelope(conn, device.DeviceID, contract.MessageKindUplinkAck, contract.UplinkAckPayload{
				ConnectionID:     connectionID,
				CommittedThrough: formatSeq(result.Window.CommittedThrough),
				MissingRanges:    toContractRanges(result.Window.MissingRanges),
				MoreMissing:      result.Window.MoreMissing,
				MaxInFlight:      32,
			}, server.now()); err != nil {
				return err
			}
			if envelope.Kind == contract.MessageKindCommandResult && server.Results != nil {
				var payload contract.CommandResultPayload
				if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
					return fmt.Errorf("command result: %w", err)
				}
				if err := server.Results.RecordResult(device.TenantID, dispatch.CommandResult{
					CommandID:   payload.CmdID,
					Status:      dispatch.ResultStatus(payload.Status),
					CompletedAt: time.UnixMilli(payload.CompletedAt),
					Attempts:    int(payload.Attempts),
					ReasonCode:  stringValue(payload.ReasonCode),
					Reason:      stringValue(payload.Reason),
					// What the diagnostic actually read. Without this a
					// relayed AT command reports only that it succeeded, and
					// the response the operator asked for is discarded one
					// step before it is stored.
					Details: detailsJSON(payload.Details),
				}); err != nil {
					return err
				}
			}
			if result.Status == ingress.StatusInserted {
				if server.AfterInsert != nil {
					server.AfterInsert(device.TenantID, device.DeviceID, string(envelope.Kind), envelope.Payload)
				}
				server.hintEvent(wakeup.Event{
					TenantID:   device.TenantID,
					DeviceID:   device.DeviceID,
					EnvelopeID: envelope.ID,
					Kind:       string(envelope.Kind),
					Seq:        seq,
				})
			}
		default:
			return fmt.Errorf("unexpected envelope %s", envelope.Kind)
		}
	}
}

func (server *Server) hintPresence(deviceID string) {
	ctx, cancel := context.WithTimeout(context.Background(), wakeup.HintTimeout)
	defer cancel()
	// Presence is a routing hint. A down Redis must not close the session.
	_ = wakeup.Maybe(server.Wakeups).RegisterDevice(ctx, deviceID)
}

func (server *Server) hintEvent(event wakeup.Event) {
	if server.Events != nil {
		server.Events.Publish(event.TenantID, event.Kind)
	}
	ctx, cancel := context.WithTimeout(context.Background(), wakeup.HintTimeout)
	defer cancel()
	// UplinkAck confirms PostgreSQL, not SSE publication.
	_ = wakeup.Maybe(server.Wakeups).PublishEvent(ctx, event)
}

func (server *Server) deliverPending(device identity.Device, conn FrameConn, now time.Time) error {
	if server.Commands == nil {
		return nil
	}
	pendingList := server.Commands.PendingForDevice(device.TenantID, device.DeviceID, now)
	if len(pendingList) > 0 {
		// Logged because this path was silently doing nothing on every
		// deployment for want of one grant, and the only way anyone would
		// have known is a command that stayed queued.
		slog.Info("delivering queued commands",
			"device_id", device.DeviceID, "count", len(pendingList))
	}
	for _, pending := range pendingList {
		if pending.Command.Expired(now) {
			continue
		}
		attempt := int64(pending.Attempt)
		payload := contract.CommandDeliverPayload{
			CmdID:     pending.Command.ID,
			IssuedAt:  pending.Command.IssuedAt.UnixMilli(),
			ExpiresAt: pending.Command.ExpiresAt.UnixMilli(),
			Attempt:   &attempt,
			Command:   contract.Command(append([]byte(nil), pending.Command.Payload...)),
		}
		if err := writeEnvelope(conn, device.DeviceID, contract.MessageKindCommandDeliver, payload, now); err != nil {
			return err
		}
	}
	return nil
}

func readEnvelope(conn FrameConn) (contract.Envelope, error) {
	messageType, frame, err := conn.ReadMessage()
	if err != nil {
		return contract.Envelope{}, err
	}
	if messageType != websocket.BinaryMessage {
		return contract.Envelope{}, errors.New("only binary frames are allowed")
	}
	if len(frame) > MaxFrameBytes {
		return contract.Envelope{}, errors.New("frame too large")
	}
	return decodeEnvelope(frame)
}

func decodeEnvelope(frame []byte) (contract.Envelope, error) {
	var envelope contract.Envelope
	if err := json.Unmarshal(frame, &envelope); err != nil {
		return contract.Envelope{}, err
	}
	if envelope.V != contract.ProtocolVersion {
		return contract.Envelope{}, fmt.Errorf("unsupported protocol version %d", envelope.V)
	}
	if envelope.Kind == "" || envelope.ID == "" || envelope.DeviceID == "" {
		return contract.Envelope{}, errors.New("envelope kind, id, and device_id are required")
	}
	return envelope, nil
}

func writeEnvelope(conn FrameConn, deviceID string, kind contract.MessageKind, payload any, now time.Time) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	frame, err := json.Marshal(contract.Envelope{
		V:        contract.ProtocolVersion,
		Kind:     kind,
		ID:       kindEnvelopeID(kind, now),
		Ts:       now.UnixMilli(),
		DeviceID: deviceID,
		Payload:  raw,
	})
	if err != nil {
		return err
	}
	return conn.WriteMessage(websocket.BinaryMessage, frame)
}

func parseSeq(raw string) (uint64, error) {
	seq, err := strconv.ParseUint(raw, 10, 64)
	if err != nil || seq == 0 {
		return 0, fmt.Errorf("invalid seq %q", raw)
	}
	return seq, nil
}

func formatSeq(seq uint64) string {
	return strconv.FormatUint(seq, 10)
}

func toContractRanges(ranges []ingress.Range) []contract.SequenceRange {
	out := make([]contract.SequenceRange, 0, len(ranges))
	for _, item := range ranges {
		out = append(out, contract.SequenceRange{
			From:    formatSeq(item.From),
			Through: formatSeq(item.Through),
		})
	}
	return out
}

// stringValue 解引用可空字符串。名字必须体现「取值」——
// 它曾叫 stringPtr，与测试里「取地址」的同名 helper 语义相反且冲突，
// 导致整个包的测试无法编译。
func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func kindEnvelopeID(kind contract.MessageKind, now time.Time) string {
	var suffix uint64
	switch kind {
	case contract.MessageKindResumeAck:
		suffix = 1
	case contract.MessageKindPong:
		suffix = 2
	case contract.MessageKindUplinkAck:
		suffix = 3
	default:
		suffix = 0
	}
	return fmt.Sprintf("00000000-0000-4000-8000-%012d", suffix+uint64(now.UnixMilli()%1_000_000_000000))
}

// detailsJSON re-encodes a command result's free-form details for storage.
//
// Absent details stay absent: an empty JSON object would be indistinguishable
// from an action that genuinely reported nothing.
func detailsJSON(details any) []byte {
	if details == nil {
		return nil
	}
	encoded, err := json.Marshal(details)
	if err != nil {
		return nil
	}
	if string(encoded) == "null" {
		return nil
	}
	return encoded
}

// int64Value reads an optional count, where absent means zero.
//
// Absent and zero are the same thing for a queue depth: a device that did not
// report one has nothing to report.
func int64Value(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}
