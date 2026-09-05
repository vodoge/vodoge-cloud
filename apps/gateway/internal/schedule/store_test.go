package schedule

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

// Fire has to be one transaction. Two would leave a window where a command
// exists that no task admits to issuing, and the whole point of committing them
// together is that the window cannot open.
func TestFireEnqueuesAndBooksInOneTransaction(t *testing.T) {
	source, err := readSource("store.go")
	if err != nil {
		t.Fatalf("read store.go: %v", err)
	}
	body := functionBody(source, "func (store SQL) Fire(")
	if body == "" {
		t.Fatal("SQL.Fire not found")
	}
	if strings.Count(body, "tenant.Transact") != 1 {
		t.Fatalf("SQL.Fire opens %d transactions, want exactly 1:\n%s",
			strings.Count(body, "tenant.Transact"), body)
	}
	if !strings.Contains(body, "app.enqueue_command") {
		t.Fatal("SQL.Fire does not go through app.enqueue_command")
	}
	if !strings.Contains(body, "app.finish_scheduled_task") {
		t.Fatal("SQL.Fire does not record the run in the same transaction")
	}
}

// Every SQL method must bind the tenant before it reads or writes. The tables
// are under FORCE row-level security, so a statement outside tenant.Transact
// does not leak -- it returns nothing, which is worse, because a scheduler that
// silently finds no work looks exactly like one with nothing to do.
func TestEverySQLMethodBindsTheTenant(t *testing.T) {
	source, err := readSource("store.go")
	if err != nil {
		t.Fatalf("read store.go: %v", err)
	}
	for _, method := range []string{
		"func (store SQL) ClaimDue(",
		"func (store SQL) Fire(",
		"func (store SQL) Finish(",
		"func (store SQL) Resolve(",
		"func (store SQL) PublicIP(",
		"func (store SQL) List(",
		"func (store SQL) Create(",
		"func (store SQL) Update(",
		"func (store SQL) Delete(",
	} {
		body := functionBody(source, method)
		if body == "" {
			t.Fatalf("%s not found", method)
		}
		if !strings.Contains(body, "tenant.Transact") {
			t.Fatalf("%s runs outside a tenant transaction", method)
		}
	}
}

// SetEnabled is the one method that binds the tenant through another: it
// delegates so the re-enable rule cannot drift between the two entry points.
func TestSetEnabledDelegatesToUpdate(t *testing.T) {
	source, err := readSource("store.go")
	if err != nil {
		t.Fatalf("read store.go: %v", err)
	}
	for _, method := range []string{
		"func (store SQL) SetEnabled(",
		"func (store *Memory) SetEnabled(",
	} {
		body := functionBody(source, method)
		if body == "" {
			t.Fatalf("%s not found", method)
		}
		if !strings.Contains(body, "store.Update(") {
			t.Fatalf("%s does not delegate; it has its own copy of the re-enable rule", method)
		}
	}
}

// The memory store is only useful as a test double if it reproduces
// app.enqueue_command's two answers to a key that already exists.
func TestMemoryReproducesEnqueueCommandOnAKeyThatExists(t *testing.T) {
	store := bench()
	store.Seed("t1", smsTask(2*time.Minute, time.Now()))
	plan := Plan{
		TaskID: "task-1", Occurrence: 1, Kind: "send_sms", DeviceID: "d",
		IdempotencyKey: "schedule:task-1:1",
		Payload:        json.RawMessage(`{"kind":"SendSms","to":"10086"}`),
	}
	first, err := store.Fire(context.Background(), "t1", plan)
	if err != nil {
		t.Fatalf("first fire: %v", err)
	}
	second, err := store.Fire(context.Background(), "t1", plan)
	if err != nil {
		t.Fatalf("repeat of a matching plan should return the existing command: %v", err)
	}
	if first != second {
		t.Fatalf("repeat returned %q, want the existing %q", second, first)
	}
	if got := len(store.Issued["t1"]); got != 1 {
		t.Fatalf("a repeat created %d commands, want 1", got)
	}

	changed := plan
	changed.Payload = json.RawMessage(`{"kind":"SendSms","to":"10010"}`)
	if _, err := store.Fire(context.Background(), "t1", changed); err == nil {
		t.Fatal("a key bound to a different payload was accepted")
	}
	if got := len(store.Issued["t1"]); got != 1 {
		t.Fatalf("a conflicting plan created a command; %d exist", got)
	}
}

// Creating a task must not make it instantly owe every occurrence since its
// anchor: an operator anchoring to the top of the hour would otherwise get a
// backlog rather than a schedule.
func TestCreateSeedsTheOccurrencePointerFromTheAnchor(t *testing.T) {
	store := bench()
	task := smsTask(2*time.Minute, time.Now().Add(-time.Hour))
	created, err := store.Create(context.Background(), "t1", task)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.LastOccurrence < 29 {
		t.Fatalf("last_occurrence seeded at %d, want the current occurrence (~30)",
			created.LastOccurrence)
	}
	claims, err := store.ClaimDue(context.Background(), "t1", "w", time.Now(), time.Minute, 8)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if len(claims) != 0 {
		t.Fatalf("a freshly created task owed %d occurrences immediately", len(claims))
	}
}

