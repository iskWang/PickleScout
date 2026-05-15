# PickleScout — Implementation Plan & Verification Checklist

> Source of truth for next-step implementation. Designed for agent-driven execution.
> Cross-references: [`docs/PRD.md`](PRD.md) (spec) · [`docs/PROGRESS.md`](PROGRESS.md) (current state)

---

## How to use this checklist

You are an implementation agent (Sonnet, Opus, or similar). Your job:

1. **Read** the next unchecked task `[ ]` top-to-bottom within the current milestone.
2. **Implement** by editing the listed files. Do not exceed the task's stated scope.
3. **Verify** by running EVERY command in the `Verify:` block. ALL must exit `0` / produce expected output.
4. **Mark complete** by editing this file: `[ ]` → `[x]` and updating `docs/PROGRESS.md` accordingly.
5. **Stop** after each task. Do not chain tasks without re-reading the checklist.

### Universal Definition of Done

Before marking ANY task `[x]`, all of these must hold:

```bash
cd backend  && pnpm typecheck && pnpm lint    # backend gates
cd frontend && pnpm typecheck && pnpm lint    # frontend gates
# Plus: every command in the task's Verify: block exits 0
```

If you cannot make the verify commands pass, mark the task `[!]` with a one-line failure reason and stop. Do not move on.

### Hygiene rules (apply globally)

- Never log `apiKey`, `password`, `cookie`, `authorization` — always pass through `safeLog()` first.
- Never break the Stagehand→output isolation: generated artifacts MUST NOT import Stagehand or any LLM SDK.
- Pinned versions in `output/package.json` MUST be exact (no `^` or `~`).
- All Redis keys MUST follow the `job:{hash}` / `events:{hash}` / `bull:*` convention.
- Every Stagehand/Playwright instance MUST close in a `finally` block.

---

## Milestone Z: Test infrastructure (FOUNDATIONAL — do first)

These enable verification for every later task. Skip at your peril — verify steps below assume vitest is installed.

### [x] Z1: Add vitest to backend
- **Goal**: `pnpm test` runs unit tests; CI-friendly exit codes.
- **Files**:
  - Modify `backend/package.json`: add `"test": "vitest run"`, `"test:watch": "vitest"` scripts; add `vitest@^2.1.0` and `@vitest/coverage-v8` to devDependencies.
  - Create `backend/vitest.config.ts` with `test.environment = 'node'`, `test.include = ['src/**/*.test.ts']`.
  - Create `backend/src/utils/safeLog.test.ts` — at least 3 cases (apiKey redacted, nested auth.password redacted, non-sensitive field preserved).
- **Verify**:
  ```bash
  cd backend && pnpm install && pnpm test 2>&1 | grep -E '(PASS|FAIL|passed)'
  cd backend && pnpm test 2>&1 | grep -q 'safeLog' && echo "safeLog tested"
  ```
- **Done when**: at least 3 safeLog tests pass; `pnpm test` exits 0.

### [x] Z2: Add vitest to frontend
- **Goal**: same as Z1 but frontend; jsdom environment for React.
- **Files**:
  - Modify `frontend/package.json`: add `"test": "vitest run"` script; add `vitest@^2.1.0`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom` to devDependencies.
  - Create `frontend/vitest.config.ts` with `test.environment = 'jsdom'`, setup file.
  - Create `frontend/src/components/RecentJobs/RecentJobs.test.tsx` — at least 2 cases (saveRecentJob then loadRecentJobs returns it; removeRecentJob removes by hash).
- **Verify**:
  ```bash
  cd frontend && pnpm install && pnpm test 2>&1 | grep -E '(PASS|FAIL|passed)'
  cd frontend && pnpm test 2>&1 | grep -q 'RecentJobs' && echo "RecentJobs tested"
  ```
- **Done when**: ≥2 RecentJobs tests pass; exit 0.

### [x] Z3: Docker smoke-test script
- **Goal**: one command runs the full Docker stack and asserts the API responds. Replaces manual `docker compose up` + browser clicking.
- **Files**:
  - Create `scripts/smoke-test.sh` (chmod +x). Behavior:
    1. `docker compose up -d --build`
    2. Poll `http://localhost:3000/health` for up to 60s; exit 1 if timeout.
    3. POST a valid `/api/jobs` request with a placeholder LLM key; assert 201 + `hash` present.
    4. GET `/api/jobs/:hash`; assert 200.
    5. `docker compose down -v` on exit (trap).
  - Create `scripts/smoke-test.md` with one line documenting what it does and how to run.
