package enroll

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// 吊销的幂等保证此前**一处都没有被测到**。
//
// 🔴 `packages/db/tests/certificate_revocation.sql` 看起来在测它，其实不是：那个
//
//	文件自己手写了一条 `UPDATE … WHERE id = … AND revoked_at IS NULL`，于是它
//	证明的只是「Postgres 会遵守测试自己写的那个 WHERE」。把
//	`certificates.go` 里的 `AND revoked_at IS NULL` 删掉，那个 .sql 照样全绿 ——
//	而第一次吊销的时刻会被第二次点击改写，控制台上「这台机器什么时候不再可信」
//	就答错了，审计里还会多出一条重复的 revoke 记录。
//
// ⚠️ 数据库里也没有别的东西兜着：0006 只声明了 `revoked_at timestamptz`，没有触发器、
//
//	没有约束、也没有 app.* 的吊销函数。这条保证**只**活在下面那条 SQL 语句里。
//
// 所以这里用记录型 driver 打的是 `SQLCertificates.Revoke` 本体：它真的发出了哪条
// 语句、语句里有没有那个守卫、以及 `changed` 有没有照着 RowsAffected 走。
func TestRevokePreservesTheFirstRevocationTime(t *testing.T) {
	t.Parallel()

	db, rec := recordingDB(t, true, 1)
	changed, err := SQLCertificates{DB: db}.Revoke(context.Background(), "t-1", "c-1")
	if err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if !changed {
		t.Fatalf("RowsAffected=1 却报 changed=false —— 调用方据此写审计，会漏记一次真的吊销")
	}

	update := rec.find(t, "UPDATE app.device_certificates")
	if !revokeGuard.MatchString(update) {
		t.Errorf(`吊销语句里没有 `+"`AND revoked_at IS NULL`"+` 这个守卫。少了它，第二次点击会把
第一次吊销的时刻覆盖掉 —— 而那个时刻是「这台机器什么时候被判定为不再可信」的唯一记录，
覆盖之后再也答不上来。语句原文：
%s`, update)
	}

	// 租户绑定必须在那条 UPDATE **之前**。这个表上有 FORCE RLS，绑定晚一步等于
	// 这条语句在没有租户上下文的情况下跑。
	bindAt, updateAt := rec.indexOf("set_config"), rec.indexOf("UPDATE app.device_certificates")
	if bindAt == -1 {
		t.Errorf("整个事务里没有 set_config('app.tenant_id', …) —— 这条 UPDATE 没有租户上下文")
	} else if bindAt > updateAt {
		t.Errorf("租户绑定发生在 UPDATE 之后（bind@%d update@%d）", bindAt, updateAt)
	}
}

// 一次没有改动任何行的吊销，必须报 changed=false。
//
// 调用方（cmd/gateway 的 revokeCertificate）**只在 changed 为真时**写审计。所以
// 这一位如果恒为真，重复点击会在审计里堆出一串看起来像多次吊销的记录。
func TestRevokingAnAlreadyRevokedCertificateReportsNoChange(t *testing.T) {
	t.Parallel()

	db, _ := recordingDB(t, true, 0)
	changed, err := SQLCertificates{DB: db}.Revoke(context.Background(), "t-1", "c-1")
	if err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if changed {
		t.Fatalf("RowsAffected=0 却报 changed=true")
	}
}

// 不存在的 id 必须报 ErrCertificateNotFound，而且**不发那条 UPDATE**。
//
// 🔴 缺席 ≠ 空：一个查不到的 id 如果走到「更新了 0 行」那一支，就会被当成
//
//	「这张证书已经被吊销过了」—— 两件完全不同的事读起来一模一样。
func TestRevokingAMissingCertificateSaysSoInsteadOfLookingIdempotent(t *testing.T) {
	t.Parallel()

	db, rec := recordingDB(t, false, 0)
	_, err := SQLCertificates{DB: db}.Revoke(context.Background(), "t-1", "c-1")
	if !errors.Is(err, ErrCertificateNotFound) {
		t.Fatalf("err = %v, want ErrCertificateNotFound", err)
	}
	if rec.indexOf("UPDATE app.device_certificates") != -1 {
		t.Errorf("查不到那张证书却还是发了 UPDATE")
	}
}

