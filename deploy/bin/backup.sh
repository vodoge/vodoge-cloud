#!/usr/bin/env bash
# ============================================================================
# 【云端】/opt/vodoge-cloud/bin/backup.sh
# 由 vodoge-backup.timer 每天 03:30(北京时间)触发,也可以手动跑。
# 刻意错开 TREK 的 03:00 —— 同一台 2 vCPU 的机器,两个 dump 撞一起会把
# sshd 饿死,这台机器上已经发生过一次。
#
# 产出两个互不相干的东西,跟 TREK 的备份保持同一套约定:
#
#   /opt/vodoge-cloud/stage/       仅 root 可读。带时间戳的转储,供升级或迁移
#                                  失败时快速回滚。不对外暴露,不进异地备份。
#
#   /srv/vodoge-export/vodoge/     飞牛 NAS 从这里拉。chroot 根目录下只有这
#                                  一个文件夹,因为飞牛的备份任务只能选一个
#                                  根文件夹。
#
# 为什么不能直接拷 postgres 的 data volume:
#   运行中的 PostgreSQL 数据目录里同时有已提交、未提交、正在写的页面和 WAL,
#   文件级拷贝抓到的是若干个不同瞬间的混合体。恢复时可能起不来,更糟的是可能
#   起来了但数据不一致 —— 而这一点在恢复那天之前完全看不出来。
#   pg_dump 走的是一个可重复读快照,产出的是一致的逻辑转储。
#
# 为什么角色要单独备:
#   这个库的租户隔离靠 RLS,而 RLS 策略引用的是具体角色 —— vodoge_resolver
#   必须是 NOLOGIN BYPASSRLS,vodoge_app 必须不是。pg_dump 不含角色定义,
#   只恢复数据库会得到一个策略全部失效的库,而且它照样能启动、照样能查询,
#   只是每个租户都能看到所有人的数据。
# ============================================================================
set -euo pipefail

APP_DIR=/opt/vodoge-cloud
STAGE="$APP_DIR/stage"
EXPORT_ROOT=/srv/vodoge-export     # chroot 根,必须 root:root 且 go-w
PAYLOAD="$EXPORT_ROOT/vodoge"      # 飞牛备份任务里选的那一个文件夹
SFTP_USER=vodogebak
PG_CONTAINER=vodoge-cloud-postgres-1
PG_USER=vodoge
PG_DB=vodoge
KEEP_LOCAL_DAYS=3

# --- 失败上报 --------------------------------------------------------------
# 这个脚本由 timer 触发,没有任何租户上下文,而每条通知都必须发给某一个租户,
# 且这个库里没有任何东西能枚举租户(RLS 是 FORCE 的,连 SECURITY DEFINER 也
# 看不到全部租户)。所以收件人由网关侧的 VODOGE_OPS_TENANT 指定,这里只负责
# 把"失败了、以及为什么"送过去。
#
# 没配 token 就整段跳过 —— 端点在未配置时本来也是 503,静默跳过比每天在日志
# 里留一条上报失败要好。
OPS_URL="http://127.0.0.1:${VODOGE_GATEWAY_PORT:-18080}/v1/ops/backup-failed"
OPS_TOKEN="${VODOGE_OPS_TOKEN:-}"
last_message=""
failed_line=""

log() { last_message="$*"; printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }

report_failure() {
  local code=$1
  [ "$code" -eq 0 ] && return 0
  [ -z "$OPS_TOKEN" ] && return 0

  # 只带内嵌到 JSON 里会出问题的两个字符,用参数展开做,不起外部进程 ——
  # 这段跑在脚本已经失败的路径上,越少依赖越好。
  local reason="${last_message//\\/}"
  reason="${reason//\"/}"
  reason="${reason//$'\n'/ }"

  # 三处显式 exit 不会触发 ERR(ERR 只对命令返回非零生效),所以行号经常是空的。
  # 那三处退出前都有一条 "!!" 日志,原因本来就带着了,行号有就带、没有就不写,
  # 好过打印一个会被当成 bug 的问号。
  local where=""
  [ -n "$failed_line" ] && where="第 $failed_line 行,"

  curl -fsS --max-time 10 -X POST "$OPS_URL" \
    -H 'content-type: application/json' \
    -H "X-VoDoge-Ops-Token: $OPS_TOKEN" \
    --data "{\"detail\":\"备份失败(${where}退出码 $code):$reason\"}" \
    >/dev/null 2>&1 || true
}
trap 'failed_line=$LINENO' ERR
trap 'report_failure $?' EXIT

mkdir -p "$STAGE" "$PAYLOAD/db"
ts=$(date +%Y%m%d-%H%M%S)

# --- 1. 一致性逻辑转储 -----------------------------------------------------
# -Fc 自定义格式:压缩、可被 pg_restore 选择性恢复、且自带校验结构。
log "导出 $PG_DB"
docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" -Fc \
  > "$STAGE/vodoge.dump.tmp"

# 角色单独一份,但抹掉口令散列。
#
# 恢复需要的是角色的【属性和授权】—— vodoge_resolver 必须 BYPASSRLS、
# vodoge_app 必须不是 —— 而不是口令。口令在密码管理器里,跟 .env 一起,
# 恢复时重新设置即可。带走散列换不来任何恢复能力,只是多一样需要保护的
# 东西离开这台机器,跟 TREK 那份备份不带 ENCRYPTION_KEY 是同一个道理。
log "导出角色定义(不含口令)"
docker exec "$PG_CONTAINER" pg_dumpall -U "$PG_USER" --roles-only \
  | sed -E "s/ PASSWORD '[^']*'//" \
  > "$STAGE/roles.sql.tmp"

