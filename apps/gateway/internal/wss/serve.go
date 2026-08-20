// Package wss is the authenticated device WebSocket session.
//
// The HTTP upgrader is a thin adapter around ServeDevice, which is the
// protocol state machine: first frame is Resume, identity comes from the
// certificate, sequenced envelopes go to the ingress journal.
package wss

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/gorilla/websocket"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/identity"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/ingress"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/session"
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

// Server holds live connections and the uplink journal.
type Server struct {
	Region  string
	Hub     *session.Hub
	Journal ingress.Store
	Now     func() time.Time
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
		case contract.MessageKindSmsReceived, contract.MessageKindDeviceState, contract.MessageKindCommandResult, contract.MessageKindEsimInventory, contract.MessageKindAlert:
			if envelope.Seq == nil {
				return fmt.Errorf("%s requires seq", envelope.Kind)
			}
			seq, err := parseSeq(*envelope.Seq)
			if err != nil {
				return err
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
		default:
			return fmt.Errorf("unexpected envelope %s", envelope.Kind)
		}
	}
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
