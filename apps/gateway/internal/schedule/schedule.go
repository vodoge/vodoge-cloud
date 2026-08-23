// Package schedule issues recurring commands without an operator present.
//
// The gateway had no timer of any kind before this. internal/rules reacts to
// messages that arrive; every command this deployment ever issued came from a
// console click. Keeping a prepaid number alive needs the opposite shape: one
// SMS on a cadence, unattended, for as long as the SIM is meant to survive.
//
// # The failure this package exists to make impossible
//
// Sending the same message twice. A command that has reached a modem cannot be
// recalled, and nothing downstream can tell a duplicate from a second
// intention -- app.enqueue_command treats two sends as distinct on purpose,
// because two AT+CSQ readings really are two readings.
//
// So the rule is: retry only what happens before the modem is involved.
// Resolving the target, reading the plan and building the payload are all
// safely repeatable and are repeated. Everything from app.enqueue_command
// onwards is repeated too -- but only because the idempotency key it is given
// is a pure function of (task, occurrence), so a repeat lands on the row that
// already exists instead of creating a second one. Those are the only two
// modes. There is no "retry the send".
//
// # Occurrences, not elapsed time
//
// A task has a fixed anchor and an interval. Occurrence n is the instant
// anchor + n*interval, and the task's last_occurrence is a high-water mark over
// those integers. Nothing anywhere adds an interval to "when I last ran",
// which is the formulation that drifts, double-counts across a restart, and
// gives no stable name to the thing being deduplicated.
package schedule

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/commands"
)

// Actions a task can perform when it comes due.
const (
	// ActionCommand enqueues a durable command, the same way a console click
	// does. Every kind in commands.Kinds() is available, including ones this
	// deployment cannot execute yet: the scheduler builds and validates
	// through commands.BuildPayload and never interprets a kind itself, so a
	// command added later is schedulable the day it exists.
	ActionCommand = "command"
	// ActionPublicIPCheck records the egress address the edge last reported.
	//
	// Not a command: the agent already carries public_ip in every DeviceState,
	// so asking the device again would be a round trip for a fact the cloud is
	// holding. What was missing is a record over time and something that
	// notices when the answer changes or goes stale.
	ActionPublicIPCheck = "public_ip_check"
)

// Selector modes.
const (
	// SelectorCard names a SIM by ICCID and resolves whichever module holds it
	// at fire time. This is the mode that matters for keeping a number alive:
	// pin a modem IMEI instead and the day the SIM moves, the schedule keeps
	// sending from the wrong card and still reports success.
	SelectorCard = "card"
	// SelectorDevice names an edge box. Commands that need a module require the
	// IMEI to be given: picking one on the operator's behalf when a device has
	// three is how the wrong number gets billed.
	SelectorDevice = "device"
)

// Run statuses recorded in scheduled_tasks.last_status.
const (
	// StatusIssued means a command exists for this occurrence. It does not
	// claim the device did anything: the command's own status carries that.
	StatusIssued = "issued"
	// StatusChecked means a cloud-side action produced a reading.
	StatusChecked = "checked"
	// StatusPrepareFailed is the only retried outcome. Nothing was handed to a
	// modem, so the occurrence stays owed and the next tick tries again until
	// it either succeeds or goes stale.
	StatusPrepareFailed = "prepare_failed"
	// StatusSkippedStale means the occurrence was too old to be worth acting
	// on. Recorded rather than silently dropped, because "the gateway was down
	// for an hour" and "the schedule is broken" look identical otherwise.
	StatusSkippedStale = "skipped_stale"
	// StatusKeyConflict means the idempotency key for this occurrence already
	// belongs to a command with a different payload -- the task was edited
	// while an occurrence was in flight. The occurrence is closed rather than
	// retried: the key existing proves a command for it was already created,
	// and issuing another under a fresh key is exactly the double send this
	// package refuses to perform.
	StatusKeyConflict = "key_conflict"
	// StatusStoreFailed means the enqueue transaction did not commit. Safe to
	// retry for the same reason every other repeat is safe.
	StatusStoreFailed = "store_failed"
)

// Errors the preparation stage can return. All of them are retryable: none has
// touched a device.
var (
	// ErrUnknownTarget means the selector matched nothing right now. A SIM can
	// be out of the inventory for a poll cycle after a module restarts, so this
	// is a transient condition rather than a broken task.
	ErrUnknownTarget = errors.New("scheduled task target could not be resolved")
	// ErrAmbiguousTarget means the selector matched more than one module.
	ErrAmbiguousTarget = errors.New("scheduled task target is ambiguous")
)

