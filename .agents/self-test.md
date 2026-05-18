# Self-Test — Agent Pipeline Smoke + Negative

Lets an agent verify the full job lifecycle without asking a human to click anything.

**Two modes:**

| Mode | Default URL | What it proves |
|------|-------------|---------------|
| `smoke` | `https://the-internet.herokuapp.com/` | Happy path: submission → exploration (with real interactive elements) → generation → verification → packaging → zip download |
| `negative` | `https://demo.opencart.com/admin` | Hallucination guard: when exploration captures no interactive entries (auth wall, captcha, anti-bot), the pipeline still terminates AND sets `hallucinationRisk: true` instead of silently shipping LLM-hallucinated tests |

## When to run

- After modifying any worker file (`packages/backend/src/worker/*.ts`), the verifier, packager, or templates → run `smoke`.
- After modifying the exploration guard, generator, or anything that could affect hallucination detection → run `negative`.
- After rebuilding the backend Docker image, run `all` to confirm no regression in either path.
- Any time the assistant suspects an "environment-related" failure — run this **before** asking the user for a new manual job.

## Prerequisites

1. Stack already running: `docker compose up -d`
2. At least one prior job must exist in Redis so the script can reuse its LLM config (apiKey + provider + model). If Redis is empty, ask the user to submit one real job from the UI to seed the credentials.

## Usage

```bash
./scripts/self-test.sh                                  # smoke @ example.com (default)
./scripts/self-test.sh smoke                            # explicit smoke
./scripts/self-test.sh negative                         # negative @ opencart admin
./scripts/self-test.sh all                              # smoke then negative
./scripts/self-test.sh smoke <url> <maxScenarios>       # custom smoke target
./scripts/self-test.sh negative <url> <maxScenarios>    # custom negative target
TIMEOUT_SEC=1200 ./scripts/self-test.sh                 # extend wall-clock cap
```

Outputs land in `.self-test-output/`:
- `last-hash-<mode>.txt` — most recent job hash for that mode
- `final-state-<hash>.json` — terminal redis state (no apiKey)
- `result-<hash>.zip` — verified or unverified output zip (when available)

## What "PASS" means

**smoke mode** — pipeline plumbing check, all three must be true:
1. Final status reached terminal (`completed` or `failed`)
2. Zip downloaded successfully (HTTP 200 on `/api/jobs/:hash/result`)
3. Zip contains the expected file tree: `features/*.feature`, `steps/*.steps.ts`, `support/world.ts` + `hooks.ts`, `package.json`

`hallucinationRisk` is REPORTED in smoke output but NOT asserted. Smoke targets external sites; if Stagehand's LLM is weak (e.g. gemini-flash-lite) it may not extract interactive elements even on rich pages. That's an exploration-quality issue separate from pipeline plumbing.

**negative mode** — hallucination safety-net check, all three must be true:
1. Final status reached terminal (`failed` is expected here)
2. `hallucinationRisk === true` in the final state
3. `hallucinationReason` is populated with a human-readable reason

The script prints `✅ PASS` or `❌ FAIL (N assertion(s) failed)` and exits 0/1 accordingly — so it can be wired into CI or invoked from another script.

## Common failure modes (and where to look)

| Symptom | Likely cause | File to check |
|---|---|---|
| `ENOENT: ... dist/templates/*.template` | tsc didn't copy templates | `packages/backend/package.json` build script |
| `pnpm install failed (exit 1): ERR_PNPM_NO_MATCHING_VERSION` | Pinned version doesn't exist on npm | `packages/backend/src/worker/packager.ts` `PINNED_PACKAGE_JSON` |
| `browserType.launch: Executable doesn't exist` | `PLAYWRIGHT_BROWSERS_PATH` override pointing to empty dir | `packages/backend/src/worker/verifier.ts` spawn env |
| `ENOENT: ... steps/features/step_definitions/*.ts` | LLM returned a filename with sub-path; writer didn't `path.basename` | `packages/backend/src/worker/index.ts` self-heal write loop |
| `Result file not found` on download | Route handler didn't fallback between `result.zip` ↔ `result_unverified.zip` | `packages/backend/src/routes/result.ts` |
| `Step resolution failed after Pass 2 retry: Ambiguous` | Same step pattern declared in both `common.steps.ts` and a feature-specific file | `packages/backend/src/worker/generator.ts` — Pass 2 is split into 2a (common) + 2b (feature-specific given actual common content); if still failing, check 2b prompt |
| `Step resolution failed after Pass 2 retry: Unresolved` | Pass 2 generates step patterns that don't match Pass 1 step texts (wrong word: "button" vs "link", reversed word order, different phrasing) | `packages/backend/src/worker/generator.ts` — `extractRequiredStepCoverage` derives required patterns from feature files; Pass 2b prompt includes them as must-implement list; `injectMissingStubs` adds pending stubs as final safety net |
| smoke PASS but negative FAIL `hallucinationRisk is not true` | Exploration guard not firing — actionLog has stray entries even on auth-walled site | `packages/backend/src/worker/index.ts` exploration-completion block (filter on `e.type !== 'goto' && 'wait'`) |
| negative PASS but tests are clearly wrong | Hallucinated tests aren't blocking, they're flagged — that's by design. Frontend should surface the flag visibly | `packages/frontend/` job-detail page |

## Iterative debug pattern

1. Run `./scripts/self-test.sh all`
2. Read the assertion output and log tail
3. Match the symptom to the table above (or `docker compose logs backend | grep -B2 -A5 "Worker job failed"` for raw context)
4. Edit the responsible file
5. `docker compose build backend && docker compose up -d backend`
6. Re-run self-test

Repeat until both modes print `✅ PASS`.

## Adding a new test scenario

To add a new mode (e.g., `auth-form` for a site with a known login that exploration SHOULD pass):

1. Add the mode name to the `case "$MODE"` block in `scripts/self-test.sh`
2. Add its default URL
3. Add an assertion block under `Mode-specific assertions` describing what "pass" means
4. Add the mode to the `all` fan-out section
5. Update the table in this file
