# PickleScout — PRD Implementation Progress

> Last updated: 2026-05-15
> Tracking completion against PRD.md v1.1

Legend: ✅ Done · ⚠️ Partial · ❌ Not started

---

## §2 System Architecture

| Item | Status | Notes |
|------|--------|-------|
| §2.1 Two-phase design (generation vs. execution) | ✅ | Output artifacts contain no Stagehand/LLM imports |
| §2.2 Technology stack | ✅ | React+Vite, Fastify, Stagehand v3, Redis+bullmq — matches PRD |
| §2.3 Container layout (Docker Compose) | ✅ | Redis internal-only (no host port); frontend/backend/redis services |

---

## §3 Functional Requirements

| Item | Status | Notes |
|------|--------|-------|
| §3.1 LLM providers — OpenAI, OpenRouter | ✅ | Fully supported in generator, verifier, self-healer |
| §3.1 LLM providers — Anthropic, Gemini | ⚠️ | Stagehand exploration works; generator + self-healer throw (`provider not supported`) |
| §3.1 LLM providers — Custom | ✅ | Passes through baseURL to OpenAI-compatible client |
| §3.2 Generation flow (explore→pass1→pass2→verify→package) | ✅ | Full pipeline in `worker/index.ts` |
| §3.3 Execution flow (CI/CD GitHub Actions yaml) | ✅ | Packager writes `.github/workflows/e2e.yml` |
| §3.4 Self-healing scope (selector/timeout/wait/assertion only) | ✅ | System prompt enforces allowed changes; scope described in `verifier.ts` |
| §3.5 Verification modes: `syntax-only`, `smoke`, `full` | ✅ | All three modes implemented; `full` retries once on flake |
| §3.6 Flaky test policy (animation CSS, no networkidle) | ✅ | `hooks.ts` boilerplate disables animations; system prompt specifies explicit waits |
| §3.7 Browser isolation (newContext per scenario) | ✅ | Packager's `support/hooks.ts` creates fresh context per Before hook |

---

## §4 API Contract

| Item | Status | Notes |
|------|--------|-------|
| §4.1 POST /api/jobs | ✅ | Zod validation, nanoid(21) hash, BullMQ enqueue |
| §4.1 GET /api/jobs/:hash | ✅ | Credentials stripped from response |
| §4.1 GET /api/jobs/:hash/stream | ✅ | SSE with Last-Event-ID replay, CORS handled manually |
| §4.1 GET /api/jobs/:hash/result | ✅ | Zip download; `?unverified=true` query supported |
| §4.1 DELETE /api/jobs/:hash | ✅ | Cooperative cancellation via Redis status flag |
| §4.2 Request schema (url, hint, auth, llm, options) | ✅ | Full Zod schema with defaults |
| §4.3 URL normalization | ✅ | `urlNormalize.ts` — lowercase, strip fragment, trailing slash, forbidden schemes |
| §4.4 SSE events: status, step, screenshot, llm_log, verification, error | ✅ | All emitted |
| §4.4 SSE events: token_usage | ⚠️ | Event type defined in types; emitted from generator but no UI meter component yet |
| §4.4 SSE events: complete (resultUrl + JobSummary) | ✅ | Emitted by packager at end of successful job |
| §4.4 SSE Last-Event-ID replay | ✅ | `stream.ts` subscribes before replaying; catches race conditions |
| §4.5 Job state machine (queued→exploring→generating→verifying→self_healing→completed/failed) | ✅ | Full transitions in `worker/index.ts` |
| §4.6 ActionLog schema | ✅ | `explorer.ts` persists full ActionLog to `action-logs/{hash}.json` |

---

## §5 Data Storage

