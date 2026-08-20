// Package dispatch coordinates reliable downstream command delivery.
//
// PostgreSQL remains authoritative for commands and the command outbox. A
// WakeupPublisher is deliberately non-durable: it only reduces delivery
// latency by notifying a gateway that can then load pending commands from the
// durable store. A lost wakeup is recovered by the next outbox poll or device
// resume.
package dispatch

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"
)

var (
	// ErrInvalidConfiguration indicates that a Dispatcher dependency or setting
	// would make durable command recovery impossible.
	ErrInvalidConfiguration = errors.New("invalid command dispatcher configuration")
	// ErrInvalidCommand indicates that a command cannot be represented in a
	// CommandDeliver envelope.
	ErrInvalidCommand = errors.New("invalid command")
	// ErrInvalidReceipt indicates that an edge CommandReceipt is malformed.
	ErrInvalidReceipt = errors.New("invalid command receipt")
	// ErrInvalidResult indicates that an edge terminal CommandResult is malformed.
	ErrInvalidResult = errors.New("invalid command result")
	// ErrConflictingTerminalResult indicates that a command already has a
	// different terminal result. This is an integrity incident, not an update.
	ErrConflictingTerminalResult = errors.New("conflicting terminal command result")
)

// Command is the durable logical command record. ID is cmd_id and stays stable
// across every physical delivery attempt.
type Command struct {
	TenantID  string
	ID        string
	DeviceID  string
	Kind      string
	Payload   []byte
	IssuedAt  time.Time
	ExpiresAt time.Time
}

// Validate checks the fields required to create a CommandDeliver envelope.
func (c Command) Validate() error {
	switch {
	case c.TenantID == "":
		return fmt.Errorf("%w: tenant ID is required", ErrInvalidCommand)
	case c.ID == "":
		return fmt.Errorf("%w: command ID is required", ErrInvalidCommand)
	case c.DeviceID == "":
		return fmt.Errorf("%w: device ID is required", ErrInvalidCommand)
	case c.Kind == "":
		return fmt.Errorf("%w: kind is required", ErrInvalidCommand)
	case len(c.Payload) == 0:
		return fmt.Errorf("%w: payload is required", ErrInvalidCommand)
	case c.IssuedAt.IsZero():
		return fmt.Errorf("%w: issued time is required", ErrInvalidCommand)
	case c.ExpiresAt.IsZero():
		return fmt.Errorf("%w: expiry time is required", ErrInvalidCommand)
	case !c.ExpiresAt.After(c.IssuedAt):
		return fmt.Errorf("%w: expiry must be after issue time", ErrInvalidCommand)
	default:
		return nil
	}
}

// Expired reports whether the cloud must stop attempting delivery at now. The
// cloud clock is authoritative; a device-reported timestamp is not used here.
func (c Command) Expired(now time.Time) bool {
	return !now.Before(c.ExpiresAt)
}

// OutboxItem is a durable outbox row after a dispatcher lease. Attempt is the
// positive, persisted lease count, not a Redis publish count.
type OutboxItem struct {
	ID      int64
	Command Command
	Attempt int
}

// Validate ensures a leased outbox row can safely be processed.
func (o OutboxItem) Validate() error {
	if o.ID <= 0 {
		return fmt.Errorf("%w: outbox ID must be positive", ErrInvalidCommand)
	}
	if o.Attempt < 1 {
		return fmt.Errorf("%w: outbox attempt must be positive", ErrInvalidCommand)
	}
	return o.Command.Validate()
}

// Wakeup is intentionally small and non-authoritative. It must never contain
// the command payload; a gateway loads that from durable storage before it
// emits CommandDeliver.
type Wakeup struct {
	TenantID  string
	DeviceID  string
	CommandID string
}

// Delivery is one physical CommandDeliver attempt. DeliveryID is the envelope
// ID and is distinct from CommandID (cmd_id).
type Delivery struct {
	DeliveryID string
	Command    Command
	Attempt    int
}