- **Verify**:
  ```bash
  test -x scripts/smoke-test.sh && echo "executable"
  bash -n scripts/smoke-test.sh && echo "syntax ok"
  # Live run (requires Docker; can be deferred to CI):
  # ./scripts/smoke-test.sh && echo "SMOKE OK"
  ```
- **Done when**: script is executable, passes `bash -n`, and the live run succeeds when Docker is available.

---

## Milestone A: pnpm workspace migration (PRIORITY)

> Eliminates the frontend↔backend type drift that has caused several bugs (e.g. JobStatus, StreamEvent, JobOptions defined twice and going out of sync).

### A1: Initialize workspace root
- **Goal**: `pnpm-workspace.yaml` + root `package.json` orchestrate both apps and the shared package.
- **Files**:
  - Create `pnpm-workspace.yaml`:
    ```yaml
    packages:
      - 'frontend'
      - 'backend'
      - 'packages/*'
    ```
  - Create root `package.json`:
    ```json
    {
      "name": "picklescout",
      "private": true,
      "scripts": {
        "typecheck": "pnpm -r typecheck",
        "lint":      "pnpm -r lint",
        "test":      "pnpm -r test",
        "build":     "pnpm -r build",
        "dev:backend":  "pnpm --filter @picklescout/backend  dev",
        "dev:frontend": "pnpm --filter @picklescout/frontend dev"
      },
      "engines": { "node": ">=20", "pnpm": ">=9" },
      "packageManager": "pnpm@9.0.0"
    }
    ```
  - Rename `frontend/package.json` `"name"` → `"@picklescout/frontend"`.
  - Rename `backend/package.json` `"name"` → `"@picklescout/backend"`.
  - Delete `frontend/pnpm-lock.yaml` and `backend/pnpm-lock.yaml`. Run `pnpm install` at repo root to generate a single root lockfile.
- **Verify**:
  ```bash
  test -f pnpm-workspace.yaml && test -f package.json && echo "workspace files ok"
  test -f pnpm-lock.yaml && test ! -f frontend/pnpm-lock.yaml && test ! -f backend/pnpm-lock.yaml && echo "single lockfile"
  pnpm -r typecheck
  pnpm -r lint
  ```
- **Done when**: single root lockfile; `pnpm -r typecheck` exits 0.

### A2: Create `@picklescout/shared` package
- **Goal**: one package owning all types used by BOTH frontend and backend.
- **Files**:
  - Create `packages/shared/package.json`:
    ```json
    {
      "name": "@picklescout/shared",
      "version": "0.1.0",
      "private": true,
      "main": "dist/index.js",
      "types": "dist/index.d.ts",
      "exports": { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } },
      "scripts": {
        "build":     "tsc",
        "typecheck": "tsc --noEmit",
        "lint":      "echo 'shared: no lint'",
        "test":      "echo 'shared: no tests yet'"
      },
      "devDependencies": { "typescript": "^5.5.0" }
    }
    ```
  - Create `packages/shared/tsconfig.json`:
    ```json
    {
      "compilerOptions": {
        "target": "ES2022",
        "module": "ESNext",
        "moduleResolution": "Bundler",
        "outDir": "dist",
        "declaration": true,
        "strict": true,
        "esModuleInterop": true,
        "skipLibCheck": true
      },
      "include": ["src/**/*"]
    }
    ```
  - Create `packages/shared/src/index.ts` — re-exports from `./types`.
- **Verify**:
  ```bash
  cd packages/shared && pnpm build && test -f dist/index.d.ts && echo "shared builds"
  ```
- **Done when**: `pnpm --filter @picklescout/shared build` succeeds and produces `dist/index.d.ts`.

