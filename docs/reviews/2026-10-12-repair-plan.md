# 2026-10-12 Review, Fixes, and Bun / SRE Migration Plan

## Scope and status rules

- Review baseline: `af216cf7078117dc8cc389743a347b75656c21e3`; fix branch: `fix/review-runtime-boundaries`.
- The owner asked for a review first, a PR after the serious issues are fixed, and Bun planned together with [issue #2](https://github.com/iskWang/PickleScout/issues/2).
- The owner approved Astra for these high-risk fixes: CORS configuration, the self-heal execution boundary, confirmed secret-leak paths, and the tests/docs they need. Deployment, dependency installation, and data deletion are not approved.
- The owner also asked for a resumable work list before dispatching fixes. This document is the handoff source; the plan is not evidence of completion.
- No formatting-only refactors; no change to the exact Cucumber 11.0.0 / Playwright 1.60.0 versions in generated projects; the Bun migration does not extend to the generated ZIP's runtime.
- Status is one of: pending, in progress, awaiting verification, done, blocked. Done requires real execution evidence and an independent review.

## P1: Fixes in this round

### R1 — REST CORS ignores the Compose frontend origin

- **Evidence:** `docker-compose.yml:26` sets `CORS_ORIGINS=http://localhost:5175`, but the original `packages/backend/src/index.ts:35` only allowed 5173. SSE read the env var itself; REST did not.
- **Reproduced:** injecting OPTIONS into the installed Fastify / @fastify/cors returns ACAO for 5173 but not 5175, so the default Compose UI cannot call REST cross-origin.
- **Fix:** REST uses the exact `CORS_ORIGINS` list. Unset keeps the previous defaults; empty rejects cross-origin; `*` is not accepted. Routes, startup order, and allowed methods are unchanged.
- **Scope:** `packages/backend/src/index.ts`, `index.test.ts`, README configuration notes.
- **Acceptance:** the configured 5175 and multi-origin lists work; unknown origins, spoofed domain suffixes, an empty list, and wildcards get no ACAO; a real route's 400 response still carries correct CORS.
- **Status: awaiting verification.** Implemented by Astra; the parent ran `node node_modules/vitest/vitest.mjs run src/index.test.ts` (backend directory): 16 tests passed. An independent reviewer found no blocking CORS issue.

### R2 — Self-heal accepts model-generated executable files

- **Evidence:** `worker/verifier.ts:345-405` returned the model's JSON `files` directly; `worker/index.ts:191-229` merged them into steps and executed them. Neither new filenames nor code appended to existing files had a trustworthy boundary.
- **Reproduced:** calling the real `validateOutput` and `TEMPLATE_CATALOG` with an extra `extra.ts` containing a harmless environment canary assignment returned `{valid:true,issues:[]}`. The code was not executed, and no remote attack is claimed as proven.
- **Preconditions:** verification fails, retries are allowed, and the model returns content influenced by an untrusted page or provider. Cucumber loads steps in the backend, and child processes inherit the environment.
- **Fix principle:** the model may only supply validated repair data, never executable code. Fixed code applies selector / timeout repairs; a code blocklist or filename-only check is not a security boundary.
- **Contract to resolve first:** PRD §3.4 allows selector and timeout repairs and freezes Gherkin; the project also forbids the self-healer from rewriting template implementations. Data-driven repair must keep the fixed templates and Gherkin intent, and must not quietly turn self-heal into a no-op. If the existing artifact contract cannot support this, list the minimal required change rather than silently disabling the feature.
- **Acceptance:** a normal selector repair changes locator behavior; responses with unknown repair fields, arbitrary code strings, extra files, appended code, removed assertions, or changed scenarios cannot be written or executed; fixed templates, features, the ZIP, and the verification directory stay consistent; a failure still leaves an explainable unverified result. An offline entrypoint smoke test and the failure paths must actually run.
- **Status: awaiting verification (2026-10-15).** Data-driven repair implemented by Astra. Generator-side validation matches the World adapter limits (value ≤300, selector ≤500, XPath detection, duplicate-source key) and is never looser than World. `Promise.withResolvers` replaced with Node 20 compatible code. 25 boundary / truth-table cases run against the real `attemptSelfHeal` and the real World template; all pass.

### R3 — Raw upstream errors and subprocess output may leak secrets

- **Evidence:** `worker/index.ts:269-286` stored the raw `Error.message` in `JobState.error` and sent it over SSE; GET stripped llm/auth but kept `error`. Verifier stdout/stderr also flowed into `llm_log`, verification, and self-heal diagnostics.
- **Limit:** no real provider has been shown to echo a secret; what is confirmed is that the application lacked this output boundary. Do not describe this conditional issue as an actual leak.
- **Fix principle:** handle it at the shared output boundary for persisted errors and SSE, keeping useful but safe diagnostics; fixing a single catch while missing other events is not enough. Known submitted secrets (API key, auth password) and unknown untrusted diagnostics collapse to safe messages; never log raw secrets for debugging.
- **Acceptance:** inject canary API key/password into upstream exceptions and subprocess output; the Redis job error, GET, live SSE, replayed SSE, and logs must contain no canary; normal errors stay recognizable. Cover failure paths such as missing state and read failures so masking does not reintroduce a leak.
- **Status: awaiting verification (2026-10-15).** Shared boundary implemented by Astra: the worker always rethrows a new safe Error (no original message / stack / cause), the BullMQ failed handler passes only safe text, the Redis `error` field is sanitized on both write and read, and the API key / password are kept intact. Parent's independent oracle (canaries `sk-CANARY-7f3a` / `pw-CANARY-91c2`): 3/3 passed.

## P2: Confirmed, but not mixed with unapproved operations

### R4 — syntax-only does not parse Gherkin

- `worker/verifier.ts:78-104` only runs tsc; the preceding step resolution is a line-by-line regex, not a real Gherkin parser. This violates PRD §3.5.
- Fix: use existing Cucumber/Gherkin capabilities to parse without launching a browser; no new packages without approval.
- Acceptance: valid TS + malformed feature must fail; a valid feature passes; Chromium is not launched.
- **Status: pending.** Static evidence was rechecked by an independent reviewer; not yet reproduced by running it.

### R5 — Storage cleanup misses action-logs and only runs at startup

- `worker/explorer.ts` writes `action-logs/{hash}.json`; `startup.ts:72-100` only sweeps screenshots/generated/outputs; the hourly sweep promised by the PRD does not exist.
- Strongly related to #2: after the API / worker split, an API startup must not treat a job the worker is running as orphaned or delete shared files.
- Acceptance: all four kinds of data for expired jobs are cleaned; live and running jobs are fully preserved; multi-role startup does not kill the wrong jobs; errors or races never delete the wrong data.
- **Status: blocked.** It involves shared state and scheduled destructive cleanup; this round's approval explicitly excludes data deletion, so a separately scoped authorization is needed. `/storage` and Redis are not touched for now.

## Non-blocking simplification candidates

- "New Job with Same Config" in `JobDetailPage.tsx` only navigates back to the home page, and a New Job button already sits next to it. Fix the label or remove the duplicate entry; do not claim it can retry the original config.
- The completion screen has two Copy URL buttons; one is enough. Low priority; no UI refactor for this.
- Do not delete data-boundary fallbacks just because TypeScript inference says they are unreachable; browser-stored data may still come from older versions.

## Bun + issue #2: one plan, separate acceptance

1. **Fix R1–R3 first to establish a reproducible baseline.** Bun is not a substitute for security fixes or queue fault handling.
2. **Split API / worker entrypoints and responsibilities.** The queue producer must not be forced to load the browser worker; decide a single recovery / cleanup owner. Restarting the API must not terminate jobs still being processed by the worker.
3. **Switch to Bun in two checkpoints:** workspace / lockfile / build tooling, then service runtime. Compatibility is claimed only after verifying with real Stagehand 3, Playwright 1.60.0, BullMQ 5, ioredis, and child-process abort/cleanup. The existing Node/pnpm contract for the generated ZIP and verifier subprocesses is explicitly preserved unless separately migrated and verified.
4. **Local k3s + Terraform:** Terraform owns the lab environment and bootstrap; Kubernetes owns frontend, API, worker, Redis, Service/Ingress, ConfigMap/Secret, PVCs, resource limits, and probes. The storage path shared by API and worker must actually be reachable; no HA/HPA/service mesh.
5. **Health and metrics:** liveness means the process responds; readiness means the role's required dependencies are ready, avoiding restart storms on brief Redis outages. Prometheus / Grafana separate system from pipeline, derived from existing state/verification/token data rather than a new eval platform. Redis TTLs and the last 50 SSE events are not permanent history; metrics carry no high-cardinality or sensitive labels such as URL, hash, or secrets.
6. **At least three controlled failure drills:** API terminated while the worker continues; worker interrupted / recovered; storage or Redis unavailable. Record UI, Kubernetes behavior, metric/log, whether it recovers automatically, and manual steps. Check off only after a real run.
7. **Keep Compose development;** update the runnable steps in both READMEs. The standalone `video/` is not a root workspace and is not part of the runtime migration unless requested.

**Current status: assessment done; deployment / Bun switch not started.** Locally available: Node v25.8.0, Bun 1.3.14. This does not mean Docker Node 20 or Bun compatibility has passed.

## Verification and delivery checklist

- [x] Read issue #2, current source, and the previous review.
- [x] Read-only scouts traced the pipeline and deployment / frontend separately; an independent reviewer rechecked the candidates.
- [x] Reproduced the default CORS issue and the self-heal checker accepting extra code files.
- [x] R1 scoped entrypoint regression: 16 passed.
- [x] R1 README notes (`CORS_ORIGINS` paragraph added to both READMEs).
- [x] R2 data interface, fixed code boundary, positive / malicious / failure acceptance (unit level; not run against a real Chromium).
- [x] R3 shared output boundary, canary leak acceptance (unit level; external Redis / BullMQ replaced with test doubles).
- [ ] R4 real Gherkin parsing without a browser. (Out of scope for this round.)
- [x] Typecheck / lint / tests for all changes, including the shared build prerequisite: on 2026-10-15, per-package tsc / eslint / vitest all exit 0; final backend 236 passed / 5 skipped, frontend 11 passed (main baseline: backend 134 passed).
- [x] Post-change independent review and integration of all callsites / tests / docs: Terra round 1 PARTIALLY AGREE (the fill_by_label repair source was not the locator actually used; fixed self-heal messages were missing from the `llm_log` allowlist); both fixed with tests, re-review AGREE.
- [x] Commit, push, open PR: commit `b01114d`, [PR #5](https://github.com/iskWang/PickleScout/pull/5); the PR lists what was fixed, not fixed, and not run.

Tool limit: `pnpm --version` was rejected by the bash policy's `pnpm *` rule and must not be bypassed with a wrapper. Direct Node/Vitest runs succeeded. If repo-wide pnpm checks remain blocked, disclose it; do not claim they ran.

## R2 / R3 implementation interfaces (decided by the parent)

### R2: fixed World adapter; the model supplies JSON only

- `attemptSelfHeal(state, artifactDir, errors, signal?)` returns data, not files. The verifier reads the generated `intent-spec.json` to list repairable action locators; the response uses a strict schema.
- Fixed `repair.json`:
  ```json
  {"version":1,"locators":[{"method":"getByRole","value":"Submit","role":"button","selector":"[data-testid=\"submit\"]"}],"actionTimeoutMs":30000}
  ```
- `method` allows only `getByRole`, `getByLabel`, `getByText`; `role` is only for getByRole and must come from the original action. The selector is a data string passed to Playwright's locator and is never interpolated into code; reject XPath, empty strings, overlong strings, unknown fields, duplicate sources, and sources not present in the original intent.
- A getByText source also used by assert_visible / assert_not_visible cannot be remapped, so assertion meaning cannot change. Selector repair is limited to click/fill/select actions. The action timeout is an integer in 30000–45000; navigation, assertion, and Cucumber timeouts are unchanged. This is an explicit safety limit; arbitrary wait strategies or assertion code rewrites are not supported.
- The fixed adapter on `CustomWorld.page` intercepts only those locator methods; all other Page methods are bound to the original page. A matching source becomes the original `page.locator(selector)`; a non-matching call passes through unchanged. The action timeout is applied when the page is assigned; with no repair, behavior is unchanged.
- The packager writes an empty repair plan at initial prepare; each worker round writes only a validated `repair.json` and never rewrites features / steps. The ZIP includes the same `repair.json`; World and verification/ZIP use the same template.
- Invalid model data: show a fixed rejection message, keep the original verification failure and existing unverified packaging; never execute or package any model-supplied code file.

### R3: restrict diagnostic output only; job credentials unchanged

- `safeLog.ts` provides a shared fixed error classification and event diagnostic sanitizer: unknown error / err / stack / cause strings are never sent out; errors return a fixed safe message. Existing sensitive-field redaction is kept.
- `redis.ts` storing / reading the job `error` field, and SSE replay of error / verification.errors / llm_log diagnostics, all go through the same sanitizer; internal `llm.apiKey` / `auth.password` must be stored intact to run the job.
- `sse.ts` buffers and publishes the same safe event; it must never publish the raw unprocessed object. Do not add Redis lookups or a secret cache for masking.
- The worker catch / BullMQ failed handler no longer rethrows or logs raw upstream errors; a fixed safe message still moves the job to failed. The verifier no longer forwards arbitrary stdout/stderr to SSE live; internal repair data and external diagnostics are handled separately.
- This fix does not claim to detect every unknown secret in ordinary page content, screenshots, or the ZIP; that is a separate data-protection topic. The security goal is that raw exceptions and subprocess diagnostics cannot become a leak channel.