// Validate checks the delivery fields that are independent of the wire codec.
func (d Delivery) Validate() error {
	if d.DeliveryID == "" {
		return fmt.Errorf("%w: delivery ID is required", ErrInvalidCommand)
	}
	if d.Attempt < 1 {
		return fmt.Errorf("%w: delivery attempt must be positive", ErrInvalidCommand)
	}
	return d.Command.Validate()
}

// PendingCommand is a durable command selected for an active device. Attempt
// is the next physical delivery attempt number and is included in the wire
// payload for operational observability.
type PendingCommand struct {
	Command Command
	Attempt int
}

// Validate checks a pending command loaded from the durable data plane.
func (p PendingCommand) Validate() error {
	if p.Attempt < 1 {
		return fmt.Errorf("%w: pending command attempt must be positive", ErrInvalidCommand)
	}
	return p.Command.Validate()
}

// OutboxStore is the tenant-scoped durable dispatcher-facing view of
// app.command_outbox. Implementations should claim rows transactionally,
// equivalent to app.claim_command_outbox, and preserve a failed wakeup for
// future polling. No method may perform an implicit cross-tenant scan.
type OutboxStore interface {
	ClaimDue(ctx context.Context, tenantID, workerID string, now time.Time, limit int) ([]OutboxItem, error)
	MarkWakeupPublished(ctx context.Context, tenantID string, outboxID int64, workerID string, now time.Time) error
	RetryWakeup(ctx context.Context, tenantID string, outboxID int64, workerID string, availableAt time.Time, reason string) error
	ExpireCommand(ctx context.Context, tenantID, commandID string, now time.Time) error
}

// CommandStore is the durable gateway-facing command view. A gateway must load
// commands from this store after a wakeup or device resume; it must not trust a
// Pub/Sub payload as the command itself.
//
// ApplyReceipt and ApplyTerminalResult must be atomic database operations. In
// particular, replaying an envelope ID or an identical terminal result must be
// a no-op, while a contradictory terminal result must surface as an integrity
// error.
type CommandStore interface {
	PendingForDevice(ctx context.Context, tenantID, deviceID string, now time.Time, limit int) ([]PendingCommand, error)
	RecordDeliveryAttempt(ctx context.Context, tenantID string, delivery Delivery, now time.Time) error
	ExpireCommand(ctx context.Context, tenantID, commandID string, now time.Time) error
	ApplyReceipt(ctx context.Context, tenantID string, receipt Receipt, decision ReceiptDecision) (ReceiptApplyResult, error)
	ApplyTerminalResult(ctx context.Context, tenantID string, result CommandResult) (ResultApplyResult, error)
}

// WakeupPublisher sends a best-effort routing hint, such as a Redis Pub/Sub
// message. Its acknowledgement is never proof that a device received a command.
type WakeupPublisher interface {
	PublishWakeup(ctx context.Context, wakeup Wakeup) error
}

// DeviceDeliverer writes a CommandDeliver envelope to the active device
// connection. It has no durability obligations.
type DeviceDeliverer interface {
	DeliverCommand(ctx context.Context, delivery Delivery) error
}

// DeliveryIDSource allocates a new envelope ID for each physical delivery.
// Injecting it keeps dispatcher tests deterministic and lets production use a
// UUID generator.
type DeliveryIDSource interface {
	NextDeliveryID() (string, error)
}

// RetryDelay returns the delay after a failed wakeup publish. The persisted
// outbox lease count is passed as attempt.
type RetryDelay func(attempt int) time.Duration

// Dependencies contains the required collaborators for Dispatcher.
type Dependencies struct {
	Outbox          OutboxStore
	Commands        CommandStore
	Wakeups         WakeupPublisher
	Deliverer       DeviceDeliverer
	DeliveryIDs     DeliveryIDSource
	WorkerID        string
	BatchSize       int
	WakeupRetryWait RetryDelay
}