// Selector is how a task finds what to act on, evaluated on every run.
type Selector struct {
	Mode      string `json:"mode"`
	DeviceID  string `json:"device_id,omitempty"`
	ICCID     string `json:"iccid,omitempty"`
	ModemIMEI string `json:"modem_imei,omitempty"`
}

// Target is one resolved (device, module) pair.
type Target struct {
	DeviceID  string
	ModemIMEI string
	ICCID     string
}

// Task is one schedule as the console sees it.
type Task struct {
	ID              string          `json:"id"`
	Name            string          `json:"name"`
	Enabled         bool            `json:"enabled"`
	Action          string          `json:"action"`
	CommandKind     string          `json:"command_kind,omitempty"`
	Selector        Selector        `json:"selector"`
	Request         json.RawMessage `json:"request"`
	IntervalSeconds int             `json:"interval_seconds"`
	AnchorAt        time.Time       `json:"-"`
	LastOccurrence  int64           `json:"last_occurrence"`
	LastRunAt       *time.Time      `json:"-"`
	LastStatus      string          `json:"last_status,omitempty"`
	LastDetail      json.RawMessage `json:"last_detail,omitempty"`
	LastCommandID   string          `json:"last_command_id,omitempty"`

	// Lease bookkeeping for Memory only. The SQL store keeps it in the row,
	// where another process can see it; these two exist so the in-process fake
	// can reproduce a stalled worker whose lease lapses, which is one of the
	// paths that must not produce a second command.
	leaseOwner string
	leaseUntil time.Time
}

// NextDueAt is when the task next owes an occurrence, ignoring whether anything
// is listening. Reported so the console can show a schedule that is enabled but
// never ticking, which otherwise looks the same as one that is merely early.
func (task Task) NextDueAt() time.Time {
	if task.IntervalSeconds <= 0 {
		return time.Time{}
	}
	return task.AnchorAt.Add(
		time.Duration(task.IntervalSeconds) * time.Second * time.Duration(task.LastOccurrence+1),
	)
}

// Claim is one leased task with the occurrence it owes next.
type Claim struct {
	Task            Task
	Occurrence      int64
	OccurrenceAt    time.Time
	DueOccurrence   int64
	IntervalSeconds int
}

// Plan is a claim resolved into something that can be written.
//
// Every field is a pure function of the claim and of what the database said
// about the target at resolve time. Nothing here reads a clock or a random
// source: the moment Payload varies between two attempts at the same
// occurrence, app.enqueue_command stops recognising them as the same command
// and the duplicate protection is gone.
type Plan struct {
	TaskID         string
	Occurrence     int64
	Kind           string
	DeviceID       string
	IdempotencyKey string
	Payload        json.RawMessage
	ExpiresAt      time.Time
	// To and Body are carried so a caller can mirror a scheduled SMS into the
	// conversation the way the console handler does. Empty for other kinds.
	To   string
	Body string
}

// Completion is the bookkeeping written when a run ends.
//
// Occurrence is nil for a preparation failure, which leaves the high-water mark
// where it was so the same occurrence is attempted again.
type Completion struct {
	TaskID     string
	Occurrence *int64
	Status     string
	Detail     json.RawMessage
	CommandID  string
}

// PublicIPReading is what the edge last said about its egress address.
type PublicIPReading struct {
	PublicIP   string
	ReportedAt time.Time
	Found      bool
}

// Store is the tenant-scoped persistence the runner needs.
//
// Fire is deliberately not "enqueue" plus "finish": those two writes have to
// land in one transaction, or a crash between them leaves a command that no
// task admits to having issued, and the next tick issues it again under the
// same key -- which works, but only because of the key, and one safety net
// carrying two failures is one too many.
type Store interface {
	ClaimDue(ctx context.Context, tenantID, owner string, now time.Time,
		lease time.Duration, limit int) ([]Claim, error)
	Fire(ctx context.Context, tenantID string, plan Plan) (commandID string, err error)
	Finish(ctx context.Context, tenantID string, done Completion) error
	Resolve(ctx context.Context, tenantID string, selector Selector) (Target, error)
	PublicIP(ctx context.Context, tenantID, deviceID string) (PublicIPReading, error)

	List(ctx context.Context, tenantID string) ([]Task, error)
	Create(ctx context.Context, tenantID string, task Task) (Task, error)
	SetEnabled(ctx context.Context, tenantID, taskID string, enabled bool) (Task, error)
	Delete(ctx context.Context, tenantID, taskID string) (bool, error)
}

