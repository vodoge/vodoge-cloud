package schedule

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/tenant"
)

// SQL is the production store. Every method goes through tenant.Transact, so
// every statement runs under SET LOCAL app.tenant_id and inside the row-level
// security policy rather than around it.
type SQL struct{ DB *sql.DB }

// ClaimDue leases the tenant's due tasks.
func (store SQL) ClaimDue(
	ctx context.Context, tenantID, owner string, now time.Time,
	lease time.Duration, limit int,
) ([]Claim, error) {
	if store.DB == nil {
		return nil, nil
	}
	var claims []Claim
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT task_id::text,
			       task_name,
			       task_action,
			       coalesce(task_command_kind, ''),
			       task_selector,
			       task_request,
			       task_interval_seconds,
			       task_occurrence,
			       task_occurrence_at,
			       task_due_occurrence
			  FROM app.claim_due_scheduled_tasks(
			           $1::uuid, $2, $3, make_interval(secs => $4), $5)`,
			tenantID, owner, now, lease.Seconds(), limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var claim Claim
			var selector, request []byte
			if err := rows.Scan(
				&claim.Task.ID,
				&claim.Task.Name,
				&claim.Task.Action,
				&claim.Task.CommandKind,
				&selector,
				&request,
				&claim.IntervalSeconds,
				&claim.Occurrence,
				&claim.OccurrenceAt,
				&claim.DueOccurrence,
			); err != nil {
				return err
			}
			// A selector that will not decode is a broken task, not a broken
			// tick: it is reported through the normal preparation failure path
			// so the console shows why, instead of aborting the whole tenant's
			// batch and taking healthy tasks down with it.
			if err := json.Unmarshal(selector, &claim.Task.Selector); err != nil {
				claim.Task.Selector = Selector{}
			}
			claim.Task.Request = json.RawMessage(request)
			claim.Task.IntervalSeconds = claim.IntervalSeconds
			claims = append(claims, claim)
		}
		return rows.Err()
	})
	return claims, err
}

// Fire enqueues the command and records the run in one transaction.
//
// One transaction, not two. The pair has to be atomic or there is a window
// where a command exists that no task admits to issuing: the next tick would
// claim the same occurrence and enqueue again. That second enqueue is harmless
// because the key is derived, but then the derived key is carrying two
// different failures at once, and the day someone "simplifies" it there is no
// test that fails.
//
// A key that already exists with a matching payload comes back as the command
// that is already there -- app.enqueue_command returns it rather than inserting
// -- so a repeat of this whole transaction converges instead of duplicating.
func (store SQL) Fire(ctx context.Context, tenantID string, plan Plan) (string, error) {
	if store.DB == nil {
		return "", errors.New("database is not configured")
	}
	var commandID string
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		if err := tx.QueryRowContext(ctx, `
			SELECT id::text
			  FROM app.enqueue_command($1::uuid, $2::uuid, $3::app.command_kind,
			                           $4::jsonb, $5, $6)`,
			tenantID, plan.DeviceID, plan.Kind, string(plan.Payload),
			plan.IdempotencyKey, plan.ExpiresAt,
		).Scan(&commandID); err != nil {
			return err
		}
		detail, _ := json.Marshal(map[string]any{
			"kind":            plan.Kind,
			"device_id":       plan.DeviceID,
			"command_id":      commandID,
			"idempotency_key": plan.IdempotencyKey,
			"occurrence":      plan.Occurrence,
		})
		_, err := tx.ExecContext(ctx, `
			SELECT app.finish_scheduled_task(
			           $1::uuid, $2::uuid, $3::bigint, $4, $5::jsonb, $6::uuid, now())`,
			tenantID, plan.TaskID, plan.Occurrence, StatusIssued,
			string(detail), commandID)
		return err
	})
	if err != nil {
		if isKeyConflict(err) {
			return "", errors.Join(ErrKeyConflict, err)
		}
		return "", err
	}
	return commandID, nil
}

// isKeyConflict recognises app.enqueue_command refusing to bind one idempotency
// key to two different commands.
//
// Matched on SQLSTATE rather than on the message text. 23505 is also what a
// plain unique violation raises, which is the same situation seen from a
// different angle -- either way the key is taken by something that is not this
// plan, and the correct response is to stop rather than to issue a second
// command under a different key.
func isKeyConflict(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23505"
	}
	return false
}

// Finish releases the lease and records the outcome.
func (store SQL) Finish(ctx context.Context, tenantID string, done Completion) error {
	if store.DB == nil {
		return nil
	}
	detail := done.Detail
	if len(detail) == 0 {
		detail = json.RawMessage(`{}`)
	}
	var occurrence sql.NullInt64
	if done.Occurrence != nil {
		occurrence = sql.NullInt64{Int64: *done.Occurrence, Valid: true}
	}
	var commandID sql.NullString
	if done.CommandID != "" {
		commandID = sql.NullString{String: done.CommandID, Valid: true}
	}
	return tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			SELECT app.finish_scheduled_task(
			           $1::uuid, $2::uuid, $3::bigint, $4, $5::jsonb, $6::uuid, now())`,
			tenantID, done.TaskID, occurrence, done.Status, string(detail), commandID)
		return err
	})
}