### A3: Extract shared types
- **Goal**: types defined in BOTH `frontend/src/types.ts` AND `backend/src/types.ts` move to `@picklescout/shared`. Frontend and backend re-export or import from shared.
- **Files**:
  - Identify duplicated types between `frontend/src/types.ts` and `backend/src/types.ts` (start with: `JobStatus`, `StreamEvent*`, `JobOptions`, `TokenUsage`, `JobSummary`, `AuthConfig`, `LLMProvider`, `LLMConfig`, `RecentJob`, `VerificationMode`, `CreateJobRequest`, `CreateJobResponse`).
  - Move each into `packages/shared/src/types.ts` (single source).
  - Replace duplicate definitions in `frontend/src/types.ts` and `backend/src/types.ts` with `export * from '@picklescout/shared';` or selective re-exports.
  - Add `"@picklescout/shared": "workspace:*"` to BOTH `frontend/package.json` and `backend/package.json` dependencies.
  - Run `pnpm install` at root.
- **Verify**:
  ```bash
  # No type is defined in two places anymore:
  grep -l "^export interface JobStatus\|^export type JobStatus" frontend/src backend/src -r 2>/dev/null | wc -l    # expect 0
  grep -l "^export interface StreamEvent\b\|^export type StreamEvent\b" frontend/src backend/src -r 2>/dev/null | wc -l  # expect 0
  pnpm -r typecheck
  ```
- **Done when**: every previously-duplicated type lives only in `packages/shared/src/types.ts`; `pnpm -r typecheck` exits 0.

### A4: Update Docker builds for workspace
- **Goal**: `docker compose up --build` still works. Each service builds with the workspace context so it sees `packages/shared`.
- **Files**:
  - Modify `docker-compose.yml`: change `build.context` for both `frontend` and `backend` from `./frontend` / `./backend` to `.` (repo root); add `build.dockerfile: frontend/Dockerfile` (and same for backend).
  - Modify `frontend/Dockerfile`:
    - Copy `pnpm-workspace.yaml`, root `package.json`, `pnpm-lock.yaml`, `frontend/package.json`, `packages/shared/package.json` first (for cache).
    - `RUN pnpm install --frozen-lockfile --filter @picklescout/frontend...` (the `...` includes deps).
    - Then `COPY frontend ./frontend && COPY packages ./packages`.
    - Build with `pnpm --filter @picklescout/frontend build`.
  - Modify `backend/Dockerfile`: same shape; preserve the playwright install + entrypoint additions.
  - Update `.dockerignore` at repo root if it exists; ensure `node_modules/` is excluded.
- **Verify**:
  ```bash
  docker compose build frontend 2>&1 | tail -5 | grep -q "DONE\|FINISHED" && echo "frontend builds"
  docker compose build backend  2>&1 | tail -5 | grep -q "DONE\|FINISHED" && echo "backend builds"
  ./scripts/smoke-test.sh  # full live check
  ```
- **Done when**: both images build; smoke test passes.

### A5: Workspace docs touch-up
- **Goal**: `CLAUDE.md` and AGENTS.md reflect the new layout so future agents don't re-trip the same mistakes.
- **Files**:
  - Modify `CLAUDE.md`: in Commands, replace `cd frontend && pnpm dev` with `pnpm dev:frontend`; same for backend; add note "shared types live in `packages/shared` — modify there, never duplicate".
  - Modify `docs/PROGRESS.md`: mark "pnpm workspace migration" as ✅ in the Phase 2 section.
- **Verify**:
  ```bash
  grep -q "pnpm dev:frontend\|packages/shared" CLAUDE.md && echo "CLAUDE.md updated"
  grep -q "pnpm workspace.*✅\|pnpm workspace.*done" docs/PROGRESS.md && echo "PROGRESS.md updated"
  ```
- **Done when**: both greps print.

---

## Milestone B: Phase 0 E2E validation

> PRD §11 Phase 0 gate. Cannot proceed to Phase 2 work until Phase 0 demonstrates a usable LLM-driven generation result.

### B1: Live smoke run against demo.odoo.com
- **Goal**: one full pipeline pass produces a downloadable ZIP whose `package.json` is valid and `.feature` files parse.
- **Files**:
  - Create `scripts/phase0-validate.sh` (chmod +x). Behavior:
    1. Requires env var `OPENROUTER_API_KEY`.
    2. POST a job with `url=https://demo.odoo.com`, `verificationMode=syntax-only`, `maxSteps=15`, `maxScenarios=3`.
    3. Poll `GET /api/jobs/:hash` every 5s for up to 20 min.
    4. On `completed`: download ZIP, extract to `/tmp/phase0-out`, assert `features/` is non-empty, `steps/` is non-empty, `package.json` has exact-pinned versions (no `^` or `~`).
    5. On `failed`: print last 50 log lines from backend container; exit 1.