// ErrKeyConflict reports that an idempotency key is bound to a different
// command. Stores raise it so the runner can close the occurrence instead of
// retrying it.
var ErrKeyConflict = errors.New("idempotency key is bound to a different command")

// IdempotencyKey names an occurrence, and nothing else.
//
// This one function is what makes double delivery impossible rather than
// unlikely. It must not include a timestamp, a counter, a random value, or the
// payload: every one of those makes a second attempt at the same occurrence
// look like a new intention to app.enqueue_command, which is precisely how the
// duplicate gets created.
func IdempotencyKey(taskID string, occurrence int64) string {
	return fmt.Sprintf("schedule:%s:%d", taskID, occurrence)
}

// commandTTL is how long a scheduled command stays deliverable.
//
// Clamped rather than taken from the interval directly. A keep-alive SMS that
// arrives forty minutes late has already failed at its job and only costs money
// and confusion, so the ceiling is low; the floor exists because expires_at has
// to stay comfortably ahead of issued_at even when the tick fires late, and
// app.commands has a CHECK that turns a violation into an error inside a live
// transaction.
func commandTTL(intervalSeconds int) time.Duration {
	ttl := time.Duration(intervalSeconds) * time.Second
	if ttl < 5*time.Minute {
		ttl = 5 * time.Minute
	}
	if ttl > 30*time.Minute {
		ttl = 30 * time.Minute
	}
	return ttl
}

// Validate checks a task the way the command endpoint checks a request: while
// the caller is still there to fix it.
//
// Command payloads are validated through commands.BuildPayload with stand-in
// identifiers where the real ones are only knowable at fire time. That catches
// every field rule -- an empty SMS body, a phone number that is not one, an AT
// command that does not start with AT -- without duplicating a single one of
// them here. A second copy of those rules is a second thing to keep in step.
func Validate(task *Task) error {
	if task == nil {
		return commands.ErrInvalid{Reason: "task is required"}
	}
	task.Name = strings.TrimSpace(task.Name)
	if task.Name == "" {
		return commands.ErrInvalid{Reason: "name is required"}
	}
	if task.IntervalSeconds < 60 || task.IntervalSeconds > 604800 {
		return commands.ErrInvalid{
			Reason: "interval_seconds must be between 60 and 604800",
		}
	}
	switch task.Selector.Mode {
	case SelectorCard:
		if strings.TrimSpace(task.Selector.ICCID) == "" {
			return commands.ErrInvalid{Reason: "selector.iccid is required when mode is card"}
		}
	case SelectorDevice:
		if strings.TrimSpace(task.Selector.DeviceID) == "" {
			return commands.ErrInvalid{Reason: "selector.device_id is required when mode is device"}
		}
	default:
		return commands.ErrInvalid{Reason: "selector.mode must be card or device"}
	}
	if len(task.Request) == 0 {
		task.Request = json.RawMessage(`{}`)
	}

	switch task.Action {
	case ActionPublicIPCheck:
		if task.CommandKind != "" {
			return commands.ErrInvalid{
				Reason: "command_kind is not allowed for a public_ip_check task",
			}
		}
		return nil
	case ActionCommand:
	default:
		return commands.ErrInvalid{Reason: "action must be command or public_ip_check"}
	}

	spec, known := commands.Lookup(task.CommandKind)
	if !known {
		return commands.ErrInvalid{
			Reason: fmt.Sprintf("unsupported command kind %q, expected one of %s",
				task.CommandKind, strings.Join(commands.Kinds(), ", ")),
		}
	}
	// A module-scoped command in device mode needs an IMEI nobody can supply
	// later: card mode reads it off the SIM, device mode has nowhere to get it
	// from. Refusing now beats a task that fails silently every hour.
	if spec.NeedsModem &&
		task.Selector.Mode == SelectorDevice &&
		strings.TrimSpace(task.Selector.ModemIMEI) == "" {
		return commands.ErrInvalid{
			Reason: fmt.Sprintf(
				"%s acts on a module, so selector.modem_imei is required in device mode",
				task.CommandKind),
		}
	}
	_, err := buildRequest(*task, Target{
		// Stand-ins with the right shape. Only the field rules are being
		// exercised here; the real target is resolved on every run.
		DeviceID:  placeholderDeviceID,
		ModemIMEI: placeholderIMEI,
	})
	return err
}