// Resolve turns a selector into the device and module to act on, now.
func (store SQL) Resolve(
	ctx context.Context, tenantID string, selector Selector,
) (Target, error) {
	if store.DB == nil {
		return Target{}, errors.New("database is not configured")
	}
	var target Target
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		switch selector.Mode {
		case SelectorCard:
			rows, err := tx.QueryContext(ctx, `
				SELECT device_id::text, coalesce(imei, ''), coalesce(iccid, '')
				  FROM app.modems
				 WHERE iccid = $1
				 ORDER BY updated_at DESC
				 LIMIT 2`, strings.TrimSpace(selector.ICCID))
			if err != nil {
				return err
			}
			defer rows.Close()
			var found []Target
			for rows.Next() {
				var one Target
				if err := rows.Scan(&one.DeviceID, &one.ModemIMEI, &one.ICCID); err != nil {
					return err
				}
				found = append(found, one)
			}
			if err := rows.Err(); err != nil {
				return err
			}
			switch len(found) {
			case 0:
				return ErrUnknownTarget
			case 1:
				target = found[0]
				if target.ModemIMEI == "" {
					// app.modems.imei is the projection's key everywhere else,
					// so an empty one means the row predates 0013's backfill.
					// Sending from a module the cloud cannot name is not
					// something to do quietly.
					return ErrUnknownTarget
				}
				return nil
			default:
				// Two modules claiming one ICCID means the inventory is mid
				// update or a card really was moved. Either way, guessing which
				// one to bill is not the scheduler's call.
				return ErrAmbiguousTarget
			}
		case SelectorDevice:
			var deviceID string
			err := tx.QueryRowContext(ctx,
				`SELECT id::text FROM app.devices WHERE id = $1::uuid`,
				strings.TrimSpace(selector.DeviceID)).Scan(&deviceID)
			if errors.Is(err, sql.ErrNoRows) {
				return ErrUnknownTarget
			}
			if err != nil {
				return err
			}
			target = Target{DeviceID: deviceID, ModemIMEI: strings.TrimSpace(selector.ModemIMEI)}
			// The module is not required to be in the inventory. The IMEI was
			// pinned by an operator, so there is no wrong-card risk, and a
			// module can drop out of app.modems for a poll cycle after a
			// restart -- refusing then would turn a blip into a schedule that
			// stays broken. Its ICCID is recorded when it is known.
			if target.ModemIMEI != "" {
				var iccid sql.NullString
				_ = tx.QueryRowContext(ctx,
					`SELECT iccid FROM app.modems WHERE device_id = $1::uuid AND imei = $2`,
					deviceID, target.ModemIMEI).Scan(&iccid)
				target.ICCID = iccid.String
			}
			return nil
		default:
			return ErrUnknownTarget
		}
	})
	return target, err
}

// PublicIP reads the egress address the edge last reported for a device.
func (store SQL) PublicIP(
	ctx context.Context, tenantID, deviceID string,
) (PublicIPReading, error) {
	var reading PublicIPReading
	if store.DB == nil {
		return reading, errors.New("database is not configured")
	}
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		var address sql.NullString
		var reportedAt sql.NullTime
		err := tx.QueryRowContext(ctx,
			`SELECT public_ip, host_reported_at FROM app.devices WHERE id = $1::uuid`,
			deviceID).Scan(&address, &reportedAt)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrUnknownTarget
		}
		if err != nil {
			return err
		}
		reading.Found = address.Valid && address.String != ""
		reading.PublicIP = address.String
		if reportedAt.Valid {
			reading.ReportedAt = reportedAt.Time
		}
		return nil
	})
	return reading, err
}

