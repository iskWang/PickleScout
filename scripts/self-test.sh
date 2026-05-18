#!/usr/bin/env bash
# self-test.sh — end-to-end pipeline self-test for Claude/agents.
#
# Two modes:
#   smoke     — happy-path test against example.com. Pass = terminal status, zip downloadable.
#   negative  — auth-walled site (demo.opencart.com/admin). Pass = terminal status AND
#               hallucinationRisk flag set (proves the empty-exploration guard fired).
#
# Reuses LLM config (provider/model/apiKey/baseURL) from the most recent Redis
# job state so agents don't need to know credentials.
#
# Usage:
#   ./scripts/self-test.sh                                    # smoke @ example.com
#   ./scripts/self-test.sh smoke                              # explicit smoke
#   ./scripts/self-test.sh smoke <url> [maxScenarios]
#   ./scripts/self-test.sh negative                           # negative @ opencart admin
#   ./scripts/self-test.sh negative <url> [maxScenarios]
#   ./scripts/self-test.sh all                                # run both modes sequentially
#
# Requires: docker, jq, curl, unzip. Backend + Redis must already be running.
set -euo pipefail

API="${API:-http://localhost:3000}"
TIMEOUT_SEC="${TIMEOUT_SEC:-900}"
POLL_INTERVAL=3
OUT_DIR="$(dirname "$0")/../.self-test-output"
mkdir -p "$OUT_DIR"

# ── Mode parsing ──────────────────────────────────────────────────────────────
MODE="${1:-smoke}"
case "$MODE" in
  smoke)    DEFAULT_URL="https://the-internet.herokuapp.com/" ;;
  negative) DEFAULT_URL="https://demo.opencart.com/admin" ;;
  all)      ;; # handled below
  *)
    echo "[self-test] ERROR: unknown mode '$MODE' (expected: smoke | negative | all)" >&2
    exit 2
    ;;
esac

# ── 'all' fan-out ─────────────────────────────────────────────────────────────
if [ "$MODE" = "all" ]; then
  SCRIPT="$(realpath "$0")"
  echo "[self-test] running mode=smoke …"
  "$SCRIPT" smoke
  echo
  echo "[self-test] running mode=negative …"
  "$SCRIPT" negative
  exit $?
fi

URL="${2:-$DEFAULT_URL}"
MAX_SCENARIOS="${3:-3}"

echo "[self-test:$MODE] target=$URL maxScenarios=$MAX_SCENARIOS"

# ── 1. Health check ───────────────────────────────────────────────────────────
echo "[self-test:$MODE] backend health check…"
if ! curl -sf "$API/health" > /dev/null; then
  echo "[self-test:$MODE] FAIL: $API/health not reachable. Start the stack first." >&2
  exit 1
fi

# ── 2. Pull LLM config from last Redis state ──────────────────────────────────
echo "[self-test:$MODE] looking up most recent job's LLM config from Redis…"
LAST_KEY=$(docker exec picklescout-redis-1 redis-cli --raw KEYS 'job:*' | head -1 || true)
if [ -z "$LAST_KEY" ]; then
  echo "[self-test:$MODE] FAIL: no job:* keys in Redis. Submit one job via the UI first so the LLM config gets cached." >&2
  exit 1
fi
LLM_JSON=$(docker exec picklescout-redis-1 redis-cli --raw GET "$LAST_KEY" | jq -c '.llm')
echo "[self-test:$MODE] reusing config: $(echo "$LLM_JSON" | jq -c '{provider, model}')"

# ── 3. Submit job ─────────────────────────────────────────────────────────────
echo "[self-test:$MODE] POST /api/jobs …"
BODY=$(jq -nc \
  --arg url "$URL" \
  --argjson llm "$LLM_JSON" \
  --argjson maxScenarios "$MAX_SCENARIOS" \
  '{
    url: $url,
    llm: $llm,
    options: { maxScenarios: $maxScenarios, maxSteps: 20, verificationMode: "smoke", maxRetries: 1 }
  }')

CREATE=$(curl -sf -X POST "$API/api/jobs" -H "Content-Type: application/json" -d "$BODY")
HASH=$(echo "$CREATE" | jq -r '.hash')
if [ -z "$HASH" ] || [ "$HASH" = "null" ]; then
  echo "[self-test:$MODE] FAIL: no hash returned. Response: $CREATE" >&2
  exit 1
fi
echo "[self-test:$MODE] job created: hash=$HASH"
echo "$HASH" > "$OUT_DIR/last-hash-$MODE.txt"

# ── 4. Poll until terminal ────────────────────────────────────────────────────
START=$(date +%s)
LAST_STATUS=""
while true; do
  NOW=$(date +%s)
  if [ $((NOW - START)) -gt "$TIMEOUT_SEC" ]; then
    echo "[self-test:$MODE] TIMEOUT after ${TIMEOUT_SEC}s" >&2
    break
  fi
  STATE=$(curl -sf "$API/api/jobs/$HASH" || echo '{}')
  STATUS=$(echo "$STATE" | jq -r '.status // "unknown"')
  if [ "$STATUS" != "$LAST_STATUS" ]; then
    echo "[self-test:$MODE] status: $STATUS"
    LAST_STATUS="$STATUS"
  fi
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then
    break
  fi
  sleep "$POLL_INTERVAL"