| Item | Status | Notes |
|------|--------|-------|
| §5.1 Redis keys: `job:{hash}`, `events:{hash}`, `bull:*` | ✅ | Key prefix convention enforced |
| §5.1 SSE event buffer (last 50, 7-day TTL) | ✅ | `rpush` + `ltrim(-50)` + `expire` in `redis.ts` |
| §5.2 File system layout (screenshots/, action-logs/, outputs/) | ✅ | Created on demand; `generated/` used instead of `outputs/` for intermediate artifacts |
| §5.3 Orphan jobs marked failed on startup | ✅ | `startup.ts` scans `job:*` keys; marks non-terminal as failed |
| §5.3 Orphan storage dirs removed on startup | ✅ | `startup.ts` removes `screenshots/`, `generated/`, `outputs/` dirs without matching Redis key |
| §5.3 Redis not exposed on host port | ✅ | `docker-compose.yml` has no `ports:` on redis service |
| §5.3 safeLog redaction (apiKey, password, cookie, authorization) | ✅ | `utils/safeLog.ts` + enforced in all log call sites |
| Screenshot cleanup 1h after job ends | ❌ | Not implemented; startup sweep only |
| Hourly orphan storage cron | ❌ | Startup sweep only; no recurring cron |

---

## §6 Output Artifact

| Item | Status | Notes |
|------|--------|-------|
| §6.1 File structure (features/, steps/, support/, configs, CI yml) | ✅ | Packager writes all files |
| §6.4 Boilerplate: world.ts, hooks.ts, cucumber.js | ✅ | Embedded in packager |
| §6.4 package.json exact-pinned (no ^/~) | ✅ | `@cucumber/cucumber: 11.0.0`, `@playwright/test: 1.50.0`, etc. |
| §6.4 playwright.config.ts, tsconfig.json, .env.example, README.md | ✅ | All generated |
| §6.5 LLM generation rules (step text, selector priority, assertion rules) | ✅ | System prompt in `generator.ts` Pass 1 + Pass 2 |
| §6.6 Step resolution validation | ✅ | `checkStepResolution()` before verification; `rerunPass2()` on failure |
| `@unhealed` tag on unverified scenarios | ⚠️ | Worker counts unhealed scenarios; packager receives the count but tag injection into .feature files not verified |
| Output zip max size guard (10 MB) | ❌ | No size check after zip creation |
| Screenshot max size (1920×1080, < 500 KB) | ❌ | Screenshots saved as-is; no resize/compress |

---

## §7 Frontend UI

| Item | Status | Notes |
|------|--------|-------|
| §7.1 Routes: `/`, `/jobs/:hash` | ✅ | React Router v6 |
| §7.2 JobFormPage (URL, hint, provider, auth, options) | ✅ | |
| §7.3 JobDetailPage (status bar, action log, screenshots) | ✅ | |
| §7.3 Completed section (download ZIP, copy URL, feature preview) | ✅ | `FeaturePreview` + download button |
| §7.3 Failed section (retry, new job, download anyway) | ✅ | `UnverifiedDownloadModal` |
| §7.4 Components: JobStatusBar, ActionLogPanel, ScreenshotGallery, FeaturePreview | ✅ | |
| §7.4 Components: ProviderSelector, AuthPanel, OptionsPanel, RecentJobs, UnverifiedDownloadModal | ✅ | |
| §7.4 TokenMeter (live token + cost display) | ⚠️ | Component not present as separate file; token data flows via SSE but no dedicated UI meter |
| §7.5 localStorage recent jobs (max 20) | ✅ | `RecentJobs` component |
| §4.4 SSE `VITE_API_URL` build-time bake-in | ✅ | Dockerfile ARG + ENV; docker-compose `build.args` |

---

## §8 Error Handling

| Item | Status | Notes |
|------|--------|-------|
| §8.1 Frontend URL validation | ✅ | `isValidUrl()` blocks submit |
| §8.1 LLM API key invalid (401) | ✅ | Caught, job → failed, error emitted via SSE |
| §8.1 Rate limit (429) exponential backoff (3×) | ❌ | Not implemented; 429 causes immediate job failure |
| §8.1 Generation parse failure retry (once) | ✅ | Generator retries Pass 1 / Pass 2 on ZodError |
| §8.1 Step resolution failure → regenerate Pass 2 once | ✅ | `checkStepResolution()` + `rerunPass2()` |
| §8.2 SSE reconnection with Last-Event-ID | ✅ | Native EventSource + server-side replay |
| §8.3 Log redaction | ✅ | `safeLog()` + REDACT_FIELDS |

---

## §9 Non-Functional Requirements

