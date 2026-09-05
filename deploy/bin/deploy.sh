#!/usr/bin/env bash
# ============================================================================
# 【云端】/opt/vodoge-cloud/bin/deploy.sh <gateway|console|both>
#
# 把 deploy/ 里已经交叉编译好的产物打成镜像并换上去。**只打包,不编译。**
#
# 存在的理由有两个,都是 2026-08-24 同一天踩出来的:
#
# 1. `docker compose build gateway` 会在这台 2 核 1.6G 的机器上真的开始编 Go。
#    那天 sshd 与 443/444 有 107 分钟不应答(ICMP 还通,TCP 能握手,ssh 报
#    "Connection timed out during banner exchange" —— sshd fork 不出子进程),
#    最后只能从 VPS 控制台硬重启。现在 deploy/Dockerfile.gateway 自己会拒绝,
#    这个脚本则提供那条本来就该走的路。
#
# 2. 恢复时用了 `docker compose up -d --no-build gateway`,**容器仍然跑在旧镜像
#    上,而命令退出 0**。
#
#    当时的解释是「tag 没变,Compose 就不重建」。这个解释在本机实测过,**是错的**
#    (Compose v5.4.0,两行的临时镜像,两种情形都复现过):
#
#      tag 指向了新镜像       up -d --no-build 会重建,加不加 --force-recreate 一样
#      docker build 失败/没跑  tag 还指着旧镜像。不加 = 什么都不做退出 0;
#                             加了 = 把容器重建到**旧镜像**上,照样退出 0
#
#    也就是说 --force-recreate **救不了**真正会咬人的那一种,它只会让这次部署看起来
#    更像成功了。真正的护栏只有一条:**换完之后把容器实际使用的镜像 ID 和刚构建出来
#    的镜像 ID 比一遍**,不等就报错。只看 "Up" 不算数 —— "Up" 正是当时屏幕上的东西。
#
#    --force-recreate 仍然保留:tag 没变时它才能让进程真的重启,而且不花什么代价。
#
# 顺带把产物的 sha256 写进镜像 label,于是「这个容器到底是哪份产物」以后不用猜:
#
#     docker inspect vodoge-cloud-gateway-1 \
#       --format '{{index .Config.Labels "vodoge.artifact.sha256"}}'
# ============================================================================
set -euo pipefail

APP_DIR=${VODOGE_APP_DIR:-/opt/vodoge-cloud}
DEPLOY_DIR="$APP_DIR/deploy"
COMPOSE=(docker compose --env-file "$DEPLOY_DIR/.env" -f "$DEPLOY_DIR/compose.yaml")
READY_TIMEOUT=${READY_TIMEOUT:-120}

log()  { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
die()  { printf '[%s] 错误: %s\n' "$(date '+%F %T')" "$*" >&2; exit 1; }

usage() {
  cat >&2 <<'USAGE'
用法: deploy.sh <gateway|console|admin|both>

先在开发机上产出并 scp 过来,再在这台机器上跑本脚本:

  gateway   deploy/vodoge-gateway      CGO_ENABLED=0 GOOS=linux GOARCH=amd64
  console   deploy/console-dist.tgz    next build 的 standalone 产物
  admin     deploy/admin-dist.tgz      同上,但源码在另一个仓库 vodoge-admin

细节见 deploy/RUNBOOK.md。本脚本不编译任何东西,也不会让 Compose 去编译。
USAGE
  exit 2
}

# --- 产物与镜像的对应关系。加服务就在这里加一行 -----------------------------
artifact_for() {
  case "$1" in
    gateway) echo "vodoge-gateway" ;;
    console) echo "console-dist.tgz" ;;
    admin) echo "admin-dist.tgz" ;;
    *) die "未知服务: $1" ;;
  esac
}