- **Verify**:
  ```bash
  test -x scripts/phase0-validate.sh && bash -n scripts/phase0-validate.sh && echo "syntax ok"
  # Live run (requires OPENROUTER_API_KEY):
  # OPENROUTER_API_KEY=sk-... ./scripts/phase0-validate.sh && echo "PHASE 0 PASS"
  ```
- **Done when**: live run produces a ZIP with valid Gherkin + step files.

### B2: Generated artifact runs standalone
- **Goal**: the ZIP from B1, extracted to a clean directory with no Stagehand or LLM env, runs `pnpm install && pnpm test --dry-run` successfully.
- **Files**:
  - Extend `scripts/phase0-validate.sh` with a follow-up step:
    1. `cd /tmp/phase0-out && pnpm install --ignore-scripts`
    2. `pnpm exec cucumber-js --dry-run` (parse-only, no browser)
    3. Assert exit 0.
- **Verify**:
  ```bash
  # Same live run as B1 — both gates run end-to-end
  grep -q "cucumber-js --dry-run" scripts/phase0-validate.sh && echo "B2 added"
  ```
- **Done when**: dry-run in extracted artifact exits 0.

### B3: Concurrency benchmark
- **Goal**: documented `MAX_CONCURRENT_JOBS` value for Mac Mini 16 GB.
- **Files**:
  - Create `docs/BENCHMARKS.md` with: tested concurrency levels (1, 2, 3), peak RAM observed, recommendation.
  - Update `docker-compose.yml`'s default `MAX_CONCURRENT_JOBS` if benchmark suggests something other than 2.
- **Verify**:
  ```bash
  test -f docs/BENCHMARKS.md && grep -q "MAX_CONCURRENT_JOBS" docs/BENCHMARKS.md && echo "documented"
  ```
- **Done when**: file exists with a recommendation backed by measured numbers.

---

## Milestone C: PRD gap closure (open items from PROGRESS.md)

### C1: SSE `error` does not orphan the UI
- **Goal**: when an `error` event fires, the failed view ALWAYS shows the error string. Already fixed in `useJobStream.ts` (error → status: 'failed'); add a test to lock it in.
- **Files**:
  - Create `frontend/src/hooks/useJobStream.test.ts` with a case that feeds a mocked `error` event and asserts `state.status === 'failed' && state.error !== null`.
- **Verify**:
  ```bash
  cd frontend && pnpm test useJobStream 2>&1 | grep -q 'error.*passed\|passed' && echo "ok"
  ```
- **Done when**: test passes; existing fix is locked behind a regression test.

### C2: Rate-limit (429) exponential backoff
- **Goal**: PRD §8.1 — LLM 429 responses trigger 2s/4s/8s retries (up to 3x) before failing the job.
- **Files**:
  - Add a `withRetry()` helper in `backend/src/worker/llm-utils.ts` (new file) that wraps a function returning a promise; on `error.status === 429` or `error.message.includes('rate limit')`, sleeps 2/4/8s and retries up to 3 times.
  - Wrap the OpenAI calls in `backend/src/worker/generator.ts` Pass 1, Pass 2, and `rerunPass2` with `withRetry()`. Also wrap the self-heal call in `verifier.ts`.
  - Emit an SSE `llm_log` event before each retry: `"Rate limited, retrying in {s}s…"`.
- **Verify**:
  ```bash
  grep -q "withRetry" backend/src/worker/generator.ts backend/src/worker/verifier.ts && echo "wired"
  test -f backend/src/worker/llm-utils.test.ts || echo "ADD TEST"  # write a vitest that mocks 429 → 200, asserts 3 attempts then success
  cd backend && pnpm test llm-utils 2>&1 | grep -q passed && echo "ok"
  ```
- **Done when**: backoff fires on 429; test mocks a 429-then-200 flow and asserts retry.

### C3: `@unhealed` tag emission in `.feature` files
- **Goal**: PRD §3.4 — scenarios that fail verification AND can't be healed are kept but tagged `@unhealed` in the Gherkin file. Currently `unhealedScenarios` is COUNTED but the tag is not injected.
- **Files**:
  - In `backend/src/worker/packager.ts` (or wherever the feature files are finalized before packaging): when `verificationPassed === false` and a scenario name appears in the verification errors, prepend `@unhealed` on the line above the `Scenario:` keyword.
  - The matching MUST be scenario-name-aware (parse `Scenario: <name>` from .feature, find the scenario in error output via "Scenario: <name>" substring).
