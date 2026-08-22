#!/usr/bin/env bash
# ============================================================================
# 把契约同步到边缘仓库。
#
# 契约的唯一真源在这个仓库的 packages/contract/。边缘仓库 vendored 了一份
# schema 和 codegen —— 它得能独立构建和跑 CI,不能依赖旁边有没有这个仓库。
#
# 代价是两份会漂移,而且漂移是静默的:我改了这边的 schema、重新生成了边缘的
# Rust,边缘那份 schema 却还是旧的,于是边缘 CI 的"生成物与 schema 一致"
# 拿旧 schema 去比新代码,失败得莫名其妙。已经发生过一次。
#
# 所以同步是一条命令,一次做完三件事:拷 schema、拷 codegen、重新生成三份
# 绑定。分步做就会有人只做一半。
# ============================================================================
set -euo pipefail

CLOUD_DIR=$(cd "$(dirname "$0")/.." && pwd)
EDGE_DIR=${1:-$(cd "$CLOUD_DIR/../vodoge-edge" 2>/dev/null && pwd || true)}

if [ -z "$EDGE_DIR" ] || [ ! -d "$EDGE_DIR/contract" ]; then
  echo "找不到边缘仓库。用法: $0 [边缘仓库路径]" >&2
  exit 2
fi

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }

log "schema  -> $EDGE_DIR/contract/schema/"
cp -f "$CLOUD_DIR/packages/contract/schema/edge-cloud.v1.schema.json" \
      "$EDGE_DIR/contract/schema/edge-cloud.v1.schema.json"

log "codegen -> $EDGE_DIR/contract/codegen/"
cp -f "$CLOUD_DIR/packages/contract/codegen/generate.py" \
      "$EDGE_DIR/contract/codegen/generate.py"

log "重新生成三份绑定"
python3 "$CLOUD_DIR/packages/contract/codegen/generate.py" \
  --schema "$CLOUD_DIR/packages/contract/schema/edge-cloud.v1.schema.json" \
  --go   "$CLOUD_DIR/packages/contract/go/contract.go" \
  --ts   "$CLOUD_DIR/packages/contract/ts/index.ts" \
  --rust "$EDGE_DIR/contract/src/lib.rs"

# 立刻自检:边缘 CI 跑的就是这一条,在这里先跑一遍,免得把失败推给 CI。
log "校验边缘侧生成物与 schema 一致"
python3 "$EDGE_DIR/contract/codegen/generate.py" --check \
  --schema "$EDGE_DIR/contract/schema/edge-cloud.v1.schema.json" \
  --rust "$EDGE_DIR/contract/src/lib.rs"

log "完成"