# 就绪判定。gateway 有 compose healthcheck;console 没有,所以直接打它的 HTTP。
#
# console 必须带 Host 头:多租户路由按域名分派,不带头请求 / 会得到 404 ——
# 那是路由正确工作的样子,不是故障。用它当健康判据会得出恰好相反的结论。
ready_check() {
  case "$1" in
    gateway)
      [ "$(docker inspect -f '{{.State.Health.Status}}' vodoge-cloud-gateway-1 2>/dev/null || true)" = healthy ]
      ;;
    console)
      local port code
      port=$(grep -E '^VODOGE_CONSOLE_PORT=' "$DEPLOY_DIR/.env" 2>/dev/null | cut -d= -f2- || true)
      port=${port:-13000}
      code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: a.vodoge.com' \
               "http://127.0.0.1:${port}/login" || true)
      [ "$code" = 200 ]
      ;;
    admin)
      # console 那条必须带 Host 头,因为多租户按域名分派;admin 是单站点,
      # 不带头请求 / 就该是 200。两者的判据不同源自路由方式不同,不是抄漏了。
      local port code
      port=$(grep -E '^VODOGE_ADMIN_PORT=' "$DEPLOY_DIR/.env" 2>/dev/null | cut -d= -f2- || true)
      port=${port:-13100}
      code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/" || true)
      [ "$code" = 200 ]
      ;;
  esac
}

deploy_one() {
  local svc="$1" artifact image container built_id running_id sha
  artifact=$(artifact_for "$svc")
  image="vodoge-cloud-${svc}"
  container="vodoge-cloud-${svc}-1"

  [ -f "$DEPLOY_DIR/Dockerfile.${svc}.prebuilt" ] \
    || die "缺 Dockerfile.${svc}.prebuilt —— 这台机器只走预编译路径"
  [ -e "$DEPLOY_DIR/$artifact" ] \
    || die "缺产物 $DEPLOY_DIR/$artifact —— 先在开发机上构建并 scp 过来(见 RUNBOOK)"

  sha=$(sha256sum "$DEPLOY_DIR/$artifact" | cut -d' ' -f1)
  log "$svc: 产物 $artifact"
  log "$svc:   sha256 $sha"
  log "$svc:   mtime  $(date -r "$DEPLOY_DIR/$artifact" '+%F %T')  大小 $(stat -c%s "$DEPLOY_DIR/$artifact") 字节"

  # 换之前先给现役镜像留一个可回滚的 tag。回滚 = 把这个 tag 重新打成
  # vodoge-cloud-<svc> 然后再跑一次 up -d --no-build --force-recreate。
  running_id=$(docker inspect -f '{{.Image}}' "$container" 2>/dev/null || true)
  if [ -n "$running_id" ]; then
    local rollback="${image}:rollback-$(date '+%Y%m%d-%H%M%S')"
    docker tag "$running_id" "$rollback"
    log "$svc: 现役镜像 ${running_id:7:12} 已另存为 $rollback"
  fi

  log "$svc: 打包镜像(不编译)"
  docker build \
    -f "$DEPLOY_DIR/Dockerfile.${svc}.prebuilt" \
    -t "$image" \
    --label "vodoge.artifact.sha256=$sha" \
    --label "vodoge.deployed.at=$(date -Iseconds)" \
    "$DEPLOY_DIR"

  built_id=$(docker image inspect -f '{{.Id}}' "$image")
  log "$svc: 新镜像 ${built_id:7:12}"

  # --no-build 挡的是编译:不让 Compose 在这台机器上自己构建。
  # --force-recreate 挡的是「tag 没变所以不动」,顺带保证进程真的重启。
  # 两个都不能保证容器换到了新镜像 —— 那件事由下面那段比对来保证。
  log "$svc: up -d --no-build --force-recreate"
  "${COMPOSE[@]}" up -d --no-build --force-recreate "$svc"

  # 这里才是真正的验收。上一次事故就是止步于 "Up"。
  running_id=$(docker inspect -f '{{.Image}}' "$container")
  if [ "$running_id" != "$built_id" ]; then
    die "$svc: 容器跑的是 ${running_id:7:12},不是刚构建的 ${built_id:7:12} —— 没换成功,别当它部署好了"
  fi
  log "$svc: 容器镜像 == 新构建镜像 ${built_id:7:12}"

  log "$svc: 等待就绪(上限 ${READY_TIMEOUT}s)"
  local waited=0
  until ready_check "$svc"; do
    waited=$((waited + 3))
    [ "$waited" -lt "$READY_TIMEOUT" ] || die "$svc: ${READY_TIMEOUT}s 内没就绪,自己看 docker logs $container"
    sleep 3
  done
  log "$svc: 就绪,用时 ${waited}s"
}

[ $# -eq 1 ] || usage
case "$1" in
  gateway|console|admin) deploy_one "$1" ;;
  both) deploy_one gateway; deploy_one console ;;
  *) usage ;;
esac

log "完成。别忘了从外面看一眼: curl -sI https://a.vodoge.com/login"