const taskColumns = `
	id::text, name, enabled, action, coalesce(command_kind::text, ''),
	selector, request, interval_seconds, anchor_at, last_occurrence,
	last_run_at, coalesce(last_status, ''), last_detail,
	coalesce(last_command_id::text, '')`

func scanTask(rows interface{ Scan(...any) error }) (Task, error) {
	var task Task
	var selector, request, detail []byte
	var lastRun sql.NullTime
	if err := rows.Scan(
		&task.ID, &task.Name, &task.Enabled, &task.Action, &task.CommandKind,
		&selector, &request, &task.IntervalSeconds, &task.AnchorAt,
		&task.LastOccurrence, &lastRun, &task.LastStatus, &detail,
		&task.LastCommandID,
	); err != nil {
		return Task{}, err
	}
	_ = json.Unmarshal(selector, &task.Selector)
	task.Request = json.RawMessage(request)
	task.LastDetail = json.RawMessage(detail)
	if lastRun.Valid {
		when := lastRun.Time
		task.LastRunAt = &when
	}
	return task, nil
}

// List returns the tenant's schedules, newest configuration first.
func (store SQL) List(ctx context.Context, tenantID string) ([]Task, error) {
	tasks := []Task{}
	if store.DB == nil {
		return tasks, nil
	}
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx,
			`SELECT `+taskColumns+` FROM app.scheduled_tasks ORDER BY name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			task, err := scanTask(rows)
			if err != nil {
				return err
			}
			tasks = append(tasks, task)
		}
		return rows.Err()
	})
	return tasks, err
}

// Create inserts a schedule.
//
// last_occurrence is seeded with the occurrence the anchor implies right now,
// not with zero. An operator who anchors a task to midnight so it lands on the
// hour would otherwise create a task that owes every occurrence since midnight,
// and the scheduler would work through them one tick at a time.
func (store SQL) Create(ctx context.Context, tenantID string, task Task) (Task, error) {
	if store.DB == nil {
		return Task{}, errors.New("database is not configured")
	}
	selector, err := json.Marshal(task.Selector)
	if err != nil {
		return Task{}, err
	}
	request := task.Request
	if len(request) == 0 {
		request = json.RawMessage(`{}`)
	}
	var kind sql.NullString
	if task.CommandKind != "" {
		kind = sql.NullString{String: task.CommandKind, Valid: true}
	}
	anchor := task.AnchorAt
	if anchor.IsZero() {
		anchor = time.Now()
	}
	var created Task
	err = tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		row := tx.QueryRowContext(ctx, `
			INSERT INTO app.scheduled_tasks
			    (tenant_id, name, enabled, action, command_kind, selector, request,
			     interval_seconds, anchor_at, last_occurrence)
			VALUES (app.current_tenant_id(), $1, $2, $3, $4::app.command_kind,
			        $5::jsonb, $6::jsonb, $7::integer, $8::timestamptz,
			        GREATEST(0, floor(
			            extract(epoch FROM (now() - $8::timestamptz)) / $7::integer
			        )::bigint))
			RETURNING `+taskColumns,
			task.Name, task.Enabled, task.Action, kind, string(selector),
			string(request), task.IntervalSeconds, anchor)
		var err error
		created, err = scanTask(row)
		return err
	})
	return created, err
}

// Edit is a partial change to a schedule: a nil field is not being changed.
//
// Two fields and no more. enabled is a switch and renumbers nothing. selector
// is re-evaluated on every run by design -- 0038 stores it as "how the target
// is found ... evaluated at fire time rather than stored" -- so repointing a
// task at another SIM changes what the next run resolves and leaves the
// occurrence grid alone. Interval, anchor, request and kind are the fields that
// would renumber or redefine occurrences already in flight; they stay out, and
// the route refuses them by name rather than accepting them here.
type Edit struct {
	Enabled  *bool
	Selector *Selector
}

// Editor is the store capability behind PATCH /v1/schedules/{id}.
//
// Kept apart from Store rather than folded into it. A store that cannot apply
// an edit should be impossible to write, not impossible to distinguish from
// one that can: the route asserts for this interface and answers an error when
// it is missing, which is the one thing PATCH must never do quietly.
type Editor interface {
	Update(ctx context.Context, tenantID, taskID string, edit Edit) (Task, error)
}

var (
	_ Editor = SQL{}
	_ Editor = (*Memory)(nil)
)

// Update applies a partial edit in one transaction.
//
// The row is read FOR UPDATE and the merged task is validated before the
// write, so a selector that could only fail on every run -- card mode with no
// ICCID, device mode with no IMEI for a module-scoped kind -- is refused while
// the caller is still there, exactly as Create refuses it. Validation needs the
// fields the caller did not send (action, kind, request), which is why this is
// a read and a write rather than one UPDATE.
//
// selector goes through coalesce so an enabled-only edit does not rewrite it.
// Marshalling a Selector back out drops every key the struct does not name, and
// doing that on each on/off toggle would quietly narrow rows nobody asked to
// touch.
//
// Re-enabling still does not replay the silence: last_occurrence moves to the
// current occurrence, because the occurrences that passed while the task was
// off were deliberately not sent and firing them now would be a burst of
// messages nobody asked for.
func (store SQL) Update(
	ctx context.Context, tenantID, taskID string, edit Edit,
) (Task, error) {
	if store.DB == nil {
		return Task{}, errors.New("database is not configured")
	}
	var updated Task
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		current, err := scanTask(tx.QueryRowContext(ctx,
			`SELECT `+taskColumns+`
			   FROM app.scheduled_tasks
			  WHERE id = $1::uuid
			    FOR UPDATE`, taskID))
		if err != nil {
			return err
		}
		enabled := current.Enabled
		if edit.Enabled != nil {
			enabled = *edit.Enabled
		}
		var selector sql.NullString
		if edit.Selector != nil {
			merged := current
			merged.Selector = *edit.Selector
			if err := Validate(&merged); err != nil {
				return err
			}
			encoded, err := json.Marshal(*edit.Selector)
			if err != nil {
				return err
			}
			selector = sql.NullString{String: string(encoded), Valid: true}
		}
		updated, err = scanTask(tx.QueryRowContext(ctx, `
			UPDATE app.scheduled_tasks
			   SET enabled = $2,
			       selector = coalesce($3::jsonb, selector),
			       last_occurrence = CASE
			           WHEN $2 AND NOT enabled THEN GREATEST(last_occurrence, floor(
			               extract(epoch FROM (now() - anchor_at)) / interval_seconds
			           )::bigint)
			           ELSE last_occurrence
			       END,
			       updated_at = now()
			 WHERE id = $1::uuid
			RETURNING `+taskColumns, taskID, enabled, selector))
		return err
	})
	if errors.Is(err, sql.ErrNoRows) {
		return Task{}, sql.ErrNoRows
	}
	return updated, err
}

// SetEnabled turns a schedule on or off. One code path with Update, so the
// re-enable rule cannot drift between the two entry points.
func (store SQL) SetEnabled(
	ctx context.Context, tenantID, taskID string, enabled bool,
) (Task, error) {
	return store.Update(ctx, tenantID, taskID, Edit{Enabled: &enabled})
}

// Delete removes a schedule and reports whether it existed.
func (store SQL) Delete(ctx context.Context, tenantID, taskID string) (bool, error) {
	if store.DB == nil {
		return false, nil
	}
	removed := false
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx,
			`DELETE FROM app.scheduled_tasks WHERE id = $1::uuid`, taskID)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		removed = count > 0
		return nil
	})
	return removed, err
}

// Memory is an in-process store for tests and for a gateway with no database.
//
// It reproduces the two behaviours the runner's correctness rests on: the
// occurrence high-water mark only ever moves forward, and an idempotency key
// that is already bound returns the existing command instead of creating a
// second one. A fake without those would let a duplicate-delivery bug pass
// every test in this package.
type Memory struct {
	mu    sync.Mutex
	Tasks map[string][]*Task
	// Issued records every command the store was asked to create, keyed by
	// tenant, in order. Tests read it to count deliveries.
	Issued map[string][]IssuedCommand
	// Modems maps ICCID to a target, standing in for app.modems.
	Modems map[string]Target
	// Devices is the set of device ids that exist.
	Devices map[string]bool
	// Readings stands in for the reported host block.
	Readings map[string]PublicIPReading

	byKey  map[string]IssuedCommand
	nextID int
}

// IssuedCommand is one command Memory was asked to enqueue.
type IssuedCommand struct {
	CommandID      string
	TaskID         string
	Occurrence     int64
	Kind           string
	DeviceID       string
	IdempotencyKey string
	Payload        string
	ExpiresAt      time.Time
}

func (store *Memory) init() {
	if store.Tasks == nil {
		store.Tasks = map[string][]*Task{}
	}
	if store.Issued == nil {
		store.Issued = map[string][]IssuedCommand{}
	}
	if store.byKey == nil {
		store.byKey = map[string]IssuedCommand{}
	}
	if store.Modems == nil {
		store.Modems = map[string]Target{}
	}
	if store.Devices == nil {
		store.Devices = map[string]bool{}
	}
	if store.Readings == nil {
		store.Readings = map[string]PublicIPReading{}
	}
}

// Seed adds a task directly, bypassing validation, and returns its id.
func (store *Memory) Seed(tenantID string, task Task) string {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.init()
	if task.ID == "" {
		store.nextID++
		task.ID = "task-" + strconv.Itoa(store.nextID)
	}
	if task.AnchorAt.IsZero() {
		task.AnchorAt = time.Now()
	}
	if len(task.Request) == 0 {
		task.Request = json.RawMessage(`{}`)
	}
	copied := task
	store.Tasks[tenantID] = append(store.Tasks[tenantID], &copied)
	return copied.ID
}

func (store *Memory) find(tenantID, taskID string) *Task {
	for _, task := range store.Tasks[tenantID] {
		if task.ID == taskID {
			return task
		}
	}
	return nil
}

// ClaimDue leases due tasks. Leases are honoured so a test can simulate a
// worker that stalled.
func (store *Memory) ClaimDue(
	_ context.Context, tenantID, owner string, now time.Time,
	lease time.Duration, limit int,
) ([]Claim, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.init()
	var claims []Claim
	for _, task := range store.Tasks[tenantID] {
		if len(claims) >= limit {
			break
		}
		if !task.Enabled || task.IntervalSeconds <= 0 {
			continue
		}
		if task.leaseUntil.After(now) {
			continue
		}
		due := occurrenceAt(task.AnchorAt, task.IntervalSeconds, now)
		if due <= task.LastOccurrence {
			continue
		}
		task.leaseUntil = now.Add(lease)
		task.leaseOwner = owner
		next := task.LastOccurrence + 1
		claims = append(claims, Claim{
			Task:            *task,
			Occurrence:      next,
			OccurrenceAt:    occurrenceTime(task.AnchorAt, task.IntervalSeconds, next),
			DueOccurrence:   due,
			IntervalSeconds: task.IntervalSeconds,
		})
	}
	return claims, nil
}

// Fire enqueues and books in one step, the way the SQL store does.
func (store *Memory) Fire(_ context.Context, tenantID string, plan Plan) (string, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.init()

	// app.enqueue_command's contract: a repeat of a bound key returns the
	// command that exists when the payload matches, and refuses when it does
	// not. Both branches matter -- the first is what makes a retry safe, the
	// second is what stops an edited task from being sent twice.
	if existing, bound := store.byKey[tenantID+"|"+plan.IdempotencyKey]; bound {
		if existing.Payload != string(plan.Payload) ||
			existing.DeviceID != plan.DeviceID ||
			existing.Kind != plan.Kind {
			return "", ErrKeyConflict
		}
		store.advance(tenantID, plan, existing.CommandID)
		return existing.CommandID, nil
	}
	store.nextID++
	issued := IssuedCommand{
		CommandID:      "cmd-" + strconv.Itoa(store.nextID),
		TaskID:         plan.TaskID,
		Occurrence:     plan.Occurrence,
		Kind:           plan.Kind,
		DeviceID:       plan.DeviceID,
		IdempotencyKey: plan.IdempotencyKey,
		Payload:        string(plan.Payload),
		ExpiresAt:      plan.ExpiresAt,
	}
	store.byKey[tenantID+"|"+plan.IdempotencyKey] = issued
	store.Issued[tenantID] = append(store.Issued[tenantID], issued)
	store.advance(tenantID, plan, issued.CommandID)
	return issued.CommandID, nil
}

func (store *Memory) advance(tenantID string, plan Plan, commandID string) {
	task := store.find(tenantID, plan.TaskID)
	if task == nil {
		return
	}
	if plan.Occurrence > task.LastOccurrence {
		task.LastOccurrence = plan.Occurrence
	}
	task.LastStatus = StatusIssued
	task.LastCommandID = commandID
	task.leaseUntil = time.Time{}
	task.leaseOwner = ""
}

// Finish records an outcome and clears the lease.
func (store *Memory) Finish(_ context.Context, tenantID string, done Completion) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.init()
	task := store.find(tenantID, done.TaskID)
	if task == nil {
		return nil
	}
	if done.Occurrence != nil && *done.Occurrence > task.LastOccurrence {
		task.LastOccurrence = *done.Occurrence
	}
	task.LastStatus = done.Status
	task.LastDetail = done.Detail
	task.LastCommandID = done.CommandID
	task.leaseUntil = time.Time{}
	task.leaseOwner = ""
	return nil
}

// Resolve mirrors the SQL rules without a database.
func (store *Memory) Resolve(
	_ context.Context, _ string, selector Selector,
) (Target, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.init()
	switch selector.Mode {
	case SelectorCard:
		target, ok := store.Modems[selector.ICCID]
		if !ok {
			return Target{}, ErrUnknownTarget
		}
		return target, nil
	case SelectorDevice:
		if !store.Devices[selector.DeviceID] {
			return Target{}, ErrUnknownTarget
		}
		return Target{DeviceID: selector.DeviceID, ModemIMEI: selector.ModemIMEI}, nil
	default:
		return Target{}, ErrUnknownTarget
	}
}

// PublicIP returns a seeded reading.
func (store *Memory) PublicIP(
	_ context.Context, _, deviceID string,
) (PublicIPReading, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.init()
	return store.Readings[deviceID], nil
}

// List returns the tenant's tasks.
func (store *Memory) List(_ context.Context, tenantID string) ([]Task, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.init()
	out := []Task{}
	for _, task := range store.Tasks[tenantID] {
		out = append(out, *task)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// Create adds a task.
func (store *Memory) Create(_ context.Context, tenantID string, task Task) (Task, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.init()
	for _, existing := range store.Tasks[tenantID] {
		if existing.Name == task.Name {
			return Task{}, errors.New("a schedule with that name already exists")
		}
	}
	store.nextID++
	task.ID = "task-" + strconv.Itoa(store.nextID)
	if task.AnchorAt.IsZero() {
		task.AnchorAt = time.Now()
	}
	if len(task.Request) == 0 {
		task.Request = json.RawMessage(`{}`)
	}
	if len(task.LastDetail) == 0 {
		task.LastDetail = json.RawMessage(`{}`)
	}
	task.LastOccurrence = occurrenceAt(task.AnchorAt, task.IntervalSeconds, time.Now())
	if task.LastOccurrence < 0 {
		task.LastOccurrence = 0
	}
	copied := task
	store.Tasks[tenantID] = append(store.Tasks[tenantID], &copied)
	return copied, nil
}

// Update applies a partial edit, validating a new selector the way SQL does.
func (store *Memory) Update(
	_ context.Context, tenantID, taskID string, edit Edit,
) (Task, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.init()
	task := store.find(tenantID, taskID)
	if task == nil {
		return Task{}, sql.ErrNoRows
	}
	if edit.Selector != nil {
		merged := *task
		merged.Selector = *edit.Selector
		if err := Validate(&merged); err != nil {
			return Task{}, err
		}
		task.Selector = *edit.Selector
	}
	if edit.Enabled != nil {
		if *edit.Enabled && !task.Enabled {
			if due := occurrenceAt(task.AnchorAt, task.IntervalSeconds, time.Now()); due > task.LastOccurrence {
				task.LastOccurrence = due
			}
		}
		task.Enabled = *edit.Enabled
	}
	return *task, nil
}

// SetEnabled toggles a task.
func (store *Memory) SetEnabled(
	ctx context.Context, tenantID, taskID string, enabled bool,
) (Task, error) {
	return store.Update(ctx, tenantID, taskID, Edit{Enabled: &enabled})
}

// Delete removes a task.
func (store *Memory) Delete(_ context.Context, tenantID, taskID string) (bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.init()
	for index, task := range store.Tasks[tenantID] {
		if task.ID == taskID {
			store.Tasks[tenantID] = append(
				store.Tasks[tenantID][:index], store.Tasks[tenantID][index+1:]...)
			return true, nil
		}
	}
	return false, nil
}

// occurrenceAt is the occurrence number in force at a moment.
func occurrenceAt(anchor time.Time, intervalSeconds int, at time.Time) int64 {
	if intervalSeconds <= 0 {
		return 0
	}
	elapsed := at.Sub(anchor)
	interval := time.Duration(intervalSeconds) * time.Second
	// Integer division truncates towards zero, which is not floor for negative
	// elapsed time: an anchor in the future would otherwise report occurrence 0
	// as already reached.
	quotient := elapsed / interval
	if elapsed < 0 && elapsed%interval != 0 {
		quotient--
	}
	return int64(quotient)
}

func occurrenceTime(anchor time.Time, intervalSeconds int, occurrence int64) time.Time {
	return anchor.Add(time.Duration(intervalSeconds) * time.Second * time.Duration(occurrence))
}
