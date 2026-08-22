#!/usr/bin/env bash
# ============================================================================
# 【云端】/opt/vodoge-cloud/bin/migrate.sh <迁移文件...>
#
# 应用迁移并把它记进 app.schema_migrations。
#
# 存在的理由:之前迁移是手工 `psql < 文件`,数据库里没有任何记录说哪些跑过。
# 平时靠"列存在不存在"能糊弄过去,唯独在恢复一份转储、需要知道它到哪一版
# 的时候完全没辙 —— 而那正是最不能猜的时刻。
#
# 已经应用过的会跳过。文件内容变了会拒绝并说明,不会默默重跑:改过的迁移
# 配上同一个编号,是普通版本号追踪唯一漏掉的失败模式。
# ============================================================================
set -euo pipefail

PG_CONTAINER=${PG_CONTAINER:-vodoge-cloud-postgres-1}
PG_USER=${PG_USER:-vodoge}
PG_DB=${PG_DB:-vodoge}

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }

# How to reach psql. Defaults to the compose container; CI and a scratch
# database set PSQL_DIRECT=1 to run psql against a host instead. One runner
# either way — a separate code path for CI would test something other than
# what production runs.
psql_run() {
  if [ "${PSQL_DIRECT:-0}" = "1" ]; then
    psql -h "${PGHOST:-localhost}" -U "$PG_USER" -d "$PG_DB" "$@"
  else
    docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" "$@"
  fi
}

psql_q() { psql_run -tAc "$1"; }

if [ $# -eq 0 ]; then
  log "用法: $0 <迁移文件...>"
  exit 2
fi

# The ledger is the runner's own bookkeeping, so the runner creates it.
#
# It cannot live only in a migration: on an empty database the first migration
# runs before any migration has created the table to record it in. 0020 keeps
# a matching CREATE TABLE IF NOT EXISTS for the database that was already
# running before this script existed, and does the historical backfill.
psql_run -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS app;
CREATE TABLE IF NOT EXISTS app.schema_migrations (
    version integer PRIMARY KEY,
    name text NOT NULL,
    sha256 text,
    applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

for file in "$@"; do
  base=$(basename "$file" .sql)
  version=$((10#${base%%_*}))
  sum=$(sha256sum "$file" | cut -d' ' -f1)

  recorded=$(psql_q "SELECT coalesce(sha256, '') FROM app.schema_migrations WHERE version = $version" || true)
  if [ -n "$(psql_q "SELECT 1 FROM app.schema_migrations WHERE version = $version" || true)" ]; then
    if [ -z "$recorded" ] || [ "$recorded" = "$sum" ]; then
      log "跳过 $base(已应用)"
      continue
    fi
    log "!! $base 的内容与应用时不同"
    log "   已记录 $recorded"
    log "   当前   $sum"
    log "   迁移一旦应用就不该再改。要修正请新开一个编号。"
    exit 1
  fi

  log "应用 $base"
  # ON_ERROR_STOP 让任何一条语句失败都中断,而不是继续跑完剩下的、
  # 留下一个应用了一半的迁移。
  psql_run -v ON_ERROR_STOP=1 -q < "$file"

  # 记录发生在应用之后:一个失败的迁移不该留下"已应用"的痕迹。
  psql_q "INSERT INTO app.schema_migrations (version, name, sha256)
          VALUES ($version, '$base', '$sum')
          ON CONFLICT (version) DO UPDATE SET sha256 = EXCLUDED.sha256" > /dev/null
  log "已记录 $base"
done

log "当前 schema 版本: $(psql_q 'SELECT max(version) FROM app.schema_migrations')"
