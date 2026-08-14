#!/usr/bin/env bash
# dsh-session-import 冒烟测试。
# 用法:
#   BASE_URL=http://127.0.0.1:3080 bash test/smoke.sh          # 只跑无副作用的检查
#   BASE_URL=… SMOKE_IMPORT=1 bash test/smoke.sh              # 追加真实导入 + 删除(会短暂创建会话)
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3080}"
FIXTURES="$(cd "$(dirname "$0")/fixtures" && pwd)"

check() { # check <描述> <实际> <期望包含>
  if printf '%s' "$2" | grep -q "$3"; then
    echo "  ✓ $1"
  else
    echo "  ✗ $1"
    echo "    实际: $(printf '%s' "$2" | head -c 300)"
    exit 1
  fi
}

echo "== 1. status =="
STATUS="$(curl -sf -m 8 "$BASE_URL/session-import/status")"
check "ok" "$STATUS" '"ok":true'
check "persistence 可用" "$STATUS" '"persistence":true'

echo "== 2. analyze 合法样本 =="
GOOD="$(curl -sf -m 30 -X POST --data-binary @"$FIXTURES/good.jsonl" \
  -H 'content-type: application/octet-stream' \
  "$BASE_URL/session-import/analyze?name=good.jsonl")"
check "verdict=ok" "$GOOD" '"verdict":"ok"'
check "含 64 位 sha256" "$GOOD" '"sha256":"[0-9a-f]\{64\}"'

echo "== 3. analyze 被篡改样本(删行→seq 断裂) =="
TAMPERED="$(curl -sf -m 30 -X POST --data-binary @"$FIXTURES/tampered-gap.jsonl" \
  -H 'content-type: application/octet-stream' \
  "$BASE_URL/session-import/analyze?name=tampered-gap.jsonl")"
check "verdict=error" "$TAMPERED" '"verdict":"error"'
check "报 seq 不连续" "$TAMPERED" 'seq 不连续'

echo "== 4. dryRun 预演(不落盘) =="
DRY="$(curl -sf -m 30 -X POST --data-binary @"$FIXTURES/good.jsonl" \
  -H 'content-type: application/octet-stream' \
  "$BASE_URL/session-import/import?name=good.jsonl&workspace=%2Ftmp&restamp=1&dryRun=1")"
check "ok" "$DRY" '"ok":true'
check "dryRun 标记" "$DRY" '"dryRun":true'
check "不返回真实 sessionId" "$DRY" '"sessionId":null'

echo "== 5. 预期指纹强校验(不匹配应 409) =="
CODE="$(curl -s -m 30 -o /dev/null -w '%{http_code}' -X POST --data-binary @"$FIXTURES/good.jsonl" \
  -H 'content-type: application/octet-stream' \
  "$BASE_URL/session-import/import?name=good.jsonl&workspace=%2Ftmp&restamp=1&expectedHash=0000000000000000000000000000000000000000000000000000000000000000&dryRun=1")"
check "HTTP 409" "$CODE" '^409$'

if [ "${SMOKE_IMPORT:-0}" = "1" ]; then
  echo "== 6. 真实导入(open=1)+ 删除 =="
  RESULT="$(curl -sf -m 60 -X POST --data-binary @"$FIXTURES/good.jsonl" \
    -H 'content-type: application/octet-stream' \
    "$BASE_URL/session-import/import?name=good.jsonl&workspace=%2Ftmp&restamp=1&sync=model,preset,permission,sandbox,approval,plan&open=1")"
  check "ok" "$RESULT" '"ok":true'
  check "resumed" "$RESULT" '"resumed":true'
  SID="$(printf '%s' "$RESULT" | sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p')"
  check "拿到 sessionId" "$SID" '^session-'
  echo "  导入会话: $SID"
  DELETED="$(curl -sf -m 30 -X POST "$BASE_URL/session-import/delete?sessionId=$SID")"
  check "删除成功" "$DELETED" '"deleted":true'
  echo "  已删除"
else
  echo "== 6. 跳过真实导入(设置 SMOKE_IMPORT=1 启用) =="
fi

echo
echo "全部通过 ✓"