// SQL 测试里那条手写的 UPDATE，必须和实现里的那条一致。
//
// 🔴 `packages/db/tests/certificate_revocation.sql` 复制了实现的语句，而一份复制品
//
//	会分家：把实现改了、复制品没改，那个 .sql 仍然绿 —— 它测的是自己那一份。
//	这条断言把复制品钉在源头上，所以改实现会让它变红，改的人才会知道要一起改。
//
// ⚠️ 比对的是**归一化之后的语句**（空白压平、参数占位符统一），不是字节。
//
//	.sql 那边用的是 `v_id` 这类变量而不是 `$1`，那是 plpgsql 的写法差异，
//	不是语义差异。
func TestTheSQLTestsRevokeStatementMatchesTheImplementation(t *testing.T) {
	t.Parallel()

	impl := normalizeUpdate(readRepoFile(t, "apps/gateway/internal/enroll/certificates.go"))
	if len(impl) == 0 {
		t.Fatal("在 certificates.go 里找不到 UPDATE app.device_certificates —— 这条断言在扫空气")
	}
	fromTest := normalizeUpdate(readRepoFile(t, "packages/db/tests/certificate_revocation.sql"))
	if len(fromTest) == 0 {
		t.Fatal("在 certificate_revocation.sql 里找不到 UPDATE app.device_certificates")
	}

	want := impl[0]
	for i, got := range fromTest {
		if got != want {
			t.Errorf(`certificate_revocation.sql 里第 %d 条按 id 的 UPDATE 和实现分家了。
那个文件是实现的复制品，分家之后它测的就只是自己那一份。
实现：  %s
测试：  %s`, i+1, want, got)
		}
	}

	// 🔴 那个文件里还有**第三条** UPDATE，它刻意和实现不一样：
	//
	//      UPDATE app.device_certificates SET revoked_at = now() WHERE revoked_at IS NULL;
	//
	//    没有 `id =`，因为它是跨租户探针 —— 从另一个租户的上下文里试着吊销「看得见
	//    的全部」，然后断言一行都没碰到。把它算进上面那轮比对是错的（我第一版就是
	//    这么写的，于是它红在了一条本该不同的语句上）。
	//
	// ⚠️ 但它也不能就这么不管：它是这个文件里唯一一条租户隔离断言，删掉它文件照样
	//    全绿。所以这里钉住它还在。
	if probeCount := len(tenantProbe.FindAllString(readRepoFile(t, "packages/db/tests/certificate_revocation.sql"), -1)); probeCount != 1 {
		t.Errorf(`certificate_revocation.sql 里的跨租户探针有 %d 条，应当正好 1 条。
那条 UPDATE 刻意不带 id：它从另一个租户的上下文里试着吊销看得见的全部，再断言一行都没碰到。
少了它，这个文件就不再检查租户隔离了，而它仍然会全绿。`, probeCount)
	}
}

var (
	revokeGuard = regexp.MustCompile(`(?is)AND\s+revoked_at\s+IS\s+NULL`)
	// 只认「按 id 吊销一张」的那种 —— 跨租户探针刻意没有 id，它由 tenantProbe 单独钉。
	updateStmt    = regexp.MustCompile(`(?is)UPDATE\s+app\.device_certificates\b[^;` + "`" + `]*?\bid\s*=[^;` + "`" + `]*?revoked_at\s+IS\s+NULL`)
	tenantProbe   = regexp.MustCompile(`(?is)UPDATE\s+app\.device_certificates\s+SET\s+revoked_at\s*=\s*now\(\)\s+WHERE\s+revoked_at\s+IS\s+NULL`)
	placeholderRe = regexp.MustCompile(`\$\d+(::uuid)?|v_id`)
	spaceRe       = regexp.MustCompile(`\s+`)
)

// normalizeUpdate 把一个文件里每一条吊销 UPDATE 压成一行可比对的形式。
func normalizeUpdate(source string) []string {
	var out []string
	for _, raw := range updateStmt.FindAllString(source, -1) {
		s := placeholderRe.ReplaceAllString(raw, "?")
		s = strings.ReplaceAll(s, "clock_timestamp()", "now()")
		out = append(out, spaceRe.ReplaceAllString(strings.TrimSpace(s), " "))
	}
	return out
}

