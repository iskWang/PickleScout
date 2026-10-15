# PRD — SRE Lab: Bun, k3s, Terraform, Observability, and Pipeline Metrics

- Source: [issue #2](https://github.com/iskWang/PickleScout/issues/2), plus the 2026-10-15 owner request "switch pnpm to Bun".
- Prerequisite doc: `docs/reviews/2026-10-12-repair-plan.md` (R1–R5, the "Bun + issue #2" section).
- Status: **v2.3, ready for implementation.** Reviewed three rounds by Astra (codex-architect): v1, v2.1, and v2.2 were all PARTIALLY AGREE; round 3 left only 2 wording fixes, applied in v2.3. DNS, port 6443 reachability, and a real apply are proven by the T acceptance checks. This document is a requirement, not evidence of completion.

## 1. Goals

Turn PickleScout into a local SRE lab for practicing "deploy, observe, break, diagnose, recover":

1. Switch the package manager from pnpm to Bun.
2. Build a single-node k3s on the Mac mini with Terraform.
3. Run frontend, API, worker, Redis, and storage as separate pieces on k3s.
4. Prometheus + Grafana must answer: **is the problem infrastructure, or the AI generation pipeline?**

Learning-oriented, not a production rewrite. The Docker Compose development flow must keep working.

## 2. Current state (verified)

| Area | Current state | Evidence |
|---|---|---|
| Services | Compose has only `frontend`, `backend`, `redis` | `docker-compose.yml:1-53` |
| API / worker | One process; `index.ts` always calls `startWorker()` and the reconciler before listen; no role switch | `backend/src/index.ts:51-61` |
| Import coupling | `routes/jobs.ts` imports the queue from the worker module; the worker module statically imports explorer / generator / verifier | `routes/jobs.ts:9`, `worker/index.ts:15-18` |
| Startup recovery | On startup, marks **every** non-terminal job (including not-yet-started `queued`) as `failed` | `backend/src/startup.ts:36-63` |
| Reconciler | Only checks whether the BullMQ job exists; skips if it does, ignores active / failed / stalled | `backend/src/reconciler.ts:34-42` |
| Other terminators | `GET /api/jobs/:hash` repairs to failed on its own; `DELETE` cancels on its own | `routes/jobs.ts:139-143,167-178` |
| State writes | `updateJobStatus()` is read-then-write-back, not an atomic transition | `backend/src/redis.ts:67-86` |
| SSE IDs | Incremented in a per-process in-memory Map; reset when the worker starts a job | `worker/sse.ts:22-35`, `worker/index.ts:82` |
| Shutdown | No SIGTERM handler, no `worker.close()` | `index.ts`, `worker/index.ts:39-76` |
| Queue | BullMQ 5.51.1 queue `generation`, `attempts: 1`, `removeOnFail: false`; no stalled options set, so defaults apply: `maxStalledCount: 1`, `lockDuration` / `stalledInterval` 30 s → **a stalled job is re-queued once** | `worker/index.ts:28-35`, `bullmq/dist/cjs/classes/worker.js:49` |
| Re-entry | `processJob()` only skips terminal jobs; a non-terminal job re-entering will explore again | `worker/index.ts:81-92` |
| Duplicate failure handling | The same exception goes through the `processJob` catch and then the BullMQ failed handler | `worker/index.ts:47-51,245-249` |
| Health | Only `GET /health`, always returns ok | `index.ts:47-48` |
| Metrics | No Prometheus / `prom-client` in backend deps or source | `backend/package.json:14-31` |
| Storage | Worker writes screenshots / action-logs / generated / outputs; API reads screenshots and the result zip → **they must share a volume** | `routes/result.ts:35-46`, `routes/screenshots.ts:10-16` |
| Chromium | Runs inside the worker; Compose sets `shm_size: 2gb`, but explorer launches with `--disable-dev-shm-usage` | `docker-compose.yml:21`, `worker/explorer.ts:60` |
| Failure reason | Only free-text `JobState.error` | `backend/src/types.ts:30-34` |
| Self-heal count | No structured counter field; the count only appears in `llm_log` text events | `worker/index.ts:176-180` |
| Tokens | Generator accumulates `tokenUsage`; self-heal LLM calls are **not** accumulated | `generator.ts:341-363`, `verifier.ts:537-560` |
| Verification runs | `full` mode may run Cucumber twice but returns a single result | `verifier.ts:123-131` |
| Frontend API base | Build-time `VITE_API_URL`; an empty string means relative `/api` | `frontend/src/lib/api.ts:1-3` |
| SSE heartbeat | 25 s | `routes/stream.ts:116-119` |
| pnpm coupling | Root scripts, `engines.pnpm`, `packageManager`, both Dockerfiles (including `pnpm dlx playwright`), verifier child processes `pnpm install` / `pnpm exec`, operator docs | `package.json:4-13`, `backend/Dockerfile:3-28`, `verifier.ts:65,86,138` |
| pnpm kept on purpose | The CI template inside the generated ZIP and its contract test | `docs/PRD.md:200-204`, `packager.test.ts:118` |
| Local tools | `kubectl`, `docker`, OrbStack present; no `terraform` / `tofu` / `helm` | 2026-10-15 `command -v` |
| OrbStack | No machines yet; built-in k8s disabled; `orb create` supports `--cpus` / `--memory` / `--disk` / `-c` cloud-init; **all machines and Docker share a `memory_mib: 8192` cap** | 2026-10-15 `orb list`, `orb create --help`, `orb config show` |

## 3. Scope

### 3.1 In scope

| ID | Requirement |
|---|---|
| B | pnpm → Bun (package manager and workspace; runtime unchanged) |
| S | API / worker role split, termination semantics, recovery, and shutdown |
| M | `/metrics`: system metrics + pipeline metrics |
| T | Terraform: lab machine, k3s, monitoring platform |
| K | Kubernetes application resources (Kustomize) |
| G | Grafana dashboard (System / Pipeline sections) |
| F | Failure drills and write-ups |
| D | Docs: Terraform vs Kubernetes boundary, runbook |

### 3.2 Non-goals

- Multi-node / HA, cloud architecture, service mesh, HPA, or any autoscaling.
- Replacing BullMQ / Redis; rewriting PickleScout around Kubernetes.
- A separate eval platform or a permanent job-history database.
- Exactly-once metrics across process crashes (see M6).
- Switching the service runtime from Node to Bun.
- Changing the **generated ZIP** contract: exact Cucumber 11.0.0 / Playwright 1.60.0 versions, the ZIP README, the CI template inside the ZIP.
- `video/` and historical docs under `docs/reviews/`.

### 3.3 Prerequisites

- Repair plan R1–R3 are finished and merged first, as the baseline. The `fix/review-runtime-boundaries` branch still has uncommitted changes.
- R5 (storage cleanup) is currently blocked; S changes its assumptions. This PRD does not authorize deleting data.

## 4. Requirements

### B — pnpm → Bun

- B1: Root uses `package.json` `workspaces`; `bun.lock` replaces `pnpm-lock.yaml` / `pnpm-workspace.yaml`; remove `engines.pnpm` and `packageManager: pnpm`. No dual setup.
- B2: Root scripts use Bun workspace filters; `typecheck` / `lint` / `test` / `build` / `dev:*` names stay the same. Keep **shared builds first** and the same dependency selection — not a string replace.
- B3: Dockerfile install / build stages use `bun install --frozen-lockfile`. The backend's `pnpm dlx playwright@1.60.0 install chromium --with-deps` becomes an equivalent Node-run command, same version.
- B4: Service runtime stays Node 20. Node tools launched by the Bun script runner (tsc, vitest, eslint, vite) also keep running on Node.
- B5: The verifier's commands in the generated directory switch to `npm`, matching the ZIP README. Must keep: `--ignore-scripts`, timeout, `AbortSignal`, `cwd`; running `cucumber-js` / `tsc` must not download a missing tool on the fly.
- B6: Update operator commands in AGENTS.md, both READMEs, and `.agents/*`.

Acceptance:
- `bun install --frozen-lockfile` installs cleanly.
- `bun run typecheck`, `lint`, `test` all pass; test count is not below the M0 baseline.
- Resolved dependency versions are diffed before/after; every difference is explained.
- Both images build; `docker compose up` completes one real job.
- The verifier passes one real `smoke` run; one abort terminates its child processes.
- Executable `pnpm` commands (scripts, Dockerfiles, in-code spawns, command blocks in operator docs) appear only in the §3.2 exemptions; prose describing the migration does not count.

### S — API / worker split and termination semantics

- S1: One image; `PICKLESCOUT_ROLE=api|worker|all` decides what starts. Default `all`, so Compose behavior is unchanged.
- S2: The `api` role is only a queue producer. Move the queue definition into a module that does not import explorer / generator / verifier / Stagehand; the `api` process must not load those modules.
- S3: **Interrupted work does not resume.** An interrupted active job always fails and never re-enters the pipeline:
  - Worker sets `maxStalledCount: 0`. Installed BullMQ 5.51.1 defaults to 1 (`worker.js:49`), meaning a stalled job is **re-queued once**; the check is `stalledCount > maxStalledCount` (`moveStalledJobsToWait-9.lua:81`), so only 0 fails it on the first stall.
  - **Atomic claim.** The only condition for a worker to accept a job is a successful atomic `queued → exploring` transition; on failure, drop that BullMQ job without running it.
  - Remove the "mark every non-terminal job failed on startup" sweep. Jobs still waiting in BullMQ (not yet claimed) survive a restart of any role. A job BullMQ has already made active, but whose JobState had not completed the atomic claim when the worker was killed, fails via `maxStalledCount: 0` and does not explore.
- S4: **Atomic state updates.** Every JobState write (including non-terminal updates such as phase, progress, tokenUsage) is atomic on the Redis side and **must not overwrite a state that is already terminal**; the current read-then-write-back (`redis.ts:67-86`) must go. Among the paths that write a terminal state (worker complete / fail, BullMQ failed handler, reconciler, `GET` repair, `DELETE` cancel), only the first to succeed emits the SSE terminal event, writes `reason`, and counts metrics. No new `JobState` fields.
- S5: The reconciler runs once in the `api` or `all` role (one such process per deployment). Condition: JobState is non-terminal, and the BullMQ job is missing **or** already failed. Reason rules: BullMQ failed because stalled → `worker_restart`; BullMQ job missing → `queue_lost`; any other failure → `unknown`. The worker failed handler uses the same rules, so the result is the same whoever terminates first.
- S6: SSE events:
  - The ID counter key is `events:{hash}:seq`, not under the `job:` prefix (the reconciler scans `job:*` and would mistake it for a JobState, `reconciler.ts:31-35`). AGENTS.md's key rule already has the existing exceptions `events:{hash}` and `sse:events:{hash}`; this key joins them and is documented in AGENTS.md.
  - "Increment ID, append to buffer, trim to 50, publish" happens in one atomic Redis operation, so order matches IDs.
  - The seq key and `events:{hash}` share the same TTL and are refreshed together on every write.
  - `StreamEvent` schema unchanged.
- S7: When self-heal starts, atomically write JobState status `self_healing` (an existing `JobStatus` value; no schema change). Today only an SSE event is sent (`verifier.ts:500`). This lets cancellations or failures be attributed to the right phase.
- S8: SIGTERM order:
  - worker: (1) stop taking new jobs, while BullMQ lock renewal **keeps running**; (2) wait up to 60 s for the current job (D2) and exit normally if it finishes; (3) on timeout, **first** atomically terminate it as `failed` / `worker_restart`, **then** send abort; (4) kill the verifier child-process tree by process group and force-close Chromium, each step with a timeout; (5) close the BullMQ worker and Redis connection, then exit. If Redis is unavailable, skip (3) and go straight to (4)(5); S5 handles it afterwards.
  - api: stop accepting new requests, close long-lived SSE connections (clients reconnect), then exit.
  - Limit: worker `terminationGracePeriodSeconds: 90` (60 s grace + 30 s cleanup); Compose backend sets `stop_grace_period: 90s`.
- S9: `/health` (liveness) only means the process is alive; it checks no dependencies. `/ready` (readiness) checks the role's required dependencies (API: Redis, with a query timeout). A Redis outage must not fail liveness.
- S10: The worker opens an internal HTTP port used only for probes and metrics.

**State and metric ownership table**

| Scenario | Who writes terminal | Result / `reason` | Who counts the metric | Preconditions |
|---|---|---|---|---|
| Normal completion | worker | `completed` | worker | — |
| Pipeline failure | worker (catch or failed handler, whichever is first) | `failed` / classified reason | same | — |
| SIGTERM, finishes within grace | worker | `completed` | worker | — |
| SIGTERM, exceeds grace | the shutting-down worker | `failed` / `worker_restart` | same | Redis available |
| SIGKILL / OOM | first of: worker failed handler, or API reconciler | `failed` / `worker_restart` (per S5 rules) | same | Redis available; **a worker must be running** (stalled checks run only in the worker, `worker.js:648-675`). The API can only win the race after BullMQ has already marked it failed |
| User cancel | API (`DELETE`) | `failed` / `cancelled` | API | — |
| BullMQ record lost | API (reconciler or `GET` repair) | `failed` / `queue_lost` | API | — |
| Redis outage | Nobody can write; after recovery, rules above apply | — | — | `/ready` is false during the outage |

Acceptance (on both Compose and k3s):
1. Restart the API: an in-flight job completes; `queued` jobs survive and are processed later.
2. SIGTERM the worker: the job finishes within grace.
3. SIGTERM the worker, job exceeds grace → `failed` / `worker_restart`; no leftover Chromium processes.
4. SIGKILL the worker → within N seconds after a new worker starts, the job becomes `failed` / `worker_restart` and never re-enters `exploring`. N is measured and documented, with its preconditions: the new worker's stalled check is running and Redis is available. BullMQ defaults are a reference only, not a guaranteed bound.
5. Worker and `DELETE` terminate the same job concurrently: exactly one terminal event and one metric count.
6. Send a non-terminal update after termination (simulating a late progress write): state stays terminal.
7. The same BullMQ job handed to two workers: only one claim succeeds. Also, kill the worker while BullMQ has the job active but JobState is still `queued`: the job becomes `failed` / `worker_restart` and never enters `exploring`.
8. Hold an SSE connection across a worker restart: event IDs increase monotonically and `Last-Event-ID` replay is correct; under concurrent writes, ID order in the buffer matches publish order.

### M — Metrics

- M1: Use `prom-client` (new dependency, needs owner approval). API and worker each expose `/metrics`.
- M2: **Labels use bounded values only.** Forbidden: `hash`, URL, model name, raw error text, any secret. Complete allow-list:

| Label | Values |
|---|---|
| `role` | `api`, `worker`, `all` |
| `phase` | the 7 `JobStatus` values |
| `reason` | M3 enum |
| `provider` | `openai`, `openrouter`, `anthropic`, `gemini`, `custom` |
| `mode` | `syntax-only`, `smoke`, `full` |
| `route` | Fastify route template; unmatched is always `unmatched` |
| `method` | HTTP method |
| `status_code` | HTTP status code |
| `state` | `waiting`, `active`, `delayed`, `failed` |
| `result` | `completed`, `failed` |
| `outcome` | `ok`, `error` (phase); `healed`, `failed`, `rejected` (self-heal) |
| `passed` | `true`, `false` |
| `kind` | `prompt`, `completion` |

- M3: `reason` is a fixed enum, sharing one definition with R3's common error classification: `input_unreachable`, `llm_auth`, `llm_rate_limit`, `llm_model_not_found`, `llm_parse`, `browser_timeout`, `browser_crash`, `generation_parse`, `verification_exhausted`, `storage`, `redis`, `worker_restart`, `queue_lost`, `timeout`, `cancelled`, `unknown`.
- M4: No change to the `JobState` / `StreamEvent` schema (PRD.md alignment rule). Terminal metrics are counted only by the winner of the S4 atomic termination; `phase` is the state just before termination.
- M5: Self-heal LLM usage is added to the existing `tokenUsage`, so token / cost metrics cover generator + self-heal. Whether Stagehand exploration usage is already included must be confirmed during implementation, and the dashboard must state the coverage.
- M6: Counters live in process memory; values not yet scraped are lost on a crash. The lab accepts this; dashboards always use `rate()` / `increase()`.

Metric list:

| Name | Type | Labels | Counted at |
|---|---|---|---|
| `http_requests_total` | counter | `route`,`method`,`status_code` | API |
| `http_request_duration_seconds` | histogram | `route`,`method` | API; SSE route excluded |
| `picklescout_queue_jobs` | gauge | `state` | API reads BullMQ counts at scrape, 1 s timeout; on failure the gauge is omitted (never reports 0) |
| `picklescout_redis_up` | gauge | `role` | Each role pings, 1 s timeout |
| `picklescout_jobs_started_total` | counter | `provider`,`mode` | When the worker claims a `queued` job |
| `picklescout_jobs_finished_total` | counter | `result`,`provider`,`mode` | S4 termination winner |
| `picklescout_job_failures_total` | counter | `phase`,`reason` | S4 termination winner |
| `picklescout_phase_duration_seconds` | histogram | `phase`,`outcome` | Timed in the worker; each entry/exit of `verifying` / `self_healing` is its own segment |
| `picklescout_job_duration_seconds` | histogram | `result` | S4 termination winner, measured from `createdAt` |
| `picklescout_verification_runs_total` | counter | `mode`,`passed` | Each `runVerifier()` return (internal reruns in `full` mode are not counted separately) |
| `picklescout_self_heal_attempts_total` | counter | `outcome` | Each round of the self-heal loop |
| `picklescout_job_tokens` | histogram | `kind` | Read `tokenUsage` at termination |
| `picklescout_job_cost_usd` | histogram | `provider` | Read `tokenUsage.estimatedCostUSD` at termination |
| `picklescout_hallucination_risk_total` | counter | — | When `hallucinationRisk` is set to true |
| Process metrics | default | — | `collectDefaultMetrics()` |

CPU / memory / restarts come from cAdvisor + kube-state-metrics, not application code.

Acceptance:
- Unit tests: each termination scenario counts exactly once; `reason` never leaves the enum; label values contain no hash / URL; unmatched routes are `unmatched`.
- With Redis stopped, `/metrics` responds within 2 s, `picklescout_redis_up` is 0, and no fake queue numbers are emitted.
- After one successful and one failed job on Compose, `curl /metrics` shows the matching values.

### T — Terraform

- T1: Two Terraform roots, each with its own state:
  - `infra/terraform/lab`: OrbStack machine `picklescout-lab` (D1, Ubuntu 24.04), k3s install, kubeconfig file output.
  - `infra/terraform/platform`: reads the lab kubeconfig; creates the `picklescout` and `monitoring` namespaces and the kube-prometheus-stack Helm release.
  - Why split: the kubernetes / helm providers need an existing kubeconfig, which a single root cannot provide on its first apply.
- T2: Terraform does **not** manage application Deployments / Services / Ingress / PVCs / ConfigMaps.
- T3: When `local-exec` creates the VM and installs k3s, destroy-time cleanup is required and the install script must be re-runnable. Accepted limit: Terraform does not detect drift inside the VM.
- T4: One entry script, `infra/lab.sh up|down`. `up` = lab apply → platform apply; `down` = platform destroy → lab destroy (remove Helm / Kubernetes resources before deleting the machine). "First apply" means `lab.sh up`.
- T4a: Install k3s with `--tls-san picklescout-lab.orb.local`; the exported kubeconfig's server becomes `https://picklescout-lab.orb.local:6443` so `kubectl` on the Mac host connects directly.
- T5: Image delivery: build locally, import into k3s containerd, as one command.
- T6: State stays local; `.gitignore` excludes state and kubeconfig.
- Installing terraform and creating the VM need owner approval.

Acceptance:
- From scratch, after `infra/lab.sh up`: `kubectl get nodes` on the Mac is Ready; Prometheus / Grafana pods are Ready.
- `terraform plan` on both roots immediately afterwards shows No changes.
- After `infra/lab.sh down`, `orb list` has no `picklescout-lab`; Compose volumes are untouched; `up` again gives the same result.

### K — Kubernetes application resources

- K1: Kustomize in `deploy/k8s/`, deployed with `kubectl apply -k`.
- K2: Workloads: `frontend` Deployment, `api` Deployment, `worker` Deployment (replicas 1, `strategy: Recreate`), `redis` StatefulSet + PVC (keep `--save 60 1`).
- K3: Storage: one `storage` PVC (k3s `local-path`, `ReadWriteOnce`, not `ReadWriteOncePod`); API and worker mount it on the same node with the same UID for read/write. Limit: single-node only.
- K4: Worker `/dev/shm`: `emptyDir{medium: Memory, sizeLimit: 2Gi}`, matching Compose and counted in the memory limit. Explorer currently uses `--disable-dev-shm-usage`; whether the verifier's Chromium uses shm must be measured.
- K5: Ingress (k3s built-in Traefik), one host: `/` → frontend, `/api` (prefix kept) → API. Frontend built with `VITE_API_URL=""`: same-origin, no CORS needed.
- K6: A ConfigMap holds the existing Compose env vars plus `PICKLESCOUT_ROLE`. Nothing currently needs a Secret (LLM keys come with each job), so no empty Secret. Redis is not exposed.
- K7: Every container has requests / limits. Liveness / readiness: API both; worker liveness; frontend both via HTTP `/`; Redis both via `redis-cli ping`.
- K8: Metrics scraping: API and worker each get an internal metrics Service, scraped via ServiceMonitor.
- K9: Resource budget: OrbStack has only 8 GB total (see §2) for k3s, the monitoring platform, Chromium at `MAX_CONCURRENT_JOBS=2`, and the Docker used for Compose development. Raising the OrbStack cap or dropping the lab to 1 concurrent job both need owner approval — no silent downgrade (see Q4).

Acceptance:
- After `kubectl apply -k deploy/k8s`, all pods are Ready; API and worker are up in Prometheus targets.
- Submit a real job via the Ingress URL, see live SSE, download the zip.
- SSE survives a long quiet job phase (at least 5 minutes of heartbeat only) without disconnecting; after a disconnect, reconnect replays.
- Run 2 jobs concurrently, record the worker's peak memory, no OOMKilled.
- `docker compose up` still works.

### G — Grafana dashboard

- G1: Dashboard JSON lives in the repo and is loaded via Grafana provisioning, not created by hand.
- G2: System section: service up, CPU / memory, restart count, HTTP latency / error rate, queue depth, Redis up.
- G3: Pipeline section: completed / failed, phase failure distribution, `reason` ranking, verification pass rate, self-heal rate and success rate, phase latency, tokens / cost per job (with coverage noted), hallucination-risk rate.
- G4: Every panel's PromQL is listed in the docs.

Acceptance: during failure drills, the dashboard alone tells whether System or Pipeline is at fault.

### F — Failure drills

At least 3, checked off only after a real run. Required:

1. Kill the API pod: the worker's job keeps going and completes.
2. Kill the worker pod mid-job (SIGKILL).
3. Restart Redis.

Optional: LLM returns an error (use an invalid key, no code change), verification failure, storage not writable.

For each scenario record: what the user sees, what Kubernetes does, which metric / log reveals the cause, whether it recovers automatically, and the manual steps needed. Stored in `docs/sre-lab/failure-drills.md`.

### D — Docs

- `docs/sre-lab/README.md`: prerequisite tools, `terraform apply` → image import → `kubectl apply -k` → open Grafana, the Terraform vs Kubernetes responsibility table, teardown steps. Written alongside the T / K milestones, not left to the end.
- Both READMEs link to it; `docs/PRD.md` §1.5, §2.3, Appendix A gain the k3s deployment and `PICKLESCOUT_ROLE`.

## 5. Milestones

| # | Content | Depends on | Acceptance focus |
|---|---|---|---|
| M0 | Merge R1–R3; record baseline test count and dependency versions | — | Repair plan acceptance |
| M1 | B: Bun package manager | M0 | B acceptance |
| M2 | S: role split, atomic termination, recovery, SIGTERM, `/ready` | M1 | S acceptance (on Compose) |
| M3 | M: metrics | M2 | M acceptance (on Compose) |
| M4 | T: Terraform lab + monitoring platform + lab part of D | Parallel with M1–M3 | T acceptance |
| M5 | K: application resources + deployment part of D | M3, M4 | K acceptance; S acceptance rerun on k3s |
| M6 | G: dashboard | M5 | G acceptance |
| M7 | F: drills and write-ups | M6 | 3 drills actually run |

## 6. Overall acceptance (maps to issue #2)

- [ ] PickleScout completes a real job on local k3s without Compose.
- [ ] Terraform reproducibly builds the lab (apply → plan no changes → destroy → apply).
- [ ] frontend / API / worker / Redis / storage responsibilities are separated.
- [ ] Application workloads have probes and resource limits.
- [ ] Grafana shows both system and pipeline health.
- [ ] Pipeline success/failure, verification, and self-heal metrics are queryable.
- [ ] At least 3 failure scenarios run and documented.
- [ ] Docs explain Terraform vs Kubernetes responsibilities.
- [ ] Local Compose development still works.
- [ ] First-party code and operator docs use Bun; pnpm remains only in the §3.2 exemptions.

## 7. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Stalled job re-queued | Target site explored twice, same storage paths overwritten | S3 stalled fails directly + `processJob` accepts only `queued`; S acceptance 4 |
| API and worker terminate concurrently | Duplicate events, double counts, overwritten state | S4 atomic termination; S acceptance 5 |
| OrbStack 8 GB cap too small | OOM in the lab, or squeezing Compose development | K9 measurement; owner decides via Q4 between raising the cap and lowering concurrency |
| Bun lockfile resolves different versions | Hidden behavior changes | B acceptance diffs versions; test count must not drop |
| Verifier behaves differently on npm | Verification results change | B5 keeps timeout / abort / ignore-scripts; real smoke run |
| High-cardinality labels | Prometheus memory blow-up, URL leakage | M2 allow-list + tests |
| Counters lost on crash | Undercounting | M6 accepts; use `rate()` / `increase()` |
| `local-path` is single-node only | Storage breaks when adding nodes | K3 states the limit |
| SSE buffered or cut by Traefik | Frontend loses live progress | K acceptance covers long SSE connections and replay |
| `local-exec` has no drift detection | Terraform misses manual VM changes | T3 accepts; docs describe how to rebuild |

## 8. Actions requiring approval

The following need explicit owner approval before running:

- Installing dependencies: generating the Bun lockfile, `prom-client`, terraform, helm-related tooling.
- `docker compose up/down`, creating the VM, `terraform apply/destroy`, deploying to k3s.
- Any Redis / `/storage` data deletion.
- S (shared state, recovery, atomic termination) and B (command contracts) are high-risk; implementation needs a separately scoped Astra authorization.

## 9. Decisions

| # | Decision | Date |
|---|---|---|
| D1 | k3s runs in OrbStack Linux machine `picklescout-lab`, treated as an independent Linux instance. Terraform creates / deletes it via `local-exec` calling `orb`. OrbStack + Terraform has not been tested yet; T acceptance will prove it. | 2026-10-15 |
| D2 | Worker SIGTERM grace is 60 s; beyond that the job fails as `worker_restart` and is not resumed. | 2026-10-15 |

## 10. Open questions

| # | Question | Recommendation |
|---|---|---|
| Q3 | Terraform or OpenTofu? | Terraform (named in the issue). |
| Q4 | OrbStack has only 8 GB — raise it? | Not yet. Decide after M5 measures peak memory for 2 concurrent jobs; the owner then picks between "raise the OrbStack cap" and "run the lab at 1 concurrent job". |
