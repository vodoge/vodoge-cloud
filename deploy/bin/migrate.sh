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

# --check:只查不改。不建表、不应用、不记账,只把账本和这棵树对一遍。
#
# 🔴 加它的理由是 2026-09-17 在生产上撞到的:账本停在 66,而库实际已经到 71 ——
#    0067 到 0071 五条都是照 README 那段手工 `psql -f` 应用的,而记账只发生在这个
#    脚本里。**灾备恢复读的就是这个账本**来决定重放什么,所以那条路径唯一的输入
#    本身是错的,而且错了很久没人知道。
#
#    同一次还翻出一件更老的:生产记录的 0066 校验和不对应任何一个提交版本 ——
#    那一版是 2026-09-10 事故当天应用的,文件事后被改过。这个脚本一直在查这件事,
#    只是从来没人让它查过生产。
#
# ⚠️ 为什么要一个单独的只读模式:不带 `--check` 跑会**应用**缺的那些迁移。那在
#    确实要升级时是对的,但它不能拿来"顺手看一眼"—— 而"顺手看一眼"正是发现漂移
#    需要的动作。一个会改东西的检查,没有人敢定期跑。
CHECK_ONLY=0
if [ "${1:-}" = "--check" ]; then
  CHECK_ONLY=1
  shift
fi