// readRepoFile 从仓库根目录读一个文件。
//
// ⚠️ 往上找 go.mod 再往上一级，而不是写死 "../../../.."：写死的相对路径在测试被
//
//	移动一层目录之后会变成「文件不存在」，而那读起来像仓库少了个文件。
func readRepoFile(t *testing.T, relative string) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.work")); err == nil {
			break
		}
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			break
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("从 %s 往上找不到仓库根", dir)
		}
		dir = parent
	}
	body, err := os.ReadFile(filepath.Join(dir, relative))
	if err != nil {
		t.Fatalf("读 %s: %v", relative, err)
	}
	return string(body)
}

/* ── 记录型 driver ────────────────────────────────────────────────────────
 *
 * 和 internal/commands/lifecycle_test.go 里那个同构，多一个 QueryContext ——
 * `Revoke` 先用 QueryRowContext 做存在性检查，没有 Query 支持它会掉到
 * Prepare 上去。
 *
 * 不打真库：这个仓库没有任何打真库的 Go 测试（main_test.go 里那个 DSN 是故意
 * 不可达的），而 `packages/db/tests/*.sql` 那一套跑在自己的 runner 上。这里要
 * 钉的是「Revoke 发出了什么语句、以及它怎么解释 RowsAffected」，那两件事不需要
 * 一个真的数据库，也就不该为此给 CI 加一个服务。
 */

type recorded struct {
	query string
	args  []driver.NamedValue
}

type recorder struct {
	statements []recorded
	exists     bool
	affected   int64
}

func (r *recorder) find(t *testing.T, needle string) string {
	t.Helper()
	for _, s := range r.statements {
		if strings.Contains(s.query, needle) {
			return s.query
		}
	}
	t.Fatalf("没有任何语句包含 %q。发出去的是：\n%s", needle, strings.Join(r.queries(), "\n---\n"))
	return ""
}

func (r *recorder) indexOf(needle string) int {
	for i, s := range r.statements {
		if strings.Contains(s.query, needle) {
			return i
		}
	}
	return -1
}

func (r *recorder) queries() []string {
	out := make([]string, 0, len(r.statements))
	for _, s := range r.statements {
		out = append(out, s.query)
	}
	return out
}

func recordingDB(t *testing.T, exists bool, affected int64) (*sql.DB, *recorder) {
	t.Helper()
	rec := &recorder{exists: exists, affected: affected}
	db := sql.OpenDB(recConnector{rec: rec})
	t.Cleanup(func() { _ = db.Close() })
	return db, rec
}

type recConnector struct{ rec *recorder }

func (c recConnector) Connect(context.Context) (driver.Conn, error) { return recConn{rec: c.rec}, nil }
func (c recConnector) Driver() driver.Driver                        { return recDriver{} }

type recDriver struct{}

func (recDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("open by DSN is not part of this test")
}

type recConn struct{ rec *recorder }

func (recConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("prepared statements are not part of the revoke path")
}
func (recConn) Close() error                                                 { return nil }
func (recConn) Begin() (driver.Tx, error)                                    { return recTx{}, nil }
func (recConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) { return recTx{}, nil }

func (c recConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	c.rec.statements = append(c.rec.statements, recorded{query: query, args: args})
	if strings.Contains(query, "UPDATE app.device_certificates") {
		return rowsAffected(c.rec.affected), nil
	}
	return rowsAffected(0), nil
}

func (c recConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	c.rec.statements = append(c.rec.statements, recorded{query: query, args: args})
	return &boolRows{value: c.rec.exists}, nil
}

type recTx struct{}

func (recTx) Commit() error   { return nil }
func (recTx) Rollback() error { return nil }

type rowsAffected int64

func (rowsAffected) LastInsertId() (int64, error)   { return 0, errors.New("no insert id") }
func (r rowsAffected) RowsAffected() (int64, error) { return int64(r), nil }

// boolRows 是 EXISTS 检查的那一行。
type boolRows struct {
	value bool
	done  bool
}

func (*boolRows) Columns() []string { return []string{"exists"} }
func (*boolRows) Close() error      { return nil }
func (r *boolRows) Next(dest []driver.Value) error {
	if r.done {
		return io.EOF
	}
	r.done = true
	dest[0] = r.value
	return nil
}