// Re-enabling a task must not replay the silence.
func TestReEnablingDoesNotReplayWhatWasDeliberatelyNotSent(t *testing.T) {
	store := bench()
	task := smsTask(2*time.Minute, time.Now().Add(-time.Hour))
	task.Enabled = false
	created, err := store.Create(context.Background(), "t1", task)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	store.mu.Lock()
	store.find("t1", created.ID).LastOccurrence = 0
	store.mu.Unlock()

	updated, err := store.SetEnabled(context.Background(), "t1", created.ID, true)
	if err != nil {
		t.Fatalf("enable: %v", err)
	}
	if updated.LastOccurrence < 29 {
		t.Fatalf("re-enabling left %d occurrences owed", 30-updated.LastOccurrence)
	}
}

// The selector is the one field a schedule can change in place, and the store
// has to actually change it. A write that reports success and leaves the row
// alone is how an operator comes to believe a task was repointed when it was
// not -- which is exactly what happened: a schedule was thought to be aimed at
// a healthy module and was in fact only switched back on against the old one.
func TestUpdateAppliesASelectorAndRefusesOneThatCouldOnlyFail(t *testing.T) {
	store := bench()
	created, err := store.Create(context.Background(), "t1", smsTask(2*time.Minute, time.Now()))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	const moved = "89852351225042214201"

	target := Selector{Mode: SelectorCard, ICCID: moved}
	updated, err := store.Update(context.Background(), "t1", created.ID, Edit{Selector: &target})
	if err != nil {
		t.Fatalf("update selector: %v", err)
	}
	if updated.Selector.ICCID != moved {
		t.Fatalf("update answered with iccid %q, want %q", updated.Selector.ICCID, moved)
	}
	reread, err := store.List(context.Background(), "t1")
	if err != nil || len(reread) != 1 {
		t.Fatalf("list after update: %v %#v", err, reread)
	}
	if reread[0].Selector.ICCID != moved {
		t.Fatalf("stored iccid = %q, want %q", reread[0].Selector.ICCID, moved)
	}

	// A card selector with no ICCID resolves to nothing on every run. Refused
	// while the caller is there, and the working selector survives.
	blank := Selector{Mode: SelectorCard}
	if _, err := store.Update(context.Background(), "t1", created.ID, Edit{Selector: &blank}); err == nil {
		t.Fatal("a card selector with no iccid was accepted")
	}
	reread, _ = store.List(context.Background(), "t1")
	if reread[0].Selector.ICCID != moved {
		t.Fatalf("a refused update left iccid %q", reread[0].Selector.ICCID)
	}

	// An enabled-only edit must not touch the selector: it is round-tripped
	// through a closed struct, so rewriting it on every toggle would drop
	// anything the struct does not name.
	off := false
	after, err := store.Update(context.Background(), "t1", created.ID, Edit{Enabled: &off})
	if err != nil {
		t.Fatalf("disable: %v", err)
	}
	if after.Enabled || after.Selector.ICCID != moved {
		t.Fatalf("disable produced enabled=%v iccid=%q", after.Enabled, after.Selector.ICCID)
	}
}

// The SQL store has to validate before it writes and read the row under a lock
// while it does. Validating after the write would store a selector that fails
// once an hour with nobody watching, and reading without FOR UPDATE would let
// two concurrent edits each validate against a row the other has replaced.
func TestSQLUpdateValidatesUnderALockBeforeItWrites(t *testing.T) {
	source, err := readSource("store.go")
	if err != nil {
		t.Fatalf("read store.go: %v", err)
	}
	body := functionBody(source, "func (store SQL) Update(")
	if body == "" {
		t.Fatal("SQL.Update not found")
	}
	if !strings.Contains(body, "FOR UPDATE") {
		t.Fatalf("SQL.Update reads the row without a lock:\n%s", body)
	}
	validate := strings.Index(body, "Validate(&merged)")
	write := strings.Index(body, "UPDATE app.scheduled_tasks")
	if validate < 0 {
		t.Fatalf("SQL.Update writes a selector it never validated:\n%s", body)
	}
	if write < 0 || validate > write {
		t.Fatalf("SQL.Update validates after it writes:\n%s", body)
	}
	if strings.Count(body, "tenant.Transact") != 1 {
		t.Fatalf("SQL.Update opens %d transactions, want exactly 1",
			strings.Count(body, "tenant.Transact"))
	}
}

// A claim must not hand the same occurrence to a second worker while the first
// still holds a live lease.
func TestALiveLeaseHidesTheTaskFromOtherWorkers(t *testing.T) {
	store := bench()
	start := time.Now().Add(-5 * time.Minute)
	store.Seed("t1", smsTask(2*time.Minute, start))
	now := time.Now()

	first, err := store.ClaimDue(context.Background(), "t1", "a", now, time.Minute, 8)
	if err != nil || len(first) != 1 {
		t.Fatalf("first claim: %v (%d)", err, len(first))
	}
	second, err := store.ClaimDue(context.Background(), "t1", "b", now, time.Minute, 8)
	if err != nil {
		t.Fatalf("second claim: %v", err)
	}
	if len(second) != 0 {
		t.Fatalf("a live lease was ignored; %d claims handed out", len(second))
	}
	third, err := store.ClaimDue(
		context.Background(), "t1", "b", now.Add(2*time.Minute), time.Minute, 8)
	if err != nil || len(third) != 1 {
		t.Fatalf("a lapsed lease should be claimable: %v (%d)", err, len(third))
	}
}

