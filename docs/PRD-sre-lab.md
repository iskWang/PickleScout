# PRD — SRE Lab：Bun、k3s、Terraform、可觀測性與 Pipeline 指標

- 來源：[issue #2](https://github.com/iskWang/PickleScout/issues/2)，加上 2026-10-15 使用者要求「pnpm 改成 Bun」。
- 前置文件：`docs/reviews/2026-10-12-repair-plan.md`（R1–R5、Bun + issue #2 段落）。
- 狀態：**v2.3，可交付實作。** Astra（codex-architect）審查三輪：v1、v2.1、v2.2 皆為 PARTIALLY AGREE；第三輪只剩 2 處文字修正，v2.3 已改。DNS、6443 連通、實際 apply 由 T 驗收證明。本文件是需求，不是完成證據。

## 1. 目標

把 PickleScout 變成可練習「部署、觀察、弄壞、診斷、恢復」的本機 SRE lab：

1. 套件管理從 pnpm 換成 Bun。
2. 在 Mac mini 上用 Terraform 建出單節點 k3s。
3. 在 k3s 上分開跑 frontend、API、worker、Redis、storage。
4. Prometheus + Grafana 能回答：**問題出在基礎設施，還是 AI 生成 pipeline？**

學習用途，不是 production 改寫。Docker Compose 開發流程必須保留。

## 2. 現況（已查證）

| 項目 | 現況 | 證據 |
|---|---|---|
| 服務 | Compose 只有 `frontend`、`backend`、`redis` | `docker-compose.yml:1-53` |
| API / worker | 同一程序；`index.ts` 在 listen 前固定呼叫 `startWorker()` 與 reconciler；無角色切換 | `backend/src/index.ts:51-61` |
| 匯入耦合 | `routes/jobs.ts` 從 worker 模組匯入 queue；worker 模組靜態匯入 explorer / generator / verifier | `routes/jobs.ts:9`、`worker/index.ts:15-18` |
| 啟動恢復 | 啟動時把**所有**非 terminal job（含尚未開始的 `queued`）標成 `failed` | `backend/src/startup.ts:36-63` |
| Reconciler | 只檢查 BullMQ job 是否存在；存在就跳過，不看 active / failed / stalled | `backend/src/reconciler.ts:34-42` |
| 其他終結者 | `GET /api/jobs/:hash` 會自行修復成 failed；`DELETE` 會自行取消 | `routes/jobs.ts:139-143,167-178` |
| 狀態寫入 | `updateJobStatus()` 是讀取後寫回，不是原子轉換 | `backend/src/redis.ts:67-86` |
| SSE ID | 每個程序記憶體內的 Map 遞增；worker 開始工作時會重設 | `worker/sse.ts:22-35`、`worker/index.ts:82` |
| 關閉 | 無 SIGTERM handler、無 `worker.close()` | `index.ts`、`worker/index.ts:39-76` |
| Queue | BullMQ 5.51.1 queue `generation`，`attempts: 1`，`removeOnFail: false`；未設 stalled 參數，沿用預設 `maxStalledCount: 1`、`lockDuration` / `stalledInterval` 30 秒 → **stalled job 會被重新排隊一次** | `worker/index.ts:28-35`、`bullmq/dist/cjs/classes/worker.js:49` |
| 重入 | `processJob()` 只跳過 terminal job，非 terminal job 重入會重新探索 | `worker/index.ts:81-92` |
| 重複失敗處理 | 同一例外會經 `processJob` catch 再進 BullMQ failed handler | `worker/index.ts:47-51,245-249` |
| Health | 只有 `GET /health`，固定回 ok | `index.ts:47-48` |
| Metrics | backend 依賴與原始碼搜尋皆無 Prometheus / `prom-client` | `backend/package.json:14-31` |
| Storage | worker 寫 screenshots / action-logs / generated / outputs；API 讀 screenshots 與 result zip → **必須共用 volume** | `routes/result.ts:35-46`、`routes/screenshots.ts:10-16` |
| Chromium | 在 worker 內跑；Compose `shm_size: 2gb`，但 explorer 啟動參數有 `--disable-dev-shm-usage` | `docker-compose.yml:21`、`worker/explorer.ts:60` |
| 失敗原因 | 只有自由文字 `JobState.error` | `backend/src/types.ts:30-34` |
| Self-heal 次數 | 沒有結構化累計欄位；次數只出現在 `llm_log` 文字事件 | `worker/index.ts:176-180` |
| Token | generator 累加 `tokenUsage`；self-heal 的 LLM 呼叫**沒有**累加 | `generator.ts:341-363`、`verifier.ts:537-560` |
| 驗證次數 | `full` 模式可能跑兩次 Cucumber，但只回傳一份結果 | `verifier.ts:123-131` |
| 前端 API 位址 | build-time `VITE_API_URL`，空字串時走相對路徑 `/api` | `frontend/src/lib/api.ts:1-3` |
| SSE heartbeat | 25 秒 | `routes/stream.ts:116-119` |
| pnpm 耦合 | root scripts、`engines.pnpm`、`packageManager`、兩個 Dockerfile（含 `pnpm dlx playwright`）、verifier 子程序 `pnpm install` / `pnpm exec`、操作文件 | `package.json:4-13`、`backend/Dockerfile:3-28`、`verifier.ts:65,86,138` |
| 刻意保留的 pnpm | 生成 ZIP 的 CI 範本與其契約測試 | `docs/PRD.md:200-204`、`packager.test.ts:118` |
| 本機工具 | 有 `kubectl`、`docker`、OrbStack；沒有 `terraform` / `tofu` / `helm` | 2026-10-15 `command -v` |
| OrbStack | 尚無任何 machine；內建 k8s 關閉；`orb create` 支援 `--cpus` / `--memory` / `--disk` / `-c` cloud-init；**所有 machine 與 Docker 共用上限 `memory_mib: 8192`** | 2026-10-15 `orb list`、`orb create --help`、`orb config show` |

## 3. 範圍

### 3.1 In scope

| ID | 需求 |
|---|---|
| B | pnpm → Bun（套件管理與 workspace；runtime 不切） |
| S | API / worker 角色拆分、終結語意、恢復與關閉 |
| M | `/metrics`：系統指標 + pipeline 指標 |
| T | Terraform：lab 機器、k3s、監控平台 |
| K | Kubernetes 應用資源（Kustomize） |
| G | Grafana dashboard（System / Pipeline 兩區） |
| F | 故障演練與紀錄 |
| D | 文件：Terraform vs Kubernetes 邊界、操作步驟 |

### 3.2 Non-goals

- 多節點 / HA、雲端架構、service mesh、HPA 或任何 autoscaling。
- 取代 BullMQ / Redis；圍繞 Kubernetes 重寫 PickleScout。
- 另建 eval 平台或永久 job 歷史資料庫。
- 跨程序崩潰的「精確一次」指標（見 M6）。
- 服務 runtime 從 Node 切到 Bun。
- 變更**生成 ZIP** 的契約：Cucumber 11.0.0 / Playwright 1.60.0 精確版本、ZIP README、ZIP 內 CI 範本。
- `video/`、`docs/reviews/` 歷史文件。

### 3.3 前置條件

- repair plan R1–R3 先完成並合併，作為 baseline。現在的 `fix/review-runtime-boundaries` 分支仍有未提交變更。
- R5（storage 清理）目前受阻；S 會改變它的前提。本 PRD 不授權刪除資料。

## 4. 需求

### B — pnpm → Bun

- B1：root 改用 `package.json` `workspaces`，`bun.lock` 取代 `pnpm-lock.yaml` / `pnpm-workspace.yaml`；移除 `engines.pnpm` 與 `packageManager: pnpm`。不留雙軌。
- B2：root scripts 改用 Bun workspace filter；`typecheck` / `lint` / `test` / `build` / `dev:*` 名稱不變。保持 **shared 先 build** 的順序與依賴選取，不是字串替換。
- B3：Dockerfile install / build 階段用 `bun install --frozen-lockfile`。backend 的 `pnpm dlx playwright@1.60.0 install chromium --with-deps` 改為 Node 執行的等價指令，版本不變。
- B4：服務 runtime 維持 Node 20。由 Bun script runner 啟動的 Node 工具（tsc、vitest、eslint、vite）也留在 Node 上執行。
- B5：verifier 生成目錄的指令改用 `npm`，與 ZIP README 一致。必須保留：`--ignore-scripts`、timeout、`AbortSignal`、`cwd`；執行 `cucumber-js` / `tsc` 時禁止在缺少工具時臨時下載。
- B6：AGENTS.md、CLAUDE.md、兩份 README、`.agents/*` 的操作指令同步更新。

驗收：
- `bun install --frozen-lockfile` 乾淨安裝。
- `bun run typecheck`、`lint`、`test` 全過；測試數不少於 M0 baseline。
- 遷移前後比對已解析的依賴版本，差異逐項說明。
- 兩個 image 都能 build；`docker compose up` 跑完一個真實 job。
- verifier 實跑一次 `smoke` 模式通過；一次 abort 能終止子程序。
- 可執行的 `pnpm` 指令（scripts、Dockerfile、程式內 spawn、操作文件的指令區塊）只出現在 §3.2 豁免處；描述遷移的說明文字不算。

### S — API / worker 拆分與終結語意

- S1：同一 image，`PICKLESCOUT_ROLE=api|worker|all` 決定啟動內容；預設 `all`，Compose 行為不變。
- S2：`api` 角色只當 queue producer。queue 定義抽成不匯入 explorer / generator / verifier / Stagehand 的模組；`api` 程序不得載入這些模組。
- S3：**中斷的工作不續跑。** 被中斷的 active job 一律失敗，不重新進 pipeline：
  - Worker 設 `maxStalledCount: 0`。已安裝的 BullMQ 5.51.1 預設是 1（`worker.js:49`），代表 stalled job 會**被重新排隊一次**；判斷式是 `stalledCount > maxStalledCount`（`moveStalledJobsToWait-9.lua:81`），設 0 才會第一次 stalled 就 failed。
  - **原子領取。** worker 接受 job 的唯一條件是原子的 `queued → exploring` 轉換成功；失敗就丟棄該 BullMQ job，不執行。
  - 刪除「啟動時全部非 terminal 標 failed」的 sweep。BullMQ 仍在 waiting（尚未被領取）的 job，在任何角色重啟後都保留。BullMQ 已領取為 active、但 JobState 還沒完成原子領取就被殺的 job，依 `maxStalledCount: 0` 失敗，不執行探索。
- S4：**原子狀態更新。** 所有 JobState 寫入（含 phase、progress、tokenUsage 等非 terminal 更新）都在 Redis 端原子完成，且**不能覆蓋已是 terminal 的狀態**；現行讀取後整包寫回（`redis.ts:67-86`）不可再用。寫入 terminal 的路徑（worker 完成 / 失敗、BullMQ failed handler、reconciler、`GET` 修復、`DELETE` 取消）只有第一個成功者發 SSE 終結事件、寫 `reason`、計 metrics。不新增 `JobState` 欄位。
- S5：reconciler 在 `api` 與 `all` 角色各跑一份（同一部署中只有一個這種程序）。條件：JobState 非 terminal，且 BullMQ job 不存在**或**已 failed。reason 規則：BullMQ failed 原因是 stalled → `worker_restart`；BullMQ job 不存在 → `queue_lost`；其他 failed → `unknown`。worker failed handler 用同一規則，所以不論誰先終結，結果一致。
- S6：SSE event：
  - ID 計數 key 為 `events:{hash}:seq`，不放在 `job:` 前綴下（reconciler 以 `job:*` 掃描，否則會被誤當 JobState，`reconciler.ts:31-35`）。AGENTS.md 的 key 規則已有既存例外 `events:{hash}`、`sse:events:{hash}`，此 key 歸同一類並寫進 AGENTS.md。
  - 「遞增 ID、寫入 buffer、裁成 50 筆、發布」在同一個 Redis 原子操作完成，確保順序與 ID 一致。
  - seq key 與 `events:{hash}` 用同一個 TTL，每次寫入時一起續期。
  - `StreamEvent` schema 不變。
- S7：self-heal 開始時把 JobState status 原子寫成 `self_healing`（現有 `JobStatus` 值，不改 schema）；現況只有 SSE 事件（`verifier.ts:500`）。這讓取消或失敗能歸到正確 phase。
- S8：SIGTERM 順序：
  - worker：(1) 停止接新 job，BullMQ 續鎖**持續運作**；(2) 等目前 job 最多 60 秒（D2），完成就正常結束；(3) 超時則**先**原子終結成 `failed` / `worker_restart`，**再**送 abort；(4) 以 process group 結束 verifier 子程序樹，強制關閉 Chromium，每步有逾時；(5) 關閉 BullMQ worker 與 Redis 連線後退出。Redis 不可用時跳過 (3)，直接 (4)(5)，交給 S5 事後處理。
  - api：停止接新請求，關閉 SSE 長連線（客戶端會重連），然後退出。
  - 上限：worker `terminationGracePeriodSeconds: 90`（60 秒 grace + 30 秒收尾）；Compose 的 backend 設 `stop_grace_period: 90s`。
- S9：`/health`（liveness）只表示程序活著，不查依賴。`/ready`（readiness）檢查角色必要依賴（API：Redis，查詢有逾時）。Redis 中斷不能讓 liveness 失敗。
- S10：worker 開一個只給 probe 與 metrics 的內部 HTTP port。

**狀態與指標責任表**

| 情境 | 誰寫 terminal | 結果 / `reason` | 誰計 metric | 前提 |
|---|---|---|---|---|
| 正常完成 | worker | `completed` | worker | — |
| pipeline 失敗 | worker（catch 或 failed handler，先到者） | `failed` / 分類後的 reason | 同左 | — |
| SIGTERM，grace 內完成 | worker | `completed` | worker | — |
| SIGTERM，超過 grace | 關閉中的 worker | `failed` / `worker_restart` | 同左 | Redis 可用 |
| SIGKILL / OOM | 先到者：worker 的 failed handler，或 API reconciler | `failed` / `worker_restart`（依 S5 規則） | 同左 | Redis 可用；**必須有 worker 在跑**（stalled 檢查只由 worker 執行，`worker.js:648-675`）。API 只能在 BullMQ 已轉 failed 後搶先終結 |
| 使用者取消 | API（`DELETE`） | `failed` / `cancelled` | API | — |
| BullMQ 記錄遺失 | API（reconciler 或 `GET` 修復） | `failed` / `queue_lost` | API | — |
| Redis 中斷 | 無人能寫；恢復後依上列規則 | — | — | 中斷期間 `/ready` 為 false |

驗收（Compose 與 k3s 都要做）：
1. 重啟 API，進行中的 job 完成；`queued` job 保留並在之後被處理。
2. SIGTERM worker，job 在 grace 內完成。
3. SIGTERM worker，job 超過 grace → `failed` / `worker_restart`；無殘留 Chromium 程序。
4. SIGKILL worker → 新 worker 起來後 N 秒內 job 變成 `failed` / `worker_restart`，且該 job 沒有再次進入 `exploring`。N 實測後寫入文件，並寫明前提：新 worker 的 stalled 檢查在運作、Redis 可用。BullMQ 預設值只是參考，不當作保證上限。
5. 讓 worker 與 `DELETE` 同時終結同一 job：只有一個終結事件、一次 metric 計數。
6. 終結後再送一個非 terminal 更新（模擬慢到的 progress 寫入）：狀態仍是 terminal。
7. 同一 BullMQ job 被兩個 worker 呼叫處理：只有一個領取成功。另外，BullMQ 已把 job 標成 active、但 JobState 仍是 `queued` 時殺 worker：job 變成 `failed` / `worker_restart`，沒有進入 `exploring`。
8. 重啟 worker 前後連 SSE：event ID 單調遞增，`Last-Event-ID` 重播正確；並發寫入時 buffer 中的 ID 順序與發布順序一致。

### M — Metrics

- M1：使用 `prom-client`（新依賴，需使用者批准）。API 與 worker 各自暴露 `/metrics`。
- M2：**Label 只用有限值。** 禁止 `hash`、URL、model 名稱、錯誤原文、任何秘密。完整允許清單：

| Label | 值 |
|---|---|
| `role` | `api`、`worker`、`all` |
| `phase` | 7 個 `JobStatus` |
| `reason` | M3 列舉 |
| `provider` | `openai`、`openrouter`、`anthropic`、`gemini`、`custom` |
| `mode` | `syntax-only`、`smoke`、`full` |
| `route` | Fastify 路由樣板；未匹配一律 `unmatched` |
| `method` | HTTP method |
| `status_code` | HTTP 狀態碼 |
| `state` | `waiting`、`active`、`delayed`、`failed` |
| `result` | `completed`、`failed` |
| `outcome` | `ok`、`error`（phase）；`healed`、`failed`、`rejected`（self-heal） |
| `passed` | `true`、`false` |
| `kind` | `prompt`、`completion` |

- M3：`reason` 固定列舉，與 R3 的共用錯誤分類用同一份定義：`input_unreachable`、`llm_auth`、`llm_rate_limit`、`llm_model_not_found`、`llm_parse`、`browser_timeout`、`browser_crash`、`generation_parse`、`verification_exhausted`、`storage`、`redis`、`worker_restart`、`queue_lost`、`timeout`、`cancelled`、`unknown`。
- M4：不改 `JobState` / `StreamEvent` schema（PRD.md 對齊規則）。終結類指標只由 S4 原子終結的成功者計數；`phase` 取終結前的狀態。
- M5：self-heal 的 LLM 用量要累加進現有 `tokenUsage`，讓 token / 成本指標涵蓋 generator + self-heal。Stagehand 探索階段的用量是否已計入需在實作時確認，並在 dashboard 註明涵蓋範圍。
- M6：counter 存在程序記憶體；程序崩潰時尚未被 scrape 的數值會遺失。lab 接受此限制，dashboard 一律用 `rate()` / `increase()`。

指標清單：

| 名稱 | 型別 | Labels | 計數點 |
|---|---|---|---|
| `http_requests_total` | counter | `route`,`method`,`status_code` | API |
| `http_request_duration_seconds` | histogram | `route`,`method` | API；SSE 路由不計 |
| `picklescout_queue_jobs` | gauge | `state` | API scrape 時讀 BullMQ counts，1 秒逾時；失敗時不輸出此 gauge（不報 0） |
| `picklescout_redis_up` | gauge | `role` | 各角色 ping，1 秒逾時 |
| `picklescout_jobs_started_total` | counter | `provider`,`mode` | worker 接受 `queued` job 時 |
| `picklescout_jobs_finished_total` | counter | `result`,`provider`,`mode` | S4 終結成功者 |
| `picklescout_job_failures_total` | counter | `phase`,`reason` | S4 終結成功者 |
| `picklescout_phase_duration_seconds` | histogram | `phase`,`outcome` | worker 內計時；每次進出 `verifying` / `self_healing` 各算一段 |
| `picklescout_job_duration_seconds` | histogram | `result` | S4 終結成功者，`createdAt` 起算 |
| `picklescout_verification_runs_total` | counter | `mode`,`passed` | 每次 `runVerifier()` 回傳（`full` 模式內部重跑不另計） |
| `picklescout_self_heal_attempts_total` | counter | `outcome` | self-heal 迴圈每一輪 |
| `picklescout_job_tokens` | histogram | `kind` | 終結時讀 `tokenUsage` |
| `picklescout_job_cost_usd` | histogram | `provider` | 終結時讀 `tokenUsage.estimatedCostUSD` |
| `picklescout_hallucination_risk_total` | counter | — | `hallucinationRisk` 設為 true 時 |
| 程序指標 | 預設 | — | `collectDefaultMetrics()` |

CPU / memory / restarts 來自 cAdvisor + kube-state-metrics，不在程式內做。

驗收：
- 單元測試：每種終結情境只計一次；`reason` 不會超出列舉；label 值不含 hash / URL；未匹配路由為 `unmatched`。
- Redis 停止時，`/metrics` 在 2 秒內回應，`picklescout_redis_up` 為 0，不輸出假的 queue 數字。
- Compose 上跑一個成功 job、一個失敗 job 後，`curl /metrics` 看到對應數值。

### T — Terraform

- T1：Terraform 分兩個 root，各自 state：
  - `infra/terraform/lab`：OrbStack machine `picklescout-lab`（D1，Ubuntu 24.04）、k3s 安裝、輸出 kubeconfig 檔。
  - `infra/terraform/platform`：讀 lab 輸出的 kubeconfig，建 `picklescout` 與 `monitoring` namespace、kube-prometheus-stack Helm release。
  - 分開的原因：kubernetes / helm provider 需要已存在的 kubeconfig，同一個 root 無法在第一次 apply 時就初始化。
- T2：Terraform **不管**應用 Deployment / Service / Ingress / PVC / ConfigMap。
- T3：用 `local-exec` 建 VM 與裝 k3s 時，必須有 destroy 時的清理，且安裝腳本可重跑。接受限制：Terraform 不會偵測 VM 內部的漂移。
- T4：一個入口腳本 `infra/lab.sh up|down`。`up` = lab apply → platform apply；`down` = platform destroy → lab destroy（先移除 Helm / Kubernetes 資源，再刪 machine）。「首次 apply」指 `lab.sh up`。
- T4a：k3s 安裝帶 `--tls-san picklescout-lab.orb.local`；輸出的 kubeconfig 把 server 改成 `https://picklescout-lab.orb.local:6443`，讓 Mac 主機上的 `kubectl` 可以直接連。
- T5：image 交付：本機 build 後匯入 k3s containerd，步驟寫成一個指令。
- T6：state 存本機；`.gitignore` 排除 state 與 kubeconfig。
- 安裝 terraform、建立 VM 需使用者批准。

驗收：
- 從無到有 `infra/lab.sh up` 後，Mac 上 `kubectl get nodes` Ready、Prometheus / Grafana pods Ready。
- 兩個 root 立刻再跑 `terraform plan` 都顯示 No changes。
- `infra/lab.sh down` 後 `orb list` 沒有 `picklescout-lab`；Compose volume 不受影響；再 `up` 得到相同結果。

### K — Kubernetes 應用資源

- K1：Kustomize，目錄 `deploy/k8s/`，`kubectl apply -k` 部署。
- K2：Workloads：`frontend` Deployment、`api` Deployment、`worker` Deployment（replicas 1，`strategy: Recreate`）、`redis` StatefulSet + PVC（保留 `--save 60 1`）。
- K3：Storage：單一 `storage` PVC（k3s `local-path`，`ReadWriteOnce`，不是 `ReadWriteOncePod`）；API 與 worker 在同一節點共同掛載，兩者 UID 一致可讀寫。限制：只適用單節點。
- K4：worker `/dev/shm`：`emptyDir{medium: Memory, sizeLimit: 2Gi}`，與 Compose 對齊，計入記憶體上限。explorer 目前用 `--disable-dev-shm-usage`，verifier 的 Chromium 是否用到 shm 需實測。
- K5：Ingress（k3s 內建 Traefik），同一個 host：`/` → frontend，`/api`（保留 prefix）→ API。前端以 `VITE_API_URL=""` build，同源，不需 CORS。
- K6：ConfigMap 放 Compose 現有環境變數與 `PICKLESCOUT_ROLE`。目前沒有需要 Secret 的內容（LLM key 是每個 job 帶入），不建空 Secret。Redis 不對外。
- K7：所有 container 有 requests / limits。liveness / readiness：API 兩者；worker liveness；frontend 以 HTTP `/` 兩者；Redis 以 `redis-cli ping` 兩者。
- K8：metrics 抓取：API 與 worker 各有內部 metrics Service，用 ServiceMonitor 抓取。
- K9：資源預算：OrbStack 全部只有 8 GB（見 §2），要同時放 k3s、監控平台、`MAX_CONCURRENT_JOBS=2` 的 Chromium，以及 Compose 開發用的 Docker。提高 OrbStack 上限或把 lab 改成 1 個並發，都需使用者同意，不可默默降級（見 Q4）。

驗收：
- `kubectl apply -k deploy/k8s` 後所有 pods Ready；Prometheus targets 中 API 與 worker 皆 up。
- 從 Ingress 網址送出真實 job、看到即時 SSE、下載 zip。
- SSE 撐過一段長時間沒有新事件的 job 階段（至少 5 分鐘只有 heartbeat）不斷線；斷線後重連可重播。
- 同時跑 2 個 job，記錄 worker 記憶體峰值，沒有 OOMKilled。
- `docker compose up` 仍可用。

### G — Grafana dashboard

- G1：dashboard JSON 進 repo，由 Grafana provisioning 載入，不手動建立。
- G2：System 區：服務 up、CPU / memory、restart 數、HTTP 延遲 / 錯誤率、queue depth、Redis up。
- G3：Pipeline 區：completed / failed、phase 失敗分布、`reason` 排行、驗證通過率、self-heal 率與成功率、phase 延遲、每 job token / 成本（註明涵蓋範圍）、hallucination risk 率。
- G4：每個 panel 的 PromQL 列在文件中。

驗收：故障演練時，只看 dashboard 能判斷是 System 還是 Pipeline 出問題。

### F — 故障演練

至少 3 個，實跑後才勾選。必做：

1. 殺 API pod：worker 中的 job 繼續完成。
2. job 進行中殺 worker pod（SIGKILL）。
3. 重啟 Redis。

選做：LLM 回錯誤（用無效 key，不需改程式）、驗證失敗、storage 不可寫。

每個情境記錄：使用者看到什麼、Kubernetes 做什麼、哪個 metric / log 指出原因、是否自動恢復、需要的人工步驟。存於 `docs/sre-lab/failure-drills.md`。

### D — 文件

- `docs/sre-lab/README.md`：前置工具、`terraform apply` → image 匯入 → `kubectl apply -k` → 開 Grafana、Terraform 與 Kubernetes 責任表、清除步驟。隨 T / K 里程碑逐步寫，不等到最後。
- 兩份 README 加連結；`docs/PRD.md` §1.5、§2.3、Appendix A 補 k3s 部署方式與 `PICKLESCOUT_ROLE`。

## 5. 里程碑

| # | 內容 | 依賴 | 驗收重點 |
|---|---|---|---|
| M0 | R1–R3 合併；記錄 baseline 測試數與依賴版本 | — | repair plan 驗收 |
| M1 | B：Bun 套件管理 | M0 | B 驗收 |
| M2 | S：角色拆分、原子終結、恢復、SIGTERM、`/ready` | M1 | S 驗收（Compose 上） |
| M3 | M：metrics | M2 | M 驗收（Compose 上） |
| M4 | T：Terraform lab + 監控平台 + D 的 lab 段落 | 可與 M1–M3 平行 | T 驗收 |
| M5 | K：應用資源 + D 的部署段落 | M3、M4 | K 驗收；S 驗收在 k3s 重跑 |
| M6 | G：dashboard | M5 | G 驗收 |
| M7 | F：演練與紀錄 | M6 | 3 個演練實跑 |

## 6. 整體驗收（對應 issue #2）

- [ ] PickleScout 不靠 Compose，在本機 k3s 上跑完真實 job。
- [ ] Terraform 可重現建出 lab（apply → plan 無變更 → destroy → apply）。
- [ ] frontend / API / worker / Redis / storage 責任分開。
- [ ] 應用 workload 有 probes 與資源限制。
- [ ] Grafana 同時呈現系統與 pipeline 健康。
- [ ] pipeline 成敗、驗證、self-heal 指標可查詢。
- [ ] 至少 3 個故障情境實跑並記錄。
- [ ] 文件說明 Terraform vs Kubernetes 責任。
- [ ] Compose 本機開發仍可用。
- [ ] 一方程式與操作文件改用 Bun；pnpm 只留在 §3.2 豁免處。

## 7. 風險

| 風險 | 影響 | 對策 |
|---|---|---|
| stalled job 被重新排隊 | 重複探索目標網站、覆寫同一 storage 路徑 | S3 stalled 直接失敗 + `processJob` 只收 `queued`；S 驗收 4 |
| API 與 worker 同時終結 | 雙重事件、雙重計數、狀態被覆蓋 | S4 原子終結；S 驗收 5 |
| OrbStack 8 GB 上限不夠 | lab 內 OOM，或擠壓 Compose 開發 | K9 實測；Q4 由使用者決定提高上限或降併發 |
| Bun lockfile 解析出不同版本 | 隱性行為變化 | B 驗收比對版本；測試數不得減少 |
| verifier 改 npm 後行為改變 | 驗證結果與過去不同 | B5 保留 timeout / abort / ignore-scripts；smoke 實跑 |
| 高基數 label | Prometheus 記憶體暴增、洩漏 URL | M2 白名單 + 測試 |
| counter 崩潰遺失 | 少算 | M6 接受；用 `rate()` / `increase()` |
| `local-path` 只能單節點 | 擴節點時 storage 壞 | K3 明寫限制 |
| SSE 經 Traefik 被緩衝或切斷 | 前端看不到即時進度 | K 驗收 SSE 長連線與重播 |
| `local-exec` 無漂移偵測 | VM 被手動改後 Terraform 不知道 | T3 接受；文件寫重建方式 |

## 8. 需要批准的動作

以下動作執行前需使用者明確同意：

- 安裝依賴：Bun lockfile 產生、`prom-client`、terraform、helm 相關。
- `docker compose up/down`、建立 VM、`terraform apply/destroy`、部署到 k3s。
- 任何 Redis / `/storage` 資料刪除。
- S（共享狀態、恢復、原子終結）與 B（指令契約）屬高風險，實作需另取得範圍限定的 Astra 授權。

## 9. 已決定

| # | 決定 | 日期 |
|---|---|---|
| D1 | k3s 跑在 OrbStack Linux machine `picklescout-lab`，視為一台獨立 Linux instance。Terraform 以 `local-exec` 呼叫 `orb` 建立 / 刪除它。OrbStack 與 Terraform 的配合尚未實測，T 驗收會證明。 | 2026-10-15 |
| D2 | worker SIGTERM grace 60 秒；超過就以 `worker_restart` 失敗，不續跑。 | 2026-10-15 |

## 10. 待決問題

| # | 問題 | 建議 |
|---|---|---|
| Q3 | Terraform 或 OpenTofu？ | Terraform（issue 指名）。 |
| Q4 | OrbStack 只有 8 GB，要不要提高？ | 先不改。M5 實測 2 個 job 的記憶體峰值後再決定；屆時由使用者在「提高 OrbStack 上限」與「lab 用 1 個並發」中選一個。 |
