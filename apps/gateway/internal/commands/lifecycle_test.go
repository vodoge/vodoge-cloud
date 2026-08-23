package commands

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/dispatch"
)

// These tests drive SQLLifecycle through a real *sql.DB backed by a recording
// driver, so what is asserted is the statement the settle path actually sends.
//
// The assertions are properties taken from the schema rather than from the code
// under test: app.outbox_status has exactly pending/leased/published, so
// 'published' is the only terminal spelling available, and
// command_outbox_lease_shape forbids a non-leased row from keeping lease_owner
// or lease_expires_at. A test that only echoed the query string back would hold
// nothing in place -- see the console bundle that shipped double-encoded text
// past 41 green tests because the fixtures and the subject were the same bad
// bytes.

type recordedExec struct {
	query string
	args  []driver.NamedValue
}

type execRecorder struct {
	mu    sync.Mutex
	execs []recordedExec
	// rows answers RowsAffected per statement, which is how the settle path
	// learns that the command row was already terminal.
	rows func(query string) int64
}

func (r *execRecorder) record(query string, args []driver.NamedValue) int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.execs = append(r.execs, recordedExec{query: query, args: args})
	if r.rows == nil {
		return 1
	}
	return r.rows(query)
}

// find returns the single statement mentioning needle, failing when the count
// is not exactly one.
func (r *execRecorder) find(t *testing.T, needle string) recordedExec {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	var found []recordedExec
	for _, exec := range r.execs {
		if strings.Contains(exec.query, needle) {
			found = append(found, exec)
		}
	}
	if len(found) != 1 {
		t.Fatalf("statements mentioning %q = %d, want 1; executed:\n%s", needle, len(found), r.dumpLocked())
	}
	return found[0]
}

func (r *execRecorder) count(needle string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	total := 0
	for _, exec := range r.execs {
		if strings.Contains(exec.query, needle) {
			total++
		}
	}
	return total
}

func (r *execRecorder) dumpLocked() string {
	var out strings.Builder
	for _, exec := range r.execs {
		out.WriteString("  --- ")
		out.WriteString(strings.Join(strings.Fields(exec.query), " "))
		out.WriteString("\n")
	}
	return out.String()
}

type recordingConnector struct{ rec *execRecorder }

func (c recordingConnector) Connect(context.Context) (driver.Conn, error) {
	return recordingConn{rec: c.rec}, nil
}

func (c recordingConnector) Driver() driver.Driver { return recordingDriver{} }

type recordingDriver struct{}

func (recordingDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("recording driver is only reachable through sql.OpenDB")
}

type recordingConn struct{ rec *execRecorder }

func (recordingConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("prepared statements are not part of the settle path")
}

func (recordingConn) Close() error { return nil }

func (c recordingConn) Begin() (driver.Tx, error) { return recordingTx{}, nil }

func (c recordingConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	return recordingTx{}, nil
}

func (c recordingConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	return rowsResult(c.rec.record(query, args)), nil
}

type recordingTx struct{}

func (recordingTx) Commit() error   { return nil }
func (recordingTx) Rollback() error { return nil }

type rowsResult int64

func (rowsResult) LastInsertId() (int64, error) { return 0, errors.New("no insert id") }

func (r rowsResult) RowsAffected() (int64, error) { return int64(r), nil }

func newRecordingDB(t *testing.T, rows func(query string) int64) (*sql.DB, *execRecorder) {
	t.Helper()
	rec := &execRecorder{rows: rows}
	db := sql.OpenDB(recordingConnector{rec: rec})
	t.Cleanup(func() { _ = db.Close() })
	return db, rec
}

func sampleResult() dispatch.CommandResult {
	return dispatch.CommandResult{
		CommandID:   "e88c2af8-22e7-4a65-aace-82b690abd643",
		Status:      dispatch.ResultSucceeded,
		CompletedAt: time.Date(2026, 8, 22, 9, 40, 0, 0, time.UTC),
		Attempts:    1,
	}
}