// The claim reports the next occurrence owed, not the current one, so a backlog
// is worked one at a time rather than emitted as a burst.
func TestClaimReportsTheNextOwedOccurrenceAndTheCurrentOne(t *testing.T) {
	store := bench()
	anchor := time.Now().Add(-10 * time.Minute)
	store.Seed("t1", smsTask(2*time.Minute, anchor))
	claims, err := store.ClaimDue(context.Background(), "t1", "a", time.Now(), time.Minute, 8)
	if err != nil || len(claims) != 1 {
		t.Fatalf("claim: %v (%d)", err, len(claims))
	}
	if claims[0].Occurrence != 1 {
		t.Fatalf("claimed occurrence %d, want the oldest owed (1)", claims[0].Occurrence)
	}
	if claims[0].DueOccurrence < 5 {
		t.Fatalf("due occurrence reported as %d, want about 5", claims[0].DueOccurrence)
	}
}

// readSource and functionBody let a test assert on structure that no runtime
// call can reach: whether Fire opens one transaction is not observable from
// outside it, and it is the property the duplicate protection rests on.
func readSource(name string) (string, error) {
	data, err := os.ReadFile(name)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func functionBody(source, signature string) string {
	start := strings.Index(source, signature)
	if start < 0 {
		return ""
	}
	depth := 0
	for index := start; index < len(source); index++ {
		switch source[index] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return source[start : index+1]
			}
		}
	}
	return ""
}

// 🔴 按卡找目标时，已退休的模组不该被看见。
//
// `app.modems.managed` 是 0055 加的：「False once the edge stops listing this
// IMEI in managed_imeis. The row and everything referencing it are kept; the
// console hides it.」`catalog.go` 列模组时确实过滤了，而这里没有。
//
// 后果不是「可能选中错的一根」——它比那更难查：一张卡从已退休的模组 A 换到
// 在管的模组 B 之后，两行同 ICCID，`LIMIT 2` 返回 2，于是走 default 分支报
// ErrAmbiguousTarget。而运维在控制台上**只看得到一根**带这张卡的模组，
// 那个「有歧义」的错误因此无从解释。
//
// 0055 的注释把这种困惑描述过一次（在列表那一侧）：「indistinguishable from
// a healthy module that went quiet, which is the confusion this whole change
// removes」。它从列表里移除了，没有从调度器里移除。
func TestResolvingACardDoesNotSeeRetiredModems(t *testing.T) {
	source, err := readSource("store.go")
	if err != nil {
		t.Fatalf("read store.go: %v", err)
	}
	body := functionBody(source, "func (store SQL) Resolve(")
	if body == "" {
		t.Fatalf("Resolve not found — 这条守卫已经瞎了，先修它再谈别的")
	}
	flat := strings.Join(strings.Fields(body), " ")

	const byCard = "FROM app.modems WHERE iccid = $1"
	if !strings.Contains(flat, byCard) {
		t.Fatalf("按 ICCID 查的那条语句变了形，守卫盯不住它了:\n%s", flat)
	}
	if !strings.Contains(flat, byCard+" AND managed") {
		t.Fatalf("按 ICCID 查目标时没有排除已退休的模组:\n%s", flat)
	}
}

// 阴性对照：IMEI 钉死的那条**不该**加这个条件。
//
// 它上面的注释写着理由：「The module is not required to be in the inventory.
// The IMEI was pinned by an operator, so there is no wrong-card risk, and a
// module can drop out of app.modems for a poll cycle after a restart --
// refusing then would turn a blip into a schedule that stays broken.」
//
// 没有这条对照，上面那条可以靠「给每一处都加上 managed」通过，
// 而那会把一次重启后的短暂缺席变成一个永久坏掉的计划任务。
func TestAPinnedIMEIIsStillResolvedAfterItStopsBeingManaged(t *testing.T) {
	source, err := readSource("store.go")
	if err != nil {
		t.Fatalf("read store.go: %v", err)
	}
	body := functionBody(source, "func (store SQL) Resolve(")
	if body == "" {
		t.Fatalf("Resolve not found")
	}
	flat := strings.Join(strings.Fields(body), " ")

	const byIMEI = "SELECT iccid FROM app.modems WHERE device_id = $1::uuid AND imei = $2"
	if !strings.Contains(flat, byIMEI) {
		t.Fatalf("按 IMEI 查的那条语句变了形，守卫盯不住它了:\n%s", flat)
	}
	if strings.Contains(flat, byIMEI+" AND managed") {
		t.Fatalf("IMEI 钉死的那条被加上了 managed —— 一次重启后的短暂缺席会变成永久坏掉的计划任务")
	}
}