const (
	placeholderDeviceID = "00000000-0000-4000-8000-000000000000"
	placeholderIMEI     = "000000000000000"
)

// buildRequest turns a stored task plus a resolved target into a validated
// command payload.
func buildRequest(task Task, target Target) ([]byte, error) {
	var request commands.Request
	if len(task.Request) > 0 {
		if err := json.Unmarshal(task.Request, &request); err != nil {
			return nil, commands.ErrInvalid{Reason: "request is not a command object"}
		}
	}
	// The stored request never decides the target. Letting it would give a task
	// two disagreeing answers to "which SIM", and the selector is the one that
	// gets re-evaluated when hardware moves.
	request.Kind = task.CommandKind
	request.DeviceID = target.DeviceID
	request.ModemIMEI = target.ModemIMEI
	_, payload, err := commands.BuildPayload(request)
	if err != nil {
		return nil, err
	}
	return payload, nil
}

// Sweeper does one tenant's periodic housekeeping. Optional.
//
// It returns what it reclaimed even alongside an error, because the jobs
// behind it run in separate transactions and a later failure does not undo an
// earlier success.
type Sweeper func(
	ctx context.Context, tenantID string, now time.Time,
) (commands.SweepResult, error)

// Runner drives one tick of the scheduler.
type Runner struct {
	Store Store
	// Live reports the tenants worth ticking and, per tenant, the devices
	// currently connected. This is the whole answer to tenant enumeration:
	// app.tenants is under FORCE row-level security and cannot be listed, so
	// the tenant has to arrive from a live mTLS session instead of a query.
	Live func() map[string][]string
	// Owner names this process in a lease so a stalled worker's tasks become
	// claimable again without anything having to notice it stalled.
	Owner string
	// Sweep is the tenant-scoped housekeeping pass: overdue command recovery
	// (L3) and the app.ingress retention window (1.8), run once per tenant per
	// tick. Kept here rather than on its own timer because this is the only
	// place that holds a tenant id without a device having just reconnected --
	// app.tenants cannot be enumerated, so a global cleanup job has nowhere to
	// stand.
	Sweep Sweeper
	// OnCommandIssued lets a caller mirror a scheduled command elsewhere -- a
	// scheduled SMS belongs in the conversation the same as a clicked one.
	// Called after the enqueue transaction commits, so it cannot roll it back.
	OnCommandIssued func(tenantID string, plan Plan, commandID string)
	Now             func() time.Time
	Logger          *slog.Logger
	// Batch bounds how many tasks one tenant can claim per tick.
	Batch int
	// Lease is how long a claim is held before another worker may take it.
	Lease time.Duration
}

// Report is what one tick did, for tests and logging.
type Report struct {
	Tenants  int
	Claimed  int
	Issued   int
	Checked  int
	Skipped  int
	Failed   int
	Expired  int
	Pruned   int
	Conflict int
}

func (runner *Runner) now() time.Time {
	if runner.Now != nil {
		return runner.Now()
	}
	return time.Now()
}

func (runner *Runner) logger() *slog.Logger {
	if runner.Logger != nil {
		return runner.Logger
	}
	return slog.Default()
}

func (runner *Runner) batch() int {
	if runner.Batch > 0 {
		return runner.Batch
	}
	return 32
}

func (runner *Runner) lease() time.Duration {
	if runner.Lease > 0 {
		return runner.Lease
	}
	return time.Minute
}

// Tick runs every due task for every tenant that currently has a device
// connected, and runs those tenants' housekeeping: overdue command recovery
// and the ingress retention window.
func (runner *Runner) Tick(ctx context.Context) Report {
	var report Report
	if runner == nil || runner.Store == nil || runner.Live == nil {
		return report
	}
	live := runner.Live()
	report.Tenants = len(live)
	for tenantID := range live {
		if ctx.Err() != nil {
			return report
		}
		now := runner.now()
		if runner.Sweep != nil {
			// Counted before the error is examined. The sweep's jobs commit
			// separately, so a failure in the second one leaves the first one's
			// work done, and a report that dropped it would understate what the
			// database actually holds.
			swept, err := runner.Sweep(ctx, tenantID, now)
			report.Expired += swept.ExpiredCommands
			report.Pruned += swept.PrunedIngress
			if err != nil {
				runner.logger().Warn("tenant housekeeping did not finish",
					"tenant_id", tenantID,
					"expired", swept.ExpiredCommands,
					"pruned", swept.PrunedIngress,
					"error", err)
			}
			if swept.ExpiredCommands > 0 {
				runner.logger().Info("retired commands that outlived their expiry",
					"tenant_id", tenantID, "count", swept.ExpiredCommands,
					"trigger", "schedule_tick")
			}
			if swept.PrunedIngress > 0 {
				runner.logger().Info("pruned ingress records past the retention window",
					"tenant_id", tenantID, "count", swept.PrunedIngress,
					"trigger", "schedule_tick")
			}
		}
		claims, err := runner.Store.ClaimDue(
			ctx, tenantID, runner.Owner, now, runner.lease(), runner.batch())
		if err != nil {
			runner.logger().Warn("due scheduled tasks could not be claimed",
				"tenant_id", tenantID, "error", err)
			continue
		}
		report.Claimed += len(claims)
		for _, claim := range claims {
			runner.run(ctx, tenantID, claim, now, &report)
		}
	}
	return report
}