const commandStatusUpdate = "SET status = $1::app.command_status"

func TestSettlingACommandDrivesItsOutboxRowOffThePendingIndex(t *testing.T) {
	t.Parallel()

	db, rec := newRecordingDB(t, nil)
	if err := (SQLLifecycle{DB: db}).RecordResult("t-1", sampleResult()); err != nil {
		t.Fatalf("RecordResult: %v", err)
	}

	settle := rec.find(t, "app.command_outbox")
	if !strings.Contains(settle.query, "status = 'published'") {
		t.Errorf("outbox settle does not drive status to a terminal value. command_outbox_pending_idx is partial on status = 'pending', so it can never shrink:\n%s", settle.query)
	}
	if strings.Contains(settle.query, "'leased'") {
		t.Errorf("outbox settle still advances status only for leased rows. Nothing leases them: production carries 97 outbox rows with attempt_count 0 and published_at NULL:\n%s", settle.query)
	}
	if !strings.Contains(settle.query, "resolved_at") {
		t.Errorf("outbox settle must still record resolved_at:\n%s", settle.query)
	}
	if strings.Contains(settle.query, "published_at") {
		t.Errorf("outbox settle must not fabricate published_at. No wakeup was published, and that NULL is the evidence separating a real publish from an accounting move:\n%s", settle.query)
	}
}

func TestOutboxSettlementClearsTheLeaseColumnsItInvalidates(t *testing.T) {
	t.Parallel()

	db, rec := newRecordingDB(t, nil)
	if err := (SQLLifecycle{DB: db}).RecordResult("t-1", sampleResult()); err != nil {
		t.Fatalf("RecordResult: %v", err)
	}

	settle := rec.find(t, "app.command_outbox")
	for _, column := range []string{"lease_owner = NULL", "lease_expires_at = NULL"} {
		if !strings.Contains(settle.query, column) {
			t.Errorf("outbox settle leaves %s set. command_outbox_lease_shape forbids that on a non-leased row, so settling a leased command would raise a check violation inside the result transaction:\n%s", column, settle.query)
		}
	}
}

func TestALateDeviceAnswerToARetiredCommandIsRecordedNotDropped(t *testing.T) {
	t.Parallel()

	// The command row is already terminal, so the primary UPDATE matches
	// nothing. 0037 makes this reachable: expire_overdue_commands now retires
	// commands in status 'accepted', which is exactly the state of a device
	// that took the command and had not answered yet.
	db, rec := newRecordingDB(t, func(query string) int64 {
		if strings.Contains(query, commandStatusUpdate) {
			return 0
		}
		return 1
	})

	result := sampleResult()
	result.ReasonCode = "modem_busy"
	if err := (SQLLifecycle{DB: db}).RecordResult("t-1", result); err != nil {
		t.Fatalf("a late answer must not be an error, it is information: %v", err)
	}

	late := rec.find(t, "late_result")
	if !strings.Contains(late.query, "status IN ('expired', 'cancelled')") {
		t.Errorf("a late answer may only be merged into a state the cloud assigned itself. succeeded/failed/unknown came from the device, and a differing value there is a conflict rather than news:\n%s", late.query)
	}
	if got, want := len(late.args), 2; got != want {
		t.Fatalf("late result args = %d, want %d", got, want)
	}
	detail, ok := late.args[0].Value.(string)
	if !ok || !strings.Contains(detail, "modem_busy") {
		t.Errorf("late result must carry the device's own reason, got %v", late.args[0].Value)
	}
	if got := late.args[1].Value; got != result.CommandID {
		t.Errorf("late result command id = %v, want %v", got, result.CommandID)
	}
}