if [ $# -eq 0 ]; then
  log "用法: $0 [--check] <迁移文件...>"
  log "  --check  只对账不改动:报出未记录的、校验和对不上的、以及账本里有而树里没有的"
  exit 2
fi

# The ledger is the runner's own bookkeeping, so the runner creates it.
#
# It cannot live only in a migration: on an empty database the first migration
# runs before any migration has created the table to record it in. 0020 keeps
# a matching CREATE TABLE IF NOT EXISTS for the database that was already
# running before this script existed, and does the historical backfill.
# ⚠️ `--check` 下不建表。一个"检查"不该在一个空库上悄悄建出 schema 和表来 ——
#    那会把"这个库根本没初始化过"这个答案改写成"它有一张空账本"。
if [ "$CHECK_ONLY" = "0" ]; then
psql_run -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS app;
CREATE TABLE IF NOT EXISTS app.schema_migrations (
    version integer PRIMARY KEY,
    name text NOT NULL,
    sha256 text,
    applied_at timestamptz NOT NULL DEFAULT now()
);
SQL
fi

DRIFT=0
UNVERIFIABLE=0
SEEN_VERSIONS=""

for file in "$@"; do
  base=$(basename "$file" .sql)
  version=$((10#${base%%_*}))
  sum=$(sha256sum "$file" | cut -d' ' -f1)

  recorded=$(psql_q "SELECT coalesce(sha256, '') FROM app.schema_migrations WHERE version = $version" || true)
  if [ -n "$(psql_q "SELECT 1 FROM app.schema_migrations WHERE version = $version" || true)" ]; then
    if [ -z "$recorded" ]; then
      # 账本里有这一行,但没有校验和。
      #
      # 🔴 **应用**时当成"一致"是对的:这一行是这个脚本存在之前记下的（0020 的
      #    历史补录就是这么落的）,拿"没有校验和"去拒绝一次升级毫无道理。
      #
      #    但**对账**时当成"一致"是错的 —— 那是把"查不了"报成"查过了,没问题"。
      #    生产上 71 条账本里有 **37 条**是这个状态（2026-09-18 量的）,也就是说
      #    第一版的 --check 对超过一半的迁移报"对账通过",而它本来就是为了发现
      #    「已应用的迁移被改过」才写的。改一改 0004 再跑 --check,它会说通过。
      #
      #    缺席 ≠ 空。这个仓库到处写着这条,而我在实现一个检查时违反了它。
      SEEN_VERSIONS="$SEEN_VERSIONS,$version"
      if [ "$CHECK_ONLY" = "1" ]; then
        UNVERIFIABLE=$((UNVERIFIABLE + 1))
      else
        log "跳过 $base(已应用)"
      fi
      continue
    fi
    if [ "$recorded" = "$sum" ]; then
      [ "$CHECK_ONLY" = "1" ] || log "跳过 $base(已应用)"
      SEEN_VERSIONS="$SEEN_VERSIONS,$version"
      continue
    fi
    log "!! $base 的内容与应用时不同"
    log "   已记录 $recorded"
    log "   当前   $sum"
    log "   迁移一旦应用就不该再改。要修正请新开一个编号。"
    # ⚠️ `--check` 下继续查完。停在第一处对"应用"是对的（后面的迁移可能依赖
    #    这一条），但对"对账"是错的:运维需要的是一张完整的清单,而不是一次
    #    只看见一个问题、修一个再跑一次。
    if [ "$CHECK_ONLY" = "1" ]; then
      DRIFT=$((DRIFT + 1))
      # 🔴 这一条也要记进 SEEN_VERSIONS。第一版漏了,于是校验和不符的迁移会在
      #    结尾**再被报一次**,说它「已经离开版本库、恢复重放不出来」—— 而那个文件
      #    就在树里,只是内容变了。两条结论互相矛盾,而且 DRIFT 被记了两次。
      #
      #    这正好是 2026-09-17 生产的状态（账本 0066 = cc75eb6f…,树里 be3f4b4f…）:
      #    运维那天要是跑了 --check,会看到一个真问题配一个编造出来的。
      SEEN_VERSIONS="$SEEN_VERSIONS,$version"
      continue
    fi
    exit 1
  fi

  if [ "$CHECK_ONLY" = "1" ]; then
    log "!! $base 没有记录 —— 库里可能应用过它,但账本不知道"
    DRIFT=$((DRIFT + 1))
    continue
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

if [ "$CHECK_ONLY" = "1" ]; then
  # 🔴 第三类漂移,原来完全查不到:**账本里记着、而这棵树里没有那个文件**。
  #
  #    前两类（没记录、校验和不符）都是从文件出发查账本,所以只看得见树里有的
  #    东西。这一类是反过来的 —— 它意味着生产上跑过一条已经不在版本库里的迁移,
  #    而灾备恢复永远重放不出它。这是最安静的一种:每一次重放都"成功",结果却
  #    少了一块。
  ghosts=$(psql_q "SELECT coalesce(string_agg(version || ':' || name, ', ' ORDER BY version), '')
                     FROM app.schema_migrations
                    WHERE version NOT IN (0${SEEN_VERSIONS})")
  if [ -n "$ghosts" ]; then
    log "!! 账本里有这棵树没有的迁移: $ghosts"
    log "   它们在生产上跑过,而一次照这棵树做的恢复重放不出来。"
    DRIFT=$((DRIFT + 1))
  fi

  version=$(psql_q "SELECT coalesce(max(version)::text, '(空)') FROM app.schema_migrations")
  recorded=$(psql_q "SELECT count(*) FROM app.schema_migrations")
  log "账本: $recorded 条,最大版本 $version；这棵树: $# 个文件"
  if [ "$UNVERIFIABLE" -gt 0 ]; then
    # ⚠️ 如实说"有多少条查不了",而不是把它们算进"通过"。
    #    这些行的内容有没有被改过,这个脚本答不上来 —— 而答不上来和答"没问题"
    #    是两件事。
    log "其中 $UNVERIFIABLE 条没有记录校验和,内容是否被改过**无法判断**"
    log "   （这些是本脚本存在之前记下的行；它们会随着重新应用自然获得校验和）"
  fi
  if [ "$DRIFT" -eq 0 ] && [ "$UNVERIFIABLE" -eq 0 ]; then
    log "对账通过:账本和这棵树一致"
    exit 0
  fi
  if [ "$DRIFT" -eq 0 ]; then
    log "没有发现不一致,但有 $UNVERIFIABLE 条查不了（见上）"
    exit 0
  fi
  log "对账发现 $DRIFT 处不一致（见上）"
  exit 1
fi

log "当前 schema 版本: $(psql_q 'SELECT max(version) FROM app.schema_migrations')"