// Dispatcher coordinates durable outbox recovery and active-device delivery.
// It does not implement a database, Redis client, or WebSocket transport.
type Dispatcher struct {
	outbox          OutboxStore
	commands        CommandStore
	wakeups         WakeupPublisher
	deliverer       DeviceDeliverer
	deliveryIDs     DeliveryIDSource
	workerID        string
	batchSize       int
	wakeupRetryWait RetryDelay
}

// New returns a dispatcher with explicit dependencies. The constructor refuses
// partial configuration because it could otherwise turn a lost wakeup into a
// lost command path.
func New(deps Dependencies) (*Dispatcher, error) {
	switch {
	case deps.Outbox == nil:
		return nil, fmt.Errorf("%w: outbox store is required", ErrInvalidConfiguration)
	case deps.Commands == nil:
		return nil, fmt.Errorf("%w: command store is required", ErrInvalidConfiguration)
	case deps.Wakeups == nil:
		return nil, fmt.Errorf("%w: wakeup publisher is required", ErrInvalidConfiguration)
	case deps.Deliverer == nil:
		return nil, fmt.Errorf("%w: device deliverer is required", ErrInvalidConfiguration)
	case deps.DeliveryIDs == nil:
		return nil, fmt.Errorf("%w: delivery ID source is required", ErrInvalidConfiguration)
	case deps.WorkerID == "":
		return nil, fmt.Errorf("%w: worker ID is required", ErrInvalidConfiguration)
	case deps.BatchSize < 1:
		return nil, fmt.Errorf("%w: batch size must be positive", ErrInvalidConfiguration)
	case deps.WakeupRetryWait == nil:
		return nil, fmt.Errorf("%w: wakeup retry delay is required", ErrInvalidConfiguration)
	}

	return &Dispatcher{
		outbox:          deps.Outbox,
		commands:        deps.Commands,
		wakeups:         deps.Wakeups,
		deliverer:       deps.Deliverer,
		deliveryIDs:     deps.DeliveryIDs,
		workerID:        deps.WorkerID,
		batchSize:       deps.BatchSize,
		wakeupRetryWait: deps.WakeupRetryWait,
	}, nil
}

// PollReport describes one durable outbox poll. Errors are per-row errors: a
// healthy row can still be published even when another wakeup must be retried.
type PollReport struct {
	Claimed   int
	Published int
	Retried   int
	Expired   int
	Errors    []error
}

// PollOutbox claims due durable wakeups, publishes only lightweight hints, and
// schedules a retry when a publisher fails. A successful publish is not command
// completion; later polls and a device resume still load the durable command.
func (d *Dispatcher) PollOutbox(ctx context.Context, tenantID string, now time.Time) (PollReport, error) {
	if tenantID == "" {
		return PollReport{}, fmt.Errorf("%w: tenant ID is required", ErrInvalidCommand)
	}

	items, err := d.outbox.ClaimDue(ctx, tenantID, d.workerID, now, d.batchSize)
	if err != nil {
		return PollReport{}, fmt.Errorf("claim due command outbox rows: %w", err)
	}

	report := PollReport{Claimed: len(items)}
	for _, item := range items {
		if err := item.Validate(); err != nil {
			report.Errors = append(report.Errors, err)
			continue
		}
		if item.Command.TenantID != tenantID {
			report.Errors = append(report.Errors, fmt.Errorf("%w: claimed command %s does not belong to tenant", ErrInvalidCommand, item.Command.ID))
			continue
		}

		if item.Command.Expired(now) {
			if err := d.outbox.ExpireCommand(ctx, tenantID, item.Command.ID, now); err != nil {
				report.Errors = append(report.Errors, fmt.Errorf("expire command %s: %w", item.Command.ID, err))
				continue
			}
			report.Expired++
			continue
		}

		wakeup := Wakeup{
			TenantID:  item.Command.TenantID,
			DeviceID:  item.Command.DeviceID,
			CommandID: item.Command.ID,
		}
		if err := d.wakeups.PublishWakeup(ctx, wakeup); err != nil {
			delay := d.wakeupRetryWait(item.Attempt)
			if delay <= 0 {
				report.Errors = append(report.Errors, fmt.Errorf("retry command %s: %w", item.Command.ID, ErrInvalidConfiguration))
				continue
			}
			retryAt := now.Add(delay)
			if retryErr := d.outbox.RetryWakeup(ctx, tenantID, item.ID, d.workerID, retryAt, err.Error()); retryErr != nil {
				report.Errors = append(report.Errors, fmt.Errorf("reschedule command %s after wakeup failure: %w", item.Command.ID, retryErr))
				continue
			}
			report.Retried++
			continue
		}

		if err := d.outbox.MarkWakeupPublished(ctx, tenantID, item.ID, d.workerID, now); err != nil {
			report.Errors = append(report.Errors, fmt.Errorf("mark command %s wakeup published: %w", item.Command.ID, err))
			continue
		}
		report.Published++
	}

	return report, errors.Join(report.Errors...)
}

