#!/usr/bin/env bash
# smoke-test.sh — start Docker stack, assert API responds, tear down.
# Usage: ./scripts/smoke-test.sh
set -euo pipefail

API="http://localhost:3000"
COMPOSE_FILE="$(dirname "$0")/../docker-compose.yml"

cleanup() {
  echo "[smoke] tearing down..."
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT

# ── 1. Build & start ──────────────────────────────────────────────────────────
echo "[smoke] building and starting stack..."
docker compose -f "$COMPOSE_FILE" up -d --build

# ── 2. Wait for /health ───────────────────────────────────────────────────────
echo "[smoke] waiting for API health..."
for i in $(seq 1 60); do
  if curl -sf "$API/health" > /dev/null 2>&1; then
    echo "[smoke] API is up (attempt $i)"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "[smoke] TIMEOUT: API did not become healthy in 60s" >&2
    exit 1
  fi
  sleep 1
done

# ── 3. POST /api/jobs ─────────────────────────────────────────────────────────
echo "[smoke] creating test job..."
RESPONSE=$(curl -sf -X POST "$API/api/jobs" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "llm": {
      "provider": "openrouter",
      "apiKey": "smoke-test-placeholder",
      "model": "anthropic/claude-haiku-4.5",
      "baseURL": "https://openrouter.ai/api/v1"
    },
    "options": {
      "maxScenarios": 1,
      "maxSteps": 5,
      "verificationMode": "syntax-only"
    }
  }')

HASH=$(echo "$RESPONSE" | grep -o '"hash":"[^"]*"' | cut -d'"' -f4)
if [ -z "$HASH" ]; then
  echo "[smoke] FAIL: POST /api/jobs did not return a hash. Response: $RESPONSE" >&2
  exit 1
fi
echo "[smoke] job created: hash=$HASH"

# ── 4. GET /api/jobs/:hash ────────────────────────────────────────────────────
echo "[smoke] fetching job state..."
JOB=$(curl -sf "$API/api/jobs/$HASH")
if ! echo "$JOB" | grep -q '"status"'; then
  echo "[smoke] FAIL: GET /api/jobs/$HASH did not return status. Response: $JOB" >&2
  exit 1
fi
echo "[smoke] job state OK: $JOB"

echo ""
echo "[smoke] SMOKE OK ✓"