func TestACommandStillOpenIsSettledWithoutALateResultKey(t *testing.T) {
	t.Parallel()

	db, rec := newRecordingDB(t, nil)
	if err := (SQLLifecycle{DB: db}).RecordResult("t-1", sampleResult()); err != nil {
		t.Fatalf("RecordResult: %v", err)
	}

	if got := rec.count("late_result"); got != 0 {
		t.Errorf("late_result statements = %d, want 0. A command the cloud had not retired must take the ordinary path, or every replayed result would grow the row", got)
	}
	if got := rec.count(commandStatusUpdate); got != 1 {
		t.Errorf("terminal command updates = %d, want 1", got)
	}
}

func TestRecordResultBindsTheTenantBeforeTouchingAnyTable(t *testing.T) {
	t.Parallel()

	db, rec := newRecordingDB(t, nil)
	if err := (SQLLifecycle{DB: db}).RecordResult("t-1", sampleResult()); err != nil {
		t.Fatalf("RecordResult: %v", err)
	}

	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.execs) == 0 {
		t.Fatal("no statements executed")
	}
	if !strings.Contains(rec.execs[0].query, "set_config('app.tenant_id'") {
		t.Fatalf("first statement = %q; every business table here is under FORCE row-level security", rec.execs[0].query)
	}
}

// QueryContext support was added for the tenant-wide sweep, which reads a count
// back rather than only executing. Recorded the same way as an exec so the
// assertions below can be about the statement that was really sent.
func (c recordingConn) QueryContext(
	_ context.Context, query string, args []driver.NamedValue,
) (driver.Rows, error) {
	c.rec.record(query, args)
	return &singleIntRows{value: 4}, nil
}

type singleIntRows struct {
	value int64
	done  bool
}

func (*singleIntRows) Columns() []string { return []string{"count"} }
func (*singleIntRows) Close() error      { return nil }
func (r *singleIntRows) Next(dest []driver.Value) error {
	if r.done {
		return io.EOF
	}
	r.done = true
	dest[0] = r.value
	return nil
}

// L3: the scheduler's sweep must reach commands belonging to devices that never
// reconnect, which is the gap the per-device form on resume cannot close.
func TestTheTenantSweepIsNotScopedToOneDevice(t *testing.T) {
	t.Parallel()

	db, rec := newRecordingDB(t, nil)
	expired, err := (SQLPending{DB: db}).ExpireTenantCommands(
		context.Background(), "t-a", time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if expired != 4 {
		t.Fatalf("expired = %d, want the count the function returned (4)", expired)
	}

	sweep := rec.find(t, "expire_overdue_tenant_commands")
	// Two arguments, not three. A device_id parameter here would silently
	// reintroduce the very limitation this exists to remove -- 0033 could only
	// sweep the device that had just resumed, so a device that never comes back
	// kept its stale rows forever.
	if len(sweep.args) != 2 {
		t.Fatalf("sweep called with %d arguments, want 2 (tenant, now): %+v",
			len(sweep.args), sweep.args)
	}
	if rec.count("expire_overdue_commands($1::uuid, $2::uuid") != 0 {
		t.Fatal("the tenant sweep fell through to the per-device form")
	}
}

// Every statement in the sweep runs under the tenant's row-level security
// context. Without the bind it would not leak -- it would silently retire
// nothing, which is the failure that is hard to see.
func TestTheTenantSweepBindsTheTenantFirst(t *testing.T) {
	t.Parallel()

	db, rec := newRecordingDB(t, nil)
	if _, err := (SQLPending{DB: db}).ExpireTenantCommands(
		context.Background(), "t-a", time.Now()); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.execs) == 0 {
		t.Fatal("no statements were sent")
	}
	if !strings.Contains(rec.execs[0].query, "set_config('app.tenant_id'") {
		t.Fatalf("first statement is %q, want the tenant bind", rec.execs[0].query)
	}
	if !strings.Contains(rec.execs[0].query, "true") {
		t.Fatal("the tenant bind is not SET LOCAL; a pooled connection would keep it")
	}
}