// DispatchReport describes commands loaded from durable storage for one active
// device. Delivery failures are intentionally left unresolved: the durable
// command remains eligible for a later wakeup, scan, or reconnect.
type DispatchReport struct {
	Loaded    int
	Delivered int
	Expired   int
	Errors    []error
}

// DispatchPendingForDevice loads durable commands for a resumed or otherwise
// active device. It does not require a preceding wakeup, which is what makes a
// lost Redis message recoverable.
func (d *Dispatcher) DispatchPendingForDevice(ctx context.Context, tenantID, deviceID string, now time.Time) (DispatchReport, error) {
	if tenantID == "" || deviceID == "" {
		return DispatchReport{}, fmt.Errorf("%w: tenant and device IDs are required", ErrInvalidCommand)
	}

	pending, err := d.commands.PendingForDevice(ctx, tenantID, deviceID, now, d.batchSize)
	if err != nil {
		return DispatchReport{}, fmt.Errorf("load pending commands for device %s: %w", deviceID, err)
	}

	report := DispatchReport{Loaded: len(pending)}
	for _, item := range pending {
		if err := item.Validate(); err != nil {
			report.Errors = append(report.Errors, err)
			continue
		}
		if item.Command.TenantID != tenantID || item.Command.DeviceID != deviceID {
			report.Errors = append(report.Errors, fmt.Errorf("%w: pending command %s does not belong to resumed device", ErrInvalidCommand, item.Command.ID))
			continue
		}
		if item.Command.Expired(now) {
			if err := d.commands.ExpireCommand(ctx, tenantID, item.Command.ID, now); err != nil {
				report.Errors = append(report.Errors, fmt.Errorf("expire command %s: %w", item.Command.ID, err))
				continue
			}
			report.Expired++
			continue
		}

		deliveryID, err := d.deliveryIDs.NextDeliveryID()
		if err != nil {
			report.Errors = append(report.Errors, fmt.Errorf("allocate delivery ID for command %s: %w", item.Command.ID, err))
			continue
		}
		delivery := Delivery{
			DeliveryID: deliveryID,
			Command: Command{
				TenantID:  item.Command.TenantID,
				ID:        item.Command.ID,
				DeviceID:  item.Command.DeviceID,
				Kind:      item.Command.Kind,
				Payload:   bytes.Clone(item.Command.Payload),
				IssuedAt:  item.Command.IssuedAt,
				ExpiresAt: item.Command.ExpiresAt,
			},
			Attempt: item.Attempt,
		}
		if err := delivery.Validate(); err != nil {
			report.Errors = append(report.Errors, err)
			continue
		}

		// Persist the physical-attempt audit record before writing the frame. A
		// crash after the write can still result in a later delivery with the
		// same cmd_id, which the edge deduplicates durably.
		if err := d.commands.RecordDeliveryAttempt(ctx, tenantID, delivery, now); err != nil {
			report.Errors = append(report.Errors, fmt.Errorf("record delivery attempt for command %s: %w", item.Command.ID, err))
			continue
		}
		if err := d.deliverer.DeliverCommand(ctx, delivery); err != nil {
			report.Errors = append(report.Errors, fmt.Errorf("deliver command %s: %w", item.Command.ID, err))
			continue
		}
		report.Delivered++
	}

	return report, errors.Join(report.Errors...)
}

