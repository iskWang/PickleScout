# Backend Code Review — Findings & Next Steps

> Session: 2026-05-13 | Commits: 2103ea6, fc771e6, 4ebf10e

## Completed Fixes (26 bugs across 5 files)

### explorer.ts — 5 fixes (2103ea6)
1. Password not sent during auth (fill action was a no-op)
2. `stagehand.init()` not awaited — race condition on startup
3. Loop guard double-counted `stepNumber` → halved effective exploration depth
4. `screenshotPath` never written to `ActionLogEntry`
5. Click action used wrong selector/text fields from `observe()` result

### redis.ts — 1 fix (fc771e6)
1. **CRITICAL**: `setJobState` called `JSON.stringify(safeLog(state))` — permanently stored `apiKey`/`password` as `"[REDACTED]"`, breaking all downstream LLM calls

### verifier.ts — 6 fixes (fc771e6)
1. Missing `updateJobStatus` import + status never set to `'verifying'`
2. `npx tsc` → `bunx tsc`; missing `reject` param in Promise; missing `proc.on('error')`
3. `npm install` → `bun install`; `npx cucumber-js` → `bunx cucumber-js`; shared `/tmp/cucumber-result.json` across concurrent jobs → hash-scoped + cleanup
4. `attemptSelfHeal` threw for anthropic/gemini (correct) but was silently returning empty array on bad JSON — now throws explicitly

### routes/jobs.ts — 1 fix (fc771e6)
1. DELETE handler only called `job.remove()` — no-op for active jobs. Fixed: mark `failed` in Redis first (cooperative cancel), emit terminal SSE events, then attempt removal

### routes/stream.ts — 4 fixes (fc771e6)
1. Subscribe-before-check race — job could complete between status check and subscribe, leaving client hung forever
2. Orphaned heartbeat interval if connection closed before it started
3. `parseInt(lastEventIdHeader)` without `String()` cast → `NaN` on header objects
4. Double `subscriber.quit()` possible — unified into single `cleanup()` with `closed` guard

### generator.ts — 7 fixes (4ebf10e)
1. No guard for unsupported providers (anthropic/gemini) — now throws
2. Retry caught ALL errors, not just parse errors — non-retryable errors (auth, network) were silently retried
3. Token usage `delta` computed but `cumulative` never persisted to Redis or emitted
4. Empty LLM content silently fell through to guaranteed Zod error instead of explicit throw
5. Empty content never threw — pass1/pass2 both now `throw new Error('LLM returned empty content for Pass N')`
6. **Path traversal**: LLM-controlled `f.filename` written directly to `fs.writeFile` — fixed with `path.basename()`
7. `getCumulativeTokens` used dynamic `await import('../redis')` — redundant, static import already present

---

## Not Yet Reviewed

| File | Notes |
|------|-------|
| `worker/packager.ts` | Packages generated files into zip for download |
| `worker/sse.ts` | SSE publisher; has `_publisher` singleton (no leak) — low risk |
| `worker/index.ts` | BullMQ orchestrator; `AbortSignal` not passed to generator/verifier phases |
| `routes/download.ts` | Serves packaged zip |
| All frontend files | Not reviewed at all |

---

## Open Questions / Things to Confirm

1. **`worker/index.ts` cancellation gap**: `AbortSignal` is only passed to `runExplorer`. If a job is cancelled during `runGenerator` or `runVerifier`, the `status: 'failed'` flag in Redis is set but the running LLM call / cucumber process runs to completion before the job exits. Acceptable?

2. **Self-heal loop bound**: `verifier.ts` has a `MAX_SELF_HEAL_ATTEMPTS` constant — confirm the retry count is intentional and not accidentally infinite.

3. **`/tmp` path for cucumber results**: We scoped to `hash` but `/tmp` is still shared storage. In a containerized environment this is fine; confirm there's no expectation of a per-job temp dir under `STORAGE_DIR`.

4. **`safeLog` dead code**: The `key.endsWith('.fieldName')` path in the JSON.stringify replacer never fires (replacer sees shallow keys only). Not a bug but worth knowing — nested sensitive fields (e.g. `state.llm.apiKey` in an object passed to `safeLog`) are caught by the key === check, so still safe.

5. **Token pricing table in generator.ts**: `estimateCost()` hardcodes 4 models; openrouter routes like `anthropic/claude-sonnet-4-5` will hit the `?? { input: 1, output: 3 }` fallback. Intentional approximation?

6. **End-to-end smoke test**: No integration tests exist for the full pipeline. Before shipping, recommend at minimum a test that runs `explorer → generator → verifier(syntax-only)` against a local static HTML page.
