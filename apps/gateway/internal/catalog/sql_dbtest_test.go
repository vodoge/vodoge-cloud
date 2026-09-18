//go:build dbtest

// 打真库的测试。见 internal/messaging/sql_dbtest_test.go 里那段为什么。
//
// 🔴 这个文件是对抗复审直接点名要的：`ListCommands` 里那条删凭据的 SQL
//
//	（2026-09-18 从 `payload - 'password'` 改成按 `commands.SecretKeys()` 删键）
//	**一条测试都没走过** —— 复审把它退回旧版本，整棵树 32 个包全绿。
//	那条语句是运维在控制台上唯一看得见的命令载荷，也就是唯一必须不带凭据的
//	那一次读。
package catalog

import (
	"context"
	"database/sql"
	"os"
	"strings"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/tenant"
)

const (
	dbTenant = "9d000000-0000-4000-8000-000000000001"
	dbDevice = "9d000000-0000-4000-8000-000000000002"
	// 一个长得像真码的哨兵。出现在返回的载荷里就是泄漏。
	sentinelCode = "1$smdp.example.com$SENTINELLISTCOMMANDS"
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

func seed(t *testing.T, db *sql.DB) {
	t.Helper()
	ctx := context.Background()
	cleanup := func() {
		for _, statement := range []string{
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
		 VALUES ($1::uuid, 'catdbtest', 'catalog db test', 'active', 'cn')`, dbTenant); err != nil {
		t.Fatalf("建租户：%v", err)
	}
	if _, err := db.ExecContext(ctx,
		`INSERT INTO app.devices (id, tenant_id, imei, name, vertical)
		 VALUES ($1::uuid, $2::uuid, '860000000000088', 'catdbtest', 'iot')`,
		dbDevice, dbTenant); err != nil {
		t.Fatalf("建设备：%v", err)
	}
}

// 控制台读命令载荷时，一次性凭据不在里面。
//
// ⚠️ 两个方向都查。只查「码不在」的话，一个把整个 payload 换成 '{}' 的实现也会
//
//	绿 —— 而那样运维就再也看不出这条命令到底干了什么。
func TestListingCommandsDoesNotHandBackAOneTimeCredential(t *testing.T) {
	db := openDB(t)
	seed(t, db)

	err := tenant.Transact(context.Background(), db, dbTenant, func(tx *sql.Tx) error {
		_, err := tx.Exec(`
			SELECT app.enqueue_command($1::uuid, $2::uuid, 'download_esim_profile',
			    jsonb_build_object(
			        'kind', 'DownloadEsimProfile',
			        'modem_imei', '867018069514820',
			        'activation_code', $3::text,
			        'password', 'apn-secret'),
			    'catdbtest-key', now() + interval '10 minutes')`,
			dbTenant, dbDevice, sentinelCode)
		return err
	})
	if err != nil {
		t.Fatalf("入队命令：%v", err)
	}

	store := SQL{DB: db}
	rows, err := store.ListCommands(context.Background(), dbTenant, dbDevice, 10)
	if err != nil {
		t.Fatalf("列命令：%v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("拿到 %d 行，期望 1", len(rows))
	}
	payload := string(rows[0].Payload)

	for _, secret := range []string{sentinelCode, "apn-secret"} {
		if strings.Contains(payload, secret) {
			t.Fatalf("控制台读到的命令载荷里带着凭据：%s", payload)
		}
	}
	// 负面对照：该看见的还看得见。
	if !strings.Contains(payload, "867018069514820") {
		t.Fatalf("载荷被删得什么都不剩了：%s —— 运维就看不出这条命令干了什么", payload)
	}
	if !strings.Contains(payload, "DownloadEsimProfile") {
		t.Fatalf("连 kind 都没了：%s", payload)
	}
}