done

# ── 5. Capture final state ────────────────────────────────────────────────────
FINAL=$(curl -sf "$API/api/jobs/$HASH")
echo "$FINAL" > "$OUT_DIR/final-state-$HASH.json"
FINAL_STATUS=$(echo "$FINAL" | jq -r '.status')
FINAL_ERROR=$(echo "$FINAL" | jq -r '.error // empty')
HALLUCINATION_RISK=$(echo "$FINAL" | jq -r '.hallucinationRisk // false')
HALLUCINATION_REASON=$(echo "$FINAL" | jq -r '.hallucinationReason // empty')

echo "[self-test:$MODE] final status: $FINAL_STATUS"
[ -n "$FINAL_ERROR" ] && echo "[self-test:$MODE] job error: $FINAL_ERROR"
echo "[self-test:$MODE] hallucinationRisk: $HALLUCINATION_RISK${HALLUCINATION_REASON:+ ($HALLUCINATION_REASON)}"

# ── 6. Download zip ───────────────────────────────────────────────────────────
ZIP_PATH="$OUT_DIR/result-$HASH.zip"
HTTP=$(curl -s -o "$ZIP_PATH" -w '%{http_code}' "$API/api/jobs/$HASH/result")
if [ "$HTTP" = "200" ]; then
  echo "[self-test:$MODE] downloaded zip → $ZIP_PATH ($(du -h "$ZIP_PATH" | cut -f1))"
  ZIP_OK=1
else
  rm -f "$ZIP_PATH"
  echo "[self-test:$MODE] no zip available (HTTP $HTTP)"
  ZIP_OK=0
fi

# ── 7. Mode-specific assertions ───────────────────────────────────────────────
PASS=1
FAIL_REASONS=()

assert() {
  local cond="$1"; local msg="$2"
  if eval "$cond"; then
    echo "[self-test:$MODE]   ✓ $msg"
  else
    echo "[self-test:$MODE]   ✗ $msg" >&2
    PASS=0
    FAIL_REASONS+=("$msg")
  fi
}

# Zip structural check (smoke mode): the zip must contain the expected file tree
ZIP_HAS_EXPECTED=0
if [ "$ZIP_OK" = "1" ]; then
  ZIP_LISTING=$(unzip -l "$ZIP_PATH" 2>/dev/null || true)
  if echo "$ZIP_LISTING" | grep -qE 'features/.*\.feature' \
     && echo "$ZIP_LISTING" | grep -qE 'steps/.*\.steps\.ts' \
     && echo "$ZIP_LISTING" | grep -qE 'support/(world|hooks)\.ts' \
     && echo "$ZIP_LISTING" | grep -q 'package.json'; then
    ZIP_HAS_EXPECTED=1
  fi
fi

echo "[self-test:$MODE] assertions:"
case "$MODE" in
  smoke)
    assert '[ "$FINAL_STATUS" = "completed" ] || [ "$FINAL_STATUS" = "failed" ]' "status reached terminal (got: $FINAL_STATUS)"
    assert '[ "$ZIP_OK" = "1" ]' "zip downloaded successfully"
    assert '[ "$ZIP_HAS_EXPECTED" = "1" ]' "zip contains expected files (features/, steps/, support/, package.json)"
    if [ "$HALLUCINATION_RISK" = "true" ]; then
      echo "[self-test:$MODE]   ⚠ hallucinationRisk fired — exploration captured no interactive entries on smoke target (not a hard fail, but exploration quality is degraded)"
    fi
    ;;
  negative)
    assert '[ "$FINAL_STATUS" = "completed" ] || [ "$FINAL_STATUS" = "failed" ]' "status reached terminal (got: $FINAL_STATUS)"
    assert '[ "$HALLUCINATION_RISK" = "true" ]' "hallucinationRisk IS set (negative expects empty exploration)"
    assert '[ -n "$HALLUCINATION_REASON" ]' "hallucinationReason is populated"
    ;;
esac

# ── 8. Log tail ───────────────────────────────────────────────────────────────
echo "[self-test:$MODE] last 15 backend log lines for $HASH:"
docker compose logs --tail=400 backend 2>&1 | grep -E "$HASH|hallucinat|error|Error|Worker job" | tail -15 | sed 's/^/  /'

# ── 9. Verdict ────────────────────────────────────────────────────────────────
if [ "$PASS" = "1" ]; then
  echo "[self-test:$MODE] ✅ PASS — hash=$HASH"
  exit 0
else
  echo "[self-test:$MODE] ❌ FAIL (${#FAIL_REASONS[@]} assertion(s) failed) — hash=$HASH" >&2
  exit 1
fi