// run executes one claimed occurrence.
func (runner *Runner) run(
	ctx context.Context, tenantID string, claim Claim, now time.Time, report *Report,
) {
	log := runner.logger()

	// Too late to be worth doing. The pointer jumps to just before the current
	// occurrence rather than to it, so the next tick fires the current one
	// promptly instead of waiting out another whole period.
	if runner.stale(claim, now) {
		resume := claim.DueOccurrence - 1
		detail := mustDetail(map[string]any{
			"skipped_from":  claim.Occurrence,
			"skipped_to":    resume,
			"late_by_secs":  int64(now.Sub(claim.OccurrenceAt).Seconds()),
			"occurrence_at": claim.OccurrenceAt.UTC().Format(time.RFC3339),
		})
		report.Skipped++
		log.Warn("scheduled occurrences were too old to act on",
			"tenant_id", tenantID, "task_id", claim.Task.ID, "task", claim.Task.Name,
			"from", claim.Occurrence, "to", resume)
		runner.finish(ctx, tenantID, Completion{
			TaskID:     claim.Task.ID,
			Occurrence: &resume,
			Status:     StatusSkippedStale,
			Detail:     detail,
		})
		return
	}

	target, err := runner.Store.Resolve(ctx, tenantID, claim.Task.Selector)
	if err != nil {
		runner.prepareFailed(ctx, tenantID, claim, "resolve", err, report)
		return
	}

	switch claim.Task.Action {
	case ActionPublicIPCheck:
		runner.checkPublicIP(ctx, tenantID, claim, target, report)
	case ActionCommand:
		runner.issueCommand(ctx, tenantID, claim, target, now, report)
	default:
		// Unreachable through the API and the CHECK constraint, but a task row
		// older than the code that reads it is a real thing, and a silent
		// no-op that keeps re-claiming forever is the worst version of it.
		runner.prepareFailed(ctx, tenantID, claim, "action",
			fmt.Errorf("unsupported action %q", claim.Task.Action), report)
	}
}

// stale reports whether an occurrence is more than one whole period late.
//
// One period is the threshold because it is the point at which acting on the
// old occurrence and acting on the current one are the same event to anyone
// watching, and doing both would be the duplicate this package refuses.
func (runner *Runner) stale(claim Claim, now time.Time) bool {
	if claim.IntervalSeconds <= 0 {
		return false
	}
	return now.Sub(claim.OccurrenceAt) > time.Duration(claim.IntervalSeconds)*time.Second
}