if grep -q "SCRAM-SHA-256" "$STAGE/roles.sql.tmp"; then
  log "!! 角色文件里仍有口令散列,不外传。检查 pg_dumpall 的输出格式是否变了"
  exit 1
fi

# 立刻自检。备份最怕的不是没备份,是备了一堆坏文件而不自知。
# pg_restore --list 要把整个归档的目录读一遍,一个截断或损坏的转储过不了。
log "校验转储可读"
if ! docker exec -i "$PG_CONTAINER" pg_restore --list > /dev/null < "$STAGE/vodoge.dump.tmp"; then
  log "!! 转储不可读,保留 .tmp 供排查,不覆盖上一份完好备份"
  exit 1
fi

# 空转储也能通过 --list。核对几张必须有内容的表,确认导出的是真的库,
# 而不是一个连错了库、语法上完好的空壳。
tables=$(docker exec -i "$PG_CONTAINER" pg_restore --list < "$STAGE/vodoge.dump.tmp" \
  | grep -c 'TABLE DATA app' || true)
if [ "$tables" -lt 5 ]; then
  log "!! 转储里只有 $tables 张表的数据,像是导错了库。不覆盖上一份"
  exit 1
fi

mv -f "$STAGE/vodoge.dump.tmp" "$STAGE/vodoge.dump"
mv -f "$STAGE/roles.sql.tmp" "$STAGE/roles.sql"

# --- 2. 本地回滚点(仅 root 可读,不外传)----------------------------------
cp -f "$STAGE/vodoge.dump" "$STAGE/vodoge-$ts.dump"
find "$STAGE" -maxdepth 1 -name 'vodoge-*.dump' -mtime "+$KEEP_LOCAL_DAYS" -delete
chmod 700 "$STAGE"
find "$STAGE" -maxdepth 1 -type f -exec chmod 600 {} +

# --- 3. 组装导出内容 -------------------------------------------------------
log "组装 $PAYLOAD"
cp -f "$STAGE/vodoge.dump" "$PAYLOAD/db/vodoge.dump"
cp -f "$STAGE/roles.sql"   "$PAYLOAD/db/roles.sql"
cp -f "$APP_DIR/deploy/compose.yaml" "$PAYLOAD/db/compose.yaml"

# 迁移脚本一起带走。没有它们,一份转储只能恢复到导出当天的 schema,
# 之后要重建一个同版本的库就得回去翻 git —— 而 git 未必是恢复现场能上的。
if [ -d "$APP_DIR/packages/db/migrations" ]; then
  rm -rf "$PAYLOAD/db/migrations"
  cp -a "$APP_DIR/packages/db/migrations" "$PAYLOAD/db/migrations"
fi

# 脱敏后的环境配置:抹掉机密,其余(域名、端口)照抄,恢复时能直接参考。
sed -E 's/^([A-Z_]*(PASSWORD|SECRET|KEY|TOKEN|DSN|URL)[A-Z_]*)=.*/\1=<见密码管理器,不随备份外传>/' \
  "$APP_DIR/deploy/.env" > "$PAYLOAD/db/env.public"

# Redis 不备份。里面只有在线状态和唤醒提示 —— 全都能从 PostgreSQL 和设备
# 重连中重新得到。备份它只会多一份需要保护的东西,换不来任何恢复能力。

# --- 4. 清单 ---------------------------------------------------------------
# 行数的用途:恢复之后先跟这里对一遍,能在【接流量之前】发现恢复的是旧快照
# 或者只恢复了一半 —— 不用等运营发现少了一天的短信才知道。
counts=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAF: -c "
  SELECT 'tenants', count(*) FROM app.tenants
  UNION ALL SELECT 'devices', count(*) FROM app.devices
  UNION ALL SELECT 'modems', count(*) FROM app.modems
  UNION ALL SELECT 'messages', count(*) FROM app.messages
  UNION ALL SELECT 'ingress', count(*) FROM app.ingress
  UNION ALL SELECT 'audit_log', count(*) FROM app.audit_log
  ORDER BY 1" | tr '\n' ' ')

{
  echo "backup_time=$(date -Is)"
  echo "pg_version=$(docker exec "$PG_CONTAINER" postgres --version | awk '{print $3}')"
  echo "dump_sha256=$(sha256sum "$PAYLOAD/db/vodoge.dump" | cut -d' ' -f1)"
  echo "dump_bytes=$(stat -c%s "$PAYLOAD/db/vodoge.dump")"
  echo "roles_sha256=$(sha256sum "$PAYLOAD/db/roles.sql" | cut -d' ' -f1)"
  echo "schema_version=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc \
      "SELECT coalesce(max(version)::text, 'unknown') FROM app.schema_migrations" 2>/dev/null || echo unknown)"
  echo "row_counts=$counts"
} > "$PAYLOAD/db/MANIFEST"

# --- 5. 权限 ---------------------------------------------------------------
# chroot 根目录必须 root 所有且 group/other 不可写,否则 sshd 直接拒绝登录。
chown root:root "$EXPORT_ROOT"
chmod 755 "$EXPORT_ROOT"
chown root:"$SFTP_USER" "$PAYLOAD"
chmod 750 "$PAYLOAD"
chown -R root:"$SFTP_USER" "$PAYLOAD/db"
chmod 750 "$PAYLOAD/db"
find "$PAYLOAD/db" -type d -exec chmod 750 {} +
find "$PAYLOAD/db" -type f -exec chmod 640 {} +

log "完成: $(tr '\n' ' ' < "$PAYLOAD/db/MANIFEST")"