- **Verify**:
  ```bash
  # Unit test: given a .feature with 2 scenarios and an errors[] mentioning only scenario 2, the output has @unhealed only above scenario 2.
  cd backend && pnpm test unhealed 2>&1 | grep -q passed && echo "ok"
  ```
- **Done when**: test passes; `@unhealed` is injected per-scenario, not file-wide.

### C4: Anthropic + Gemini in generator/self-heal
- **Goal**: PRD §3.1 — currently `provider: anthropic|gemini` throws in generator.ts and verifier.ts. Add native client paths.
- **Files**:
  - In `backend/src/worker/generator.ts`: instead of throwing for Anthropic, instantiate `@anthropic-ai/sdk` Anthropic client and call `messages.create()`. For Gemini, use `@google/genai`. Each path must return the same shape (text + tokens) as the OpenAI path.
  - Same in `backend/src/worker/verifier.ts` `attemptSelfHeal()`.
  - Add `@anthropic-ai/sdk` and `@google/genai` to `backend/package.json` dependencies.
  - The structured-output contract is shared: each provider returns JSON matching `FeatureFilesSchema` / `StepFilesSchema`.
- **Verify**:
  ```bash
  # Unit test: mock each SDK to return a fixed JSON; assert provider switch returns parsed content for openai, openrouter, anthropic, gemini, custom.
  cd backend && pnpm test generator-providers 2>&1 | grep -q passed && echo "ok"
  ```
- **Done when**: all 5 providers in the schema (openai, openrouter, anthropic, gemini, custom) round-trip a fixture without throwing.

### C5: TokenMeter UI component
- **Goal**: PRD §7.4 — show running `tokenUsage` in the status bar with $ estimate. Backend already emits `token_usage` events.
- **Files**:
  - Create `frontend/src/components/TokenMeter/index.tsx` — takes `tokenUsage` prop, displays `Tokens: X · Est. cost: ~$Y` (4-decimal).
  - Mount it in `JobStatusBar` (replace or alongside the existing token spot).
  - Add component test asserting it renders 0/0/$0.00 when null and proper values when populated.
- **Verify**:
  ```bash
  test -f frontend/src/components/TokenMeter/index.tsx && echo "created"
  grep -q TokenMeter frontend/src/components/JobStatusBar/index.tsx && echo "mounted"
  cd frontend && pnpm test TokenMeter 2>&1 | grep -q passed && echo "ok"
  ```
- **Done when**: component renders; test passes; visually wired into JobStatusBar.

### C6: Screenshot resize/compress (< 500 KB, ≤ 1920×1080)
- **Goal**: PRD §9 — bound screenshot disk + transfer cost.
- **Files**:
  - Add `sharp` to `backend/package.json` deps.
  - In `backend/src/worker/explorer.ts`, after `page.screenshot()` returns a buffer, pipe through `sharp(buf).resize(1920, 1080, { fit: 'inside' }).jpeg({ quality: 80 })` until the output is ≤ 500 KB (try quality 80, 60, 40 stepping down).
  - Save as `.jpg` (or keep `.png` extension but write JPEG bytes — pick one and stay consistent).
- **Verify**:
  ```bash
  # Unit test: feed a 2000x2000 PNG buffer, assert output ≤ 500 KB AND dimensions ≤ 1920x1080.
  cd backend && pnpm test screenshot 2>&1 | grep -q passed && echo "ok"
  ```
- **Done when**: test passes.

### C7: Output ZIP size guard (10 MB)
- **Goal**: PRD §9 — fail loudly rather than ship a runaway 200 MB ZIP.
- **Files**:
  - In `backend/src/worker/packager.ts`, after writing the ZIP, `fs.stat` it; if size > 10 * 1024 * 1024, fail the job with a clear error and emit SSE error event.
- **Verify**:
  ```bash
  # Unit test: stub a packager that writes a > 10MB file; assert it throws ZipTooLargeError.
  cd backend && pnpm test packager-size 2>&1 | grep -q passed && echo "ok"
  ```
- **Done when**: test passes; behavior verified.