func (runner *Runner) issueCommand(
	ctx context.Context, tenantID string, claim Claim, target Target,
	now time.Time, report *Report,
) {
	payload, err := buildRequest(claim.Task, target)
	if err != nil {
		runner.prepareFailed(ctx, tenantID, claim, "payload", err, report)
		return
	}
	var request commands.Request
	_ = json.Unmarshal(claim.Task.Request, &request)

	plan := Plan{
		TaskID:         claim.Task.ID,
		Occurrence:     claim.Occurrence,
		Kind:           claim.Task.CommandKind,
		DeviceID:       target.DeviceID,
		IdempotencyKey: IdempotencyKey(claim.Task.ID, claim.Occurrence),
		Payload:        payload,
		ExpiresAt:      now.Add(commandTTL(claim.IntervalSeconds)),
		To:             request.To,
		Body:           request.Body,
	}

	commandID, err := runner.Store.Fire(ctx, tenantID, plan)
	switch {
	case errors.Is(err, ErrKeyConflict):
		// The key exists with a different payload, which can only mean the task
		// was edited between two attempts at the same occurrence. A command for
		// this occurrence therefore already exists. Closing it is the safe
		// direction; re-issuing under a fresh key would be the double send.
		report.Conflict++
		occurrence := claim.Occurrence
		runner.logger().Warn("scheduled occurrence was already issued with a different payload",
			"tenant_id", tenantID, "task_id", claim.Task.ID, "occurrence", occurrence)
		runner.finish(ctx, tenantID, Completion{
			TaskID:     claim.Task.ID,
			Occurrence: &occurrence,
			Status:     StatusKeyConflict,
			Detail:     mustDetail(map[string]any{"error": err.Error()}),
		})
		return
	case err != nil:
		// The enqueue transaction did not commit, so no command exists and no
		// bookkeeping moved. Release the lease and record why; the retry is
		// safe because it recomputes the same key.
		report.Failed++
		runner.logger().Warn("scheduled command could not be enqueued",
			"tenant_id", tenantID, "task_id", claim.Task.ID,
			"occurrence", claim.Occurrence, "error", err)
		runner.finish(ctx, tenantID, Completion{
			TaskID: claim.Task.ID,
			Status: StatusStoreFailed,
			Detail: mustDetail(map[string]any{"stage": "enqueue", "error": err.Error()}),
		})
		return
	}

	// Fire committed the completion inside its own transaction, so there is no
	// second write here and no window in which the command exists but the task
	// does not know.
	report.Issued++
	runner.logger().Info("scheduled command issued",
		"tenant_id", tenantID, "task_id", claim.Task.ID, "task", claim.Task.Name,
		"kind", plan.Kind, "occurrence", plan.Occurrence,
		"device_id", plan.DeviceID, "command_id", commandID,
		"idempotency_key", plan.IdempotencyKey)
	if runner.OnCommandIssued != nil {
		runner.OnCommandIssued(tenantID, plan, commandID)
	}
}

func (runner *Runner) checkPublicIP(
	ctx context.Context, tenantID string, claim Claim, target Target, report *Report,
) {
	reading, err := runner.Store.PublicIP(ctx, tenantID, target.DeviceID)
	if err != nil {
		runner.prepareFailed(ctx, tenantID, claim, "public_ip", err, report)
		return
	}
	occurrence := claim.Occurrence
	detail := map[string]any{
		"device_id": target.DeviceID,
		"found":     reading.Found,
	}
	if reading.Found {
		detail["public_ip"] = reading.PublicIP
		detail["reported_at"] = reading.ReportedAt.UTC().Format(time.RFC3339)
	}
	// A missing reading is a result, not an error: it says the agent on that
	// box is too old to report vitals, or has not reported since it started.
	// Recording it advances the occurrence, because asking again immediately
	// would produce the same answer.
	report.Checked++
	runner.finish(ctx, tenantID, Completion{
		TaskID:     claim.Task.ID,
		Occurrence: &occurrence,
		Status:     StatusChecked,
		Detail:     mustDetail(detail),
	})
}

// prepareFailed records a failure that happened before anything left the cloud.
//
// The occurrence is left owed. This is the only retry in the package, and it is
// safe precisely because the preparation stage has no external effect: no
// command row, no outbox row, no modem. It stops on its own when the occurrence
// goes stale.
func (runner *Runner) prepareFailed(
	ctx context.Context, tenantID string, claim Claim,
	stage string, cause error, report *Report,
) {
	report.Failed++
	runner.logger().Warn("scheduled task could not be prepared",
		"tenant_id", tenantID, "task_id", claim.Task.ID, "task", claim.Task.Name,
		"occurrence", claim.Occurrence, "stage", stage, "error", cause)
	runner.finish(ctx, tenantID, Completion{
		TaskID: claim.Task.ID,
		Status: StatusPrepareFailed,
		Detail: mustDetail(map[string]any{"stage": stage, "error": cause.Error()}),
	})
}

func (runner *Runner) finish(ctx context.Context, tenantID string, done Completion) {
	if err := runner.Store.Finish(ctx, tenantID, done); err != nil {
		// The lease is still held, so nothing re-runs until it lapses. That is
		// the conservative outcome and needs no compensation here.
		runner.logger().Warn("scheduled task bookkeeping failed",
			"tenant_id", tenantID, "task_id", done.TaskID,
			"status", done.Status, "error", err)
	}
}

func mustDetail(detail map[string]any) json.RawMessage {
	encoded, err := json.Marshal(detail)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return encoded
}
