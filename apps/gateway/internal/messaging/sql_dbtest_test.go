//go:build dbtest

// 真正打数据库的测试。
//
// 🔴 这个文件存在的理由：网关这一侧的 SQL 在此之前**一条都没有自动化覆盖**。
//
//	包里的测试全部跑在 `Memory` 这个假件上，而假件不会因为 SQL 写错而变红。
//	代价刚刚发生过一次：2026-09-18 把 catalog.ListCommands 的
//	`payload - 'password'` 改成按参数删键，整棵树 32 个包全绿，而那条语句
//	**从来没有被任何测试执行过** —— 它第一次运行就是在生产上。那次是靠手工
//	在生产库上 SELECT 验的，而手工验证不会在下一个人改它的时候再做一遍。
//
// ⚠️ 用 build tag 而不是「读不到环境变量就 t.Skip」：跳过的测试会安静地永远
//
//	跳过，而这正是这个仓库反复吃亏的那个形状。加了 `-tags dbtest` 就是明确
//	要求跑它，那么连不上库必须是**失败**，不是跳过。
package messaging

import (
	"context"
	"database/sql"
	"os"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/tenant"
)

const (
	dbTenant = "9b000000-0000-4000-8000-000000000001"
	dbDevice = "9b000000-0000-4000-8000-000000000002"
)

