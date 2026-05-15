#!/usr/bin/env bash
# phase0-validate.sh — Phase 0 E2E gate for PickleScout.
#
# Submits a real job against demo.odoo.com, waits for completion,
# validates the ZIP artifact, then runs cucumber-js --dry-run inside it.
#
# Usage:
#   OPENROUTER_API_KEY=sk-... ./scripts/phase0-validate.sh
#
# Optional env vars:
#   API_BASE      (default: http://localhost:3000)
#   TARGET_URL    (default: https://demo.odoo.com)
#   MAX_WAIT_SEC  (default: 1200 — 20 minutes)
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3000}"
TARGET_URL="${TARGET_URL:-https://demo.odoo.com}"
MAX_WAIT_SEC="${MAX_WAIT_SEC:-1200}"
OUT_ZIP="/tmp/phase0-out.zip"
OUT_DIR="/tmp/phase0-out"

# ── Guard ─────────────────────────────────────────────────────────────────────
if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "[phase0] ERROR: OPENROUTER_API_KEY is required" >&2
  exit 1
fi

# ── 1. Submit job ─────────────────────────────────────────────────────────────
echo "[phase0] submitting job → $TARGET_URL"
RESPONSE=$(curl -sf -X POST "$API_BASE/api/jobs" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"$TARGET_URL\",
    \"hint\": \"focus on login and basic navigation\",
    \"llm\": {
      \"provider\": \"openrouter\",
      \"apiKey\": \"$OPENROUTER_API_KEY\",
      \"model\": \"anthropic/claude-haiku-4-5\",
      \"baseURL\": \"https://openrouter.ai/api/v1\"
    },
    \"options\": {
      \"maxScenarios\": 3,
      \"maxSteps\": 15,
      \"verificationMode\": \"syntax-only\"
    }
  }")

HASH=$(echo "$RESPONSE" | grep -o '"hash":"[^"]*"' | cut -d'"' -f4)
if [ -z "$HASH" ]; then
  echo "[phase0] FAIL: could not extract hash from response: $RESPONSE" >&2
  exit 1
fi
echo "[phase0] job created: hash=$HASH"

# ── 2. Poll until terminal status ─────────────────────────────────────────────
echo "[phase0] polling for up to ${MAX_WAIT_SEC}s..."
ELAPSED=0
POLL_INTERVAL=5
STATUS=""

while [ "$ELAPSED" -lt "$MAX_WAIT_SEC" ]; do
  JOB=$(curl -sf "$API_BASE/api/jobs/$HASH" || echo '{}')
  STATUS=$(echo "$JOB" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)

  case "$STATUS" in
    completed)
      echo "[phase0] job completed after ${ELAPSED}s"
      break
      ;;
    failed)
      echo "[phase0] FAIL: job failed after ${ELAPSED}s" >&2
      echo "[phase0] last 50 backend log lines:" >&2
      docker compose logs --tail=50 backend 2>/dev/null || true
      exit 1
      ;;
    *)
      echo "[phase0] status=$STATUS (${ELAPSED}s elapsed)"
      sleep "$POLL_INTERVAL"
      ELAPSED=$((ELAPSED + POLL_INTERVAL))
      ;;
  esac
done

if [ "$STATUS" != "completed" ]; then
  echo "[phase0] TIMEOUT after ${MAX_WAIT_SEC}s — last status: $STATUS" >&2
  docker compose logs --tail=50 backend 2>/dev/null || true
  exit 1
fi

# ── 3. Download and extract ZIP ───────────────────────────────────────────────
echo "[phase0] downloading artifact..."
rm -rf "$OUT_DIR" "$OUT_ZIP"
curl -sf "$API_BASE/api/jobs/$HASH/result" -o "$OUT_ZIP"
mkdir -p "$OUT_DIR"
unzip -q "$OUT_ZIP" -d "$OUT_DIR"
echo "[phase0] extracted to $OUT_DIR"

# ── 4. Assert artifact structure ──────────────────────────────────────────────
echo "[phase0] asserting artifact structure..."

# features/ must be non-empty
FEATURE_COUNT=$(find "$OUT_DIR" -name "*.feature" | wc -l | tr -d ' ')
if [ "$FEATURE_COUNT" -eq 0 ]; then
  echo "[phase0] FAIL: no .feature files found in artifact" >&2
  ls -la "$OUT_DIR" >&2
  exit 1
fi
echo "[phase0] found $FEATURE_COUNT .feature file(s)"

# steps/ must be non-empty
STEP_COUNT=$(find "$OUT_DIR" -name "*.steps.ts" -o -name "*.steps.js" | wc -l | tr -d ' ')
if [ "$STEP_COUNT" -eq 0 ]; then
  echo "[phase0] FAIL: no step definition files found in artifact" >&2
  find "$OUT_DIR" -type f >&2
  exit 1
fi
echo "[phase0] found $STEP_COUNT step file(s)"

# package.json must exist and have no ^ or ~ version prefixes
PKG_JSON="$OUT_DIR/package.json"
if [ ! -f "$PKG_JSON" ]; then
  echo "[phase0] FAIL: package.json not found in artifact" >&2
  exit 1
fi
if grep -qE '"[~^][0-9]' "$PKG_JSON"; then
  echo "[phase0] FAIL: package.json contains unpinned versions (^ or ~):" >&2
  grep -E '"[~^][0-9]' "$PKG_JSON" >&2
  exit 1
fi
echo "[phase0] package.json versions are exactly pinned"

# ── 5. B2: standalone dry-run (no Stagehand, no LLM) ─────────────────────────
echo "[phase0] running cucumber-js --dry-run inside artifact..."
cd "$OUT_DIR"

# Install deps in isolation — no scripts to avoid playwright binary download
pnpm install --ignore-scripts 2>&1 | tail -5

# Dry-run: parse-only, exercises step resolution without a browser
pnpm exec cucumber-js --dry-run
echo "[phase0] cucumber-js --dry-run: PASS"

echo ""
echo "[phase0] ✓ PHASE 0 PASS — artifact is valid and step-resolvable"
