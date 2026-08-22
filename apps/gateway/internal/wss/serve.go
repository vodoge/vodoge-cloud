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
	Now         func() time.Time
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
	server.Hub.Bind(session.Connection{
		ID:           resume.ConnectionID,
		Device:       device,
		ConnectedAt:  now,
		LastPacketAt: now,
	})
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

	if err := server.deliverPending(device, conn, now); err != nil {
		return err
	}

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
		case contract.MessageKindSmsReceived, contract.MessageKindDeviceState, contract.MessageKindCommandResult, contract.MessageKindEsimInventory, contract.MessageKindAlert:
			if envelope.Seq == nil {
				return fmt.Errorf("%s requires seq", envelope.Kind)
			}
			seq, err := parseSeq(*envelope.Seq)
			if err != nil {
				return err
			}
			// Reported, not rejected: see deviceStateViolations. A silent
			// accept is what let three wrong enum values reach the console.
			if envelope.Kind == contract.MessageKindDeviceState {
				if violations := deviceStateViolations(envelope.Payload); len(violations) > 0 {
					slog.Warn("device state violates the contract",
						"tenant_id", device.TenantID,
						"device_id", device.DeviceID,
						"violations", strings.Join(violations, "; "))
				}
			}
			result, err := server.Journal.Accept(ingress.Record{
				TenantID:   device.TenantID,
				DeviceID:   device.DeviceID,
				EnvelopeID: envelope.ID,
				Seq:        seq,
				Kind:       string(envelope.Kind),
				Payload:    append([]byte(nil), envelope.Payload...),
			})
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
	for _, pending := range server.Commands.PendingForDevice(device.TenantID, device.DeviceID, now) {
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
