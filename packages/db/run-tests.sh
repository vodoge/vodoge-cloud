#!/usr/bin/env bash
# 跑 packages/db/tests 下的每一个 .sql。
#
# 🔴 这个脚本此前不存在，那十个测试文件**从来没有被执行过** —— CI 里没有任何
#    一步跑它们，仓库里也没有别的 runner。代价是具体的：0044 那次
#    CREATE OR REPLACE 静默删掉了 accept_ingress 的 SmsStatusReport 分支，
#    从 2026-08-28 到 2026-09-08 每一条投递回执都被写成墓碑丢掉，
#    而三个 accept_ingress 测试一条 SmsStatusReport 都不喂，也没人跑。
#
# ⚠️ 每个测试文件自带 BEGIN/COMMIT，**不回滚**。所以：
#    ① 绝不能指向生产库；
#    ② 每个测试必须各跑在自己的库上。共用一个库时先跑的会把租户和设备行留给
#       后跑的，红绿取决于文件名顺序 —— 那种红灯读起来像测试坏了，其实是隔离
#       没做。用 TEMPLATE 建库几乎不花时间。
#
# 用法（本机）：
#   packages/db/run-tests.sh            # 自己建模板、重放迁移、跑全部
#   PG_BASE=已有模板 packages/db/run-tests.sh --reuse
#
# 需要一个本地 postgres（Ubuntu：apt install postgresql-18）和一个能建库的
# 超级用户角色，默认 vodoge / 口令 ci，和 CI 里那个 postgres:18 service 一致。
set -uo pipefail

HOST=${PGHOST:-127.0.0.1}
PORT=${PGPORT:-5432}
USER=${PG_USER:-vodoge}
BASE=${PG_BASE:-vodoge_db_tests_base}
export PGPASSWORD=${PGPASSWORD:-ci}

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
cd "$root"

# client_min_messages=warning：DROP ... IF EXISTS 的 NOTICE 会把结果淹掉
q() { PGOPTIONS='-c client_min_messages=warning' psql -h "$HOST" -p "$PORT" -U "$USER" -d postgres -v ON_ERROR_STOP=1 -tAc "$1"; }

if [ "${1:-}" != "--reuse" ]; then
  q "DROP DATABASE IF EXISTS $BASE;" >/dev/null
  q "CREATE DATABASE $BASE;" >/dev/null
  psql -h "$HOST" -p "$PORT" -U "$USER" -d "$BASE" -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='vodoge_owner') THEN CREATE ROLE vodoge_owner NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='vodoge_app') THEN CREATE ROLE vodoge_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='vodoge_gateway') THEN CREATE ROLE vodoge_gateway NOLOGIN IN ROLE vodoge_app; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='vodoge_dispatcher') THEN CREATE ROLE vodoge_dispatcher NOLOGIN IN ROLE vodoge_app; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='vodoge_resolver') THEN CREATE ROLE vodoge_resolver NOLOGIN BYPASSRLS; END IF;
END $$;
SQL
  q "GRANT vodoge_owner TO $USER;" >/dev/null
  q "GRANT vodoge_resolver TO $USER;" >/dev/null

  PSQL_DIRECT=1 PGHOST="$HOST" PG_USER="$USER" PG_DB="$BASE" \
    ./deploy/bin/migrate.sh packages/db/migrations/*.sql >/dev/null || {
      echo "迁移重放失败" >&2; exit 1; }

  # ⚠️ 夹具，不是修复。accept_ingress / ingress_window 是 SECURITY DEFINER、
  #    属主 vodoge_owner，它们要读 app.* 和调 app.current_tenant_id()。
  #    生产上这些对象本来就归 vodoge_owner（安装时手工 SET ROLE 建的），而
  #    **迁移里没有任何 SET ROLE**，所以 bin/migrate.sh 单独重放出来的库里
  #    它们归执行者，vodoge_owner 什么都够不着。
  #
  #    也就是说：一次照迁移做的灾难恢复，会得到一个每封设备上行都
  #    「permission denied for table ingress」的库。那是个真问题，需要单独
  #    决定怎么修（补授权？还是让迁移显式设属主？后者会动生产的权限模型），
  #    不该由这里顺手定。这几行只让测试跑得起来。
  psql -h "$HOST" -p "$PORT" -U "$USER" -d "$BASE" -v ON_ERROR_STOP=1 -q <<'SQL'
GRANT USAGE ON SCHEMA app TO vodoge_owner;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO vodoge_owner;
GRANT ALL ON ALL TABLES IN SCHEMA app TO vodoge_owner;
GRANT ALL ON ALL SEQUENCES IN SCHEMA app TO vodoge_owner;
SQL
fi

pass=0; fail=0; failed=()
for f in packages/db/tests/*.sql; do
  name=$(basename "$f" .sql)
  db="dbt_${name}"
  q "DROP DATABASE IF EXISTS $db;" >/dev/null
  q "CREATE DATABASE $db TEMPLATE $BASE;" >/dev/null
  out=$(psql -h "$HOST" -p "$PORT" -U "$USER" -d "$db" -v ON_ERROR_STOP=1 -q -f "$f" 2>&1)
  rc=$?
  q "DROP DATABASE IF EXISTS $db;" >/dev/null
  if [ $rc -eq 0 ]; then
    printf '  ok   %s\n' "$name"; pass=$((pass+1))
  else
    printf '  FAIL %s\n' "$name"
    printf '%s\n' "$out" | grep -E 'ERROR' | head -3 | sed 's/^/       /'
    fail=$((fail+1)); failed+=("$name")
  fi
done

echo "  ${pass} passed / ${fail} failed"
if [ "$fail" -ne 0 ]; then
  echo "failing: ${failed[*]}" >&2
  exit 1
fi