// ReceiptStatus is the edge's durable-acceptance response to a CommandDeliver.
type ReceiptStatus string

const (
	ReceiptAccepted   ReceiptStatus = "accepted"
	ReceiptDuplicate  ReceiptStatus = "duplicate"
	ReceiptRetryLater ReceiptStatus = "retry_later"
)

// Receipt identifies both the receipt envelope and the physical delivery it
// acknowledges. ID is the receipt envelope ID used for replay deduplication.
type Receipt struct {
	ID         string
	CommandID  string
	DeliveryID string
	Status     ReceiptStatus
	ReceivedAt time.Time
	RetryAfter time.Duration
	ReasonCode string
}

// ReceiptDecision tells durable storage whether delivery retries should stop or
// remain eligible. RetryAt is calculated from the cloud clock, not ReceivedAt.
type ReceiptDecision struct {
	StopDelivery bool
	RetryAt      time.Time
}

// Decision validates the receipt and derives its durable retry effect.
func (r Receipt) Decision(now time.Time) (ReceiptDecision, error) {
	switch {
	case r.ID == "":
		return ReceiptDecision{}, fmt.Errorf("%w: receipt envelope ID is required", ErrInvalidReceipt)
	case r.CommandID == "":
		return ReceiptDecision{}, fmt.Errorf("%w: command ID is required", ErrInvalidReceipt)
	case r.DeliveryID == "":
		return ReceiptDecision{}, fmt.Errorf("%w: delivery ID is required", ErrInvalidReceipt)
	case r.ReceivedAt.IsZero():
		return ReceiptDecision{}, fmt.Errorf("%w: received time is required", ErrInvalidReceipt)
	}

	switch r.Status {
	case ReceiptAccepted, ReceiptDuplicate:
		if r.RetryAfter != 0 {
			return ReceiptDecision{}, fmt.Errorf("%w: retry delay is only valid for retry_later", ErrInvalidReceipt)
		}
		return ReceiptDecision{StopDelivery: true}, nil
	case ReceiptRetryLater:
		if r.RetryAfter <= 0 || r.RetryAfter > 24*time.Hour {
			return ReceiptDecision{}, fmt.Errorf("%w: retry delay must be in (0, 24h]", ErrInvalidReceipt)
		}
		return ReceiptDecision{RetryAt: now.Add(r.RetryAfter)}, nil
	default:
		return ReceiptDecision{}, fmt.Errorf("%w: unsupported status %q", ErrInvalidReceipt, r.Status)
	}
}

// ReceiptApplyResult reports whether the durable store observed a duplicate
// receipt envelope. Both first writes and duplicates must preserve the same
// command effect.
type ReceiptApplyResult struct {
	Duplicate bool
}

// RecordReceipt persists a device receipt and its retry effect. The store owns
// the transaction so insertion and command status/scheduling cannot diverge.

func (d *Dispatcher) RecordReceipt(ctx context.Context, tenantID string, receipt Receipt, now time.Time) (ReceiptApplyResult, ReceiptDecision, error) {
	if tenantID == "" {
		return ReceiptApplyResult{}, ReceiptDecision{}, fmt.Errorf("%w: tenant ID is required", ErrInvalidCommand)
	}

	decision, err := receipt.Decision(now)
	if err != nil {
		return ReceiptApplyResult{}, ReceiptDecision{}, err
	}

	result, err := d.commands.ApplyReceipt(ctx, tenantID, receipt, decision)
	if err != nil {
		return ReceiptApplyResult{}, ReceiptDecision{}, fmt.Errorf("persist receipt for command %s: %w", receipt.CommandID, err)
	}
	return result, decision, nil
}