| Item | Status | Notes |
|------|--------|-------|
| Max job duration (20 min) | ✅ | `JOB_MAX_DURATION_SEC=1200` + AbortController |
| Page load timeout (30 s) | ✅ | `PAGE_TIMEOUT_SEC=30` env var (Stagehand uses it) |
| LLM call timeout (60 s) | ✅ | `LLM_CALL_TIMEOUT_SEC=60` → OpenAI `timeout` option |
| Max agent steps (30, configurable 1-50) | ✅ | `maxSteps` in JobOptions |
| Max scenarios (10, configurable 1-10) | ✅ | `maxScenarios` in JobOptions |
| Concurrent jobs (`MAX_CONCURRENT_JOBS`, default 2) | ✅ | BullMQ worker concurrency |
| Redis TTL 7 days | ✅ | `JOB_TTL_DAYS=7` |
| SSE event buffer (last 50) | ✅ | |
| Frontend recent jobs (localStorage, max 20) | ✅ | |
| Log redaction fields | ✅ | |
| Screenshot max size (1920×1080, < 500 KB) | ❌ | Not implemented |
| Output zip max size (10 MB) | ❌ | Not implemented |
| Screenshot cleanup (1h after job ends) | ❌ | Not implemented |

---

## §11 Development Plan

### Phase 0: Spike and Validation
- [x] Stagehand + OpenRouter on local Docker Compose
- [ ] Full E2E run against `demo.odoo.com` (in progress — runtime bugs fixed, awaiting clean run)
- [ ] Benchmark concurrent Chromium instances on Mac Mini 16 GB
- [ ] Validate two-pass generation produces executable Cucumber + Playwright

### Phase 1: MVP
- [x] Backend: Node.js + Stagehand + Redis + bullmq
- [x] Frontend: form + job detail page
- [x] SSE wiring with Last-Event-ID replay
- [x] Cucumber artifact + zip download
- [x] OpenAI + OpenRouter providers
- [x] Optional form-based auth
- [x] Verification modes (syntax-only, smoke)
- [x] URL normalization + step-definition compile validation
- [x] Docker Compose deployment

### Phase 2: Stabilization
- [x] Full self-healing loop (scope-restricted)
- [x] `full` verification mode
- [x] Recent jobs + Download Anyway
- [ ] Rate limit exponential backoff (429)
- [ ] Anthropic and Gemini in generator (currently throw)
- [ ] Live token-usage display (TokenMeter UI component)
- [ ] Complete error-handling coverage

### Phase 3 (as needed)
- [ ] Complex auth (beyond form-based)
- [ ] Batch URL processing
- [ ] Playwright Test output format
- [ ] Observability metrics
- [ ] Prompt versioning
- [ ] Template-aware generation

---

## Open Gaps (prioritized)

| Priority | Gap | PRD ref |
|----------|-----|---------|
| High | Anthropic + Gemini native support in generator | §3.1 |
| High | Rate limit 429 exponential backoff | §8.1 |
| Medium | TokenMeter UI component (token_usage SSE event exists) | §7.4 |
| Medium | `@unhealed` tag written into .feature files | §3.4 |
| Low | Screenshot resize/compress (< 500 KB) | §9 |
| Low | Output zip size guard (10 MB) | §9 |
| Low | Screenshot cleanup cron (1h after job ends) | §5.2 |
| Low | Recurring hourly orphan storage sweep (beyond startup) | §5.2 |

---

## Test Infrastructure (Milestone Z — Done)

| Item | Status | Notes |
|------|--------|-------|
| vitest in backend | ✅ | 5 safeLog tests pass; `pnpm test` exits 0 |
| vitest in frontend | ✅ | 5 RecentJobs tests (jsdom); `pnpm test` exits 0 |
| frontend `.eslintrc.json` | ✅ | Was missing; added with react-hooks plugin |
| Docker smoke-test script | ✅ | `scripts/smoke-test.sh` — syntax-valid, executable; live run requires Docker |

## Codex Review Fixes (2026-05-15)

| Item | Status | Notes |
|------|--------|-------|
| P1: credential leak in validation log | ✅ | `jobs.ts:74` now wraps body in `safeLog()` before logging |
| P2: Playwright version mismatch in Dockerfile | ✅ | Changed `playwright@1.52.0` → `1.60.0` to match lockfile |

## pnpm Workspace / Monorepo (Planned — Milestone A)

Goal: unify frontend + backend dependency management to prevent version drift (e.g. zod, @fastify/* incompatibility).

Deferred until after Phase 0 E2E validation.