### C8: Hourly orphan-storage sweep
- **Goal**: PRD §5.2 — not just on startup; runs every hour for long-lived deployments.
- **Files**:
  - In `backend/src/index.ts`, `setInterval` calling the same `cleanOrphanStorageDirs()` function every 3600 * 1000 ms, after server starts.
  - Don't re-run `markOrphanJobsFailed` on the interval — that's startup-only.
- **Verify**:
  ```bash
  grep -A2 "setInterval" backend/src/index.ts | grep -q "cleanOrphanStorageDirs\|3600" && echo "wired"
  # Unit test could mock setInterval and assert the callback runs cleanOrphanStorageDirs.
  ```
- **Done when**: code present; tested if practical.

### C9: Screenshot 1-hour delayed cleanup
- **Goal**: PRD §5.2 — screenshots kept 1 hour after job ends (for SSE replay reconnects), then removed.
- **Files**:
  - When a job transitions to `completed` or `failed` (in `worker/index.ts`), schedule a one-shot cleanup of `screenshots/{hash}` 1 hour later. Use a simple `setTimeout`, or push to a delayed bullmq job.
- **Verify**:
  ```bash
  grep -q "setTimeout.*screenshots\|delay.*3_600_000\|delay.*3600000" backend/src/worker/index.ts && echo "wired"
  ```
- **Done when**: code present; ideally with a unit test using fake timers.

---

## Milestone D: Documentation alignment

### D1: Update `.agents/specs/api-contract.md`
- **Goal**: API spec matches actual code (Zod schemas, route paths, response shapes).
- **Files**:
  - Read every file under `backend/src/routes/`. For each endpoint, regenerate or sync the spec entry.
- **Verify**:
  ```bash
  # Manual verification — but at minimum check the file exists and was modified today:
  test -f .agents/specs/api-contract.md && echo "exists"
  ```
- **Done when**: a human-readable diff shows the spec matches code.

### D2: Update `.agents/specs/state-management.md`
- **Goal**: state machine doc matches `worker/index.ts` actual transitions.
- **Files**:
  - Verify every state transition in code is described in the doc and vice versa.
- **Verify**:
  ```bash
  test -f .agents/specs/state-management.md && echo "exists"
  ```
- **Done when**: doc and code agree.

### D3: README quickstart
- **Goal**: a new contributor can clone, run `pnpm install && docker compose up` and have it work.
- **Files**:
  - Create or update `README.md` at repo root with: Quickstart, Architecture overview (link to PRD), Local development commands.
- **Verify**:
  ```bash
  test -f README.md && grep -q "docker compose up\|pnpm install" README.md && echo "ok"
  ```
- **Done when**: README has working commands.

---

## Milestone E: Stabilization & polish (lowest priority)

### E1: Browser console redaction
- **Goal**: even on the frontend, the API key never appears in `console.log`. Today the form holds the apiKey in React state — that's expected — but verify no `console.log(llm)` exists.
- **Verify**:
  ```bash
  grep -rn "console\.log\|console\.error" frontend/src | grep -i "apikey\|password" && echo "FAIL" || echo "ok"
  ```
- **Done when**: grep returns no matches.

### E2: Add `.env.example` at repo root
- **Goal**: list every required env var for local dev.
- **Files**:
  - Create `.env.example` with placeholders for `OPENROUTER_API_KEY` (used by Phase 0 script), backend env vars from PRD Appendix A.
- **Verify**:
  ```bash
  test -f .env.example && grep -q "MAX_CONCURRENT_JOBS\|JOB_TTL_DAYS" .env.example && echo "ok"
  ```
- **Done when**: file exists and is comprehensive.

---

## Out-of-scope (Phase 3 — don't start these without explicit user approval)

These appear in PRD §10.2 but are deliberately deferred:

- Complex auth (OAuth, SSO, MFA, SAML)
- Batch URL processing
- Playwright Test output format
- Observability metrics
- Prompt versioning
- Template-aware generation
- Cypress / Selenium / pytest / other test framework outputs

If a user request implies one of these, surface the trade-off and ask before implementing.

---

## Progress tracking

Each completed task: tick the box `[ ]` → `[x]` AND update `docs/PROGRESS.md` to reflect ✅ next to the related PRD section.

Each blocked task: tick `[!]` and add a one-line reason under the task. Do not silently skip.

The plan is itself a checked-in artifact — update it as new gaps emerge.