func openDB(t *testing.T) *sql.DB {
	t.Helper()
	dsn := os.Getenv("VODOGE_TEST_DATABASE_URL")
	if dsn == "" {
		t.Fatal("VODOGE_TEST_DATABASE_URL 没设 —— 用 -tags dbtest 跑就是要求真的打库，" +
			"连不上必须是失败而不是跳过")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("连库：%v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := db.Ping(); err != nil {
		t.Fatalf("库 ping 不通：%v", err)
	}
	return db
}

// 建一个租户和一台设备，测试结束时整租户删掉。
func seedTenant(t *testing.T, db *sql.DB) {
	t.Helper()
	ctx := context.Background()
	cleanup := func() {
		for _, statement := range []string{
			`DELETE FROM app.ingress WHERE tenant_id = $1::uuid`,
			`DELETE FROM app.messages WHERE tenant_id = $1::uuid`,
			`DELETE FROM app.command_outbox WHERE tenant_id = $1::uuid`,
			`DELETE FROM app.commands WHERE tenant_id = $1::uuid`,
			`DELETE FROM app.devices WHERE tenant_id = $1::uuid`,
			`DELETE FROM app.tenants WHERE id = $1::uuid`,
		} {
			_, _ = db.ExecContext(ctx, statement, dbTenant)
		}
	}
	cleanup()
	t.Cleanup(cleanup)

	if _, err := db.ExecContext(ctx,
		`INSERT INTO app.tenants (id, slug, name, status, region)
		 VALUES ($1::uuid, 'dbtest', 'db test', 'active', 'cn')`, dbTenant); err != nil {
		t.Fatalf("建租户：%v", err)
	}
	if _, err := db.ExecContext(ctx,
		`INSERT INTO app.devices (id, tenant_id, imei, name, vertical)
		 VALUES ($1::uuid, $2::uuid, '860000000000099', 'dbtest', 'iot')`,
		dbDevice, dbTenant); err != nil {
		t.Fatalf("建设备：%v", err)
	}
}

// 排一条 send_sms，并把它镜像成一条 outbound 消息。返回 command id。
// 排一条 send_sms，并把它镜像成一条 outbound 消息。返回 command id。
//
// ⚠️ 走 `tenant.Transact` 而不是自己 set_config：租户上下文是**事务内**的
//
//	（BindSQL 用 is_local=true），一条一条发过去的话下一条就看不见它了。
//	这也顺带让测试走的是生产那条路。
func seedSend(t *testing.T, db *sql.DB, key string) string {
	t.Helper()
	var commandID string
	err := tenant.Transact(context.Background(), db, dbTenant, func(tx *sql.Tx) error {
		if err := tx.QueryRow(`
			SELECT id::text FROM app.enqueue_command(
			    $1::uuid, $2::uuid, 'send_sms',
			    '{"kind":"SendSms","to":"10086","body":"x"}'::jsonb,
			    $3, now() + interval '10 minutes')`,
			dbTenant, dbDevice, key).Scan(&commandID); err != nil {
			return err
		}
		_, err := tx.Exec(`
			INSERT INTO app.messages
			    (tenant_id, device_id, direction, peer, body, bearer,
			     status, received_at, seq, command_id)
			VALUES ($1::uuid, $2::uuid, 'outbound', '10086', 'x', 'unknown',
			        'queued', now(), 0, $3::uuid)`,
			dbTenant, dbDevice, commandID)
		return err
	})
	if err != nil {
		t.Fatalf("排一条 send_sms：%v", err)
	}
	return commandID
}

func messageRow(t *testing.T, db *sql.DB, commandID string) (status string, reference *int, reason *string) {
	t.Helper()
	if err := db.QueryRowContext(context.Background(), `
		SELECT status, provider_reference, failure_reason
		  FROM app.messages WHERE command_id = $1::uuid`, commandID).
		Scan(&status, &reference, &reason); err != nil {
		t.Fatalf("读消息行：%v", err)
	}
	return status, reference, reason
}

// 让云端放弃这条命令：把"现在"推到过期之后，跑生产上那个函数。
func cloudGivesUp(t *testing.T, db *sql.DB) {
	t.Helper()
	err := tenant.Transact(context.Background(), db, dbTenant, func(tx *sql.Tx) error {
		_, err := tx.Exec(
			`SELECT app.expire_overdue_tenant_commands($1::uuid, now() + interval '20 minutes')`,
			dbTenant)
		return err
	})
	if err != nil {
		t.Fatalf("跑过期清理：%v", err)
	}
}

// 常态：还在等的时候设备答复。
func TestSettlingAQueuedSendWritesTheReference(t *testing.T) {
	db := openDB(t)
	seedTenant(t, db)
	commandID := seedSend(t, db, "dbtest-queued")

	store := SQL{DB: db}
	reference := 41
	if err := store.SettleOutbound(context.Background(), dbTenant, commandID,
		"sent", "", &reference); err != nil {
		t.Fatalf("结算：%v", err)
	}

	status, got, _ := messageRow(t, db, commandID)
	if status != "sent" {
		t.Fatalf("status = %q，期望 sent", status)
	}
	if got == nil || *got != 41 {
		t.Fatalf("provider_reference = %v，期望 41", got)
	}
}

// 🔴 这一条是这个修复本身：云端已经放弃之后，设备的答复才到。
//
// 在修复之前，那条 UPDATE 带着 `AND status = 'queued'`，于是它更新 **0 行**，
// 而且没人看 RowsAffected —— TP-MR 被静默丢掉，而 0068 写下的那句
// 「先查投递回执」指向的就成了一张结构上不可能出现的回执。
func TestALateAnswerStillRecordsTheReference(t *testing.T) {
	db := openDB(t)
	seedTenant(t, db)
	commandID := seedSend(t, db, "dbtest-late")

	// 设备接过（accepted_at 非空 = 0068 里"接受过"那一支）
	if _, err := db.ExecContext(context.Background(),
		`UPDATE app.commands SET status='accepted', accepted_at=now() WHERE id=$1::uuid`,
		commandID); err != nil {
		t.Fatalf("标记 accepted：%v", err)
	}
	cloudGivesUp(t, db)

	status, reference, reason := messageRow(t, db, commandID)
	if status != "failed" || reference != nil {
		t.Fatalf("云端放弃之后应当是 failed 且没有 reference，拿到 %q / %v", status, reference)
	}
	if reason == nil {
		t.Fatal("云端放弃时没有写下理由")
	}

	// 设备迟到的答复。
	store := SQL{DB: db}
	late := 42
	if err := store.SettleOutbound(context.Background(), dbTenant, commandID,
		"sent", "", &late); err != nil {
		t.Fatalf("迟到结算：%v", err)
	}

	status, reference, reason = messageRow(t, db, commandID)
	if reference == nil || *reference != 42 {
		t.Fatalf("迟到的答复没有写下 TP-MR：%v —— 投递回执就永远配不上这一行", reference)
	}
	if status != "sent" {
		t.Fatalf("status = %q，期望 sent —— Threads 按 queued/failed 数未发送，"+
			"一条真发出去了的短信会一直提示再发一次", status)
	}
	if reason == nil || *reason != LateSentence {
		t.Fatalf("failure_reason = %q，期望 %q（SQL 和 Memory 两侧必须说同一句话）",
			text(reason), LateSentence)
	}

	// 端到端：那张回执现在配得上了吗。
	if err := tenant.Transact(context.Background(), db, dbTenant, func(tx *sql.Tx) error {
		_, err := tx.Exec(`
			SELECT app.accept_ingress($1::uuid, $2::uuid, 99::bigint, gen_random_uuid(),
			    'SmsStatusReport',
			    '{"kind":"SmsStatusReport","peer":"10086","reference":42,'
			    '"status":"delivered","status_code":0,"delivered_at":1789000000000}'::jsonb)`,
			dbTenant, dbDevice)
		return err
	}); err != nil {
		t.Fatalf("投递回执：%v", err)
	}
	status, _, _ = messageRow(t, db, commandID)
	if status != "delivered" {
		t.Fatalf("回执到了却没能把这一行改成 delivered，status = %q —— "+
			"整条链就是为了这一步", status)
	}
}

// 迟到的**失败**：状态保持 failed，但把设备的原话带出来。
func TestALateFailureKeepsTheStatusAndSaysWhatTheDeviceSaid(t *testing.T) {
	db := openDB(t)
	seedTenant(t, db)
	commandID := seedSend(t, db, "dbtest-late-failure")
	if _, err := db.ExecContext(context.Background(),
		`UPDATE app.commands SET status='accepted', accepted_at=now() WHERE id=$1::uuid`,
		commandID); err != nil {
		t.Fatalf("标记 accepted：%v", err)
	}
	cloudGivesUp(t, db)

	store := SQL{DB: db}
	if err := store.SettleOutbound(context.Background(), dbTenant, commandID,
		"failed", "模组拒绝了这条消息", nil); err != nil {
		t.Fatalf("迟到结算：%v", err)
	}

	status, _, reason := messageRow(t, db, commandID)
	if status != "failed" {
		t.Fatalf("status = %q，期望仍然是 failed", status)
	}
	if reason == nil || *reason != LateFailurePrefix+"模组拒绝了这条消息" {
		t.Fatalf("failure_reason = %q，期望带上设备原话", text(reason))
	}
}

// 🔴 负面对照：设备**自己**结掉的消息，不能被后来的重复结果改写。
//
// 少了这一条，一个「凡是 failed 就改」的实现也能让上面两条变绿，而那会让
// 设备报告的失败被一条重复结果悄悄翻成成功。判据是命令的状态在不在
// (expired, cancelled) 里 —— 和 recordLateResultSQL 同一条。
func TestADuplicateDeviceResultDoesNotRewriteASettledMessage(t *testing.T) {
	db := openDB(t)
	seedTenant(t, db)
	commandID := seedSend(t, db, "dbtest-duplicate")

	store := SQL{DB: db}
	if err := store.SettleOutbound(context.Background(), dbTenant, commandID,
		"failed", "模组拒绝了这条消息", nil); err != nil {
		t.Fatalf("第一次结算：%v", err)
	}
	// 设备自己把命令结成 failed（不是云端判的过期）。
	if _, err := db.ExecContext(context.Background(),
		`UPDATE app.commands SET status='failed' WHERE id=$1::uuid`, commandID); err != nil {
		t.Fatalf("标记命令 failed：%v", err)
	}

	reference := 77
	if err := store.SettleOutbound(context.Background(), dbTenant, commandID,
		"sent", "", &reference); err != nil {
		t.Fatalf("重复结算：%v", err)
	}

	status, got, reason := messageRow(t, db, commandID)
	if status != "failed" {
		t.Fatalf("设备自己报的失败被重复结果翻成了 %q", status)
	}
	if got != nil {
		t.Fatalf("重复结果写进了 provider_reference：%v", got)
	}
	if reason == nil || *reason != "模组拒绝了这条消息" {
		t.Fatalf("设备原话被覆盖成了 %q", text(reason))
	}
}

// text 把一个可能为 nil 的原因读成看得懂的东西。
//
// ⚠️ 直接 %v 打印 *string 会打出地址 —— 一条读不懂的失败信息等于没有信息，
//
//	而这正是失败时唯一能看到的东西。
func text(value *string) string {
	if value == nil {
		return "(没有)"
	}
	return *value
}