// ResultStatus is the terminal outcome reported by the edge in a sequenced
// CommandResult. Unknown is terminal because a non-idempotent physical action
// must not be guessed and repeated after a crash.
type ResultStatus string

const (
	ResultSucceeded ResultStatus = "succeeded"
	ResultFailed    ResultStatus = "failed"
	ResultUnknown   ResultStatus = "unknown"
	ResultExpired   ResultStatus = "expired"
	ResultCancelled ResultStatus = "cancelled"
)

// CommandResult is the durable terminal command record received from an edge.
type CommandResult struct {
	CommandID   string
	Status      ResultStatus
	CompletedAt time.Time
	Attempts    int
	ReasonCode  string
	Reason      string
	Details     []byte
}

// Validate checks the fields that determine the terminal result identity.
func (r CommandResult) Validate() error {
	switch {
	case r.CommandID == "":
		return fmt.Errorf("%w: command ID is required", ErrInvalidResult)
	case r.CompletedAt.IsZero():
		return fmt.Errorf("%w: completion time is required", ErrInvalidResult)
	case r.Attempts < 0:
		return fmt.Errorf("%w: attempts cannot be negative", ErrInvalidResult)
	}

	switch r.Status {
	case ResultSucceeded, ResultFailed, ResultUnknown, ResultExpired, ResultCancelled:
		return nil
	default:
		return fmt.Errorf("%w: unsupported status %q", ErrInvalidResult, r.Status)
	}
}

// ResultApplyResult describes a terminal-result persistence decision.
type ResultApplyResult uint8

const (
	// ResultInserted means this was the command's first terminal result.
	ResultInserted ResultApplyResult = iota + 1
	// ResultDuplicate means a replay exactly matched the existing terminal result.
	ResultDuplicate
)

// EvaluateTerminalResult implements the value-level idempotency rule used by a
// durable store inside its transaction. Existing nil means no terminal result
// has been committed. An exact replay is safe; any difference is an integrity
// conflict rather than last-write-wins state.
func EvaluateTerminalResult(existing *CommandResult, incoming CommandResult) (ResultApplyResult, error) {
	if err := incoming.Validate(); err != nil {
		return 0, err
	}
	if existing == nil {
		return ResultInserted, nil
	}
	if err := existing.Validate(); err != nil {
		return 0, fmt.Errorf("%w: stored result is invalid: %v", ErrConflictingTerminalResult, err)
	}
	if sameTerminalResult(*existing, incoming) {
		return ResultDuplicate, nil
	}
	return 0, fmt.Errorf("%w: command %s already has a different result", ErrConflictingTerminalResult, incoming.CommandID)
}

func sameTerminalResult(left, right CommandResult) bool {
	return left.CommandID == right.CommandID &&
		left.Status == right.Status &&
		left.CompletedAt.Equal(right.CompletedAt) &&
		left.Attempts == right.Attempts &&
		left.ReasonCode == right.ReasonCode &&
		left.Reason == right.Reason &&
		bytes.Equal(left.Details, right.Details)
}

// RecordResult asks durable storage to apply a terminal result atomically. The
// storage implementation must use the same behavior as EvaluateTerminalResult
// while holding its command row lock or equivalent serialization boundary.
func (d *Dispatcher) RecordResult(ctx context.Context, tenantID string, result CommandResult) (ResultApplyResult, error) {
	if tenantID == "" {
		return 0, fmt.Errorf("%w: tenant ID is required", ErrInvalidCommand)
	}
	if err := result.Validate(); err != nil {
		return 0, err
	}

	applied, err := d.commands.ApplyTerminalResult(ctx, tenantID, result)
	if err != nil {
		return 0, fmt.Errorf("persist terminal result for command %s: %w", result.CommandID, err)
	}
	if applied != ResultInserted && applied != ResultDuplicate {
		return 0, fmt.Errorf("persist terminal result for command %s: %w", result.CommandID, ErrInvalidResult)
	}
	return applied, nil
}
