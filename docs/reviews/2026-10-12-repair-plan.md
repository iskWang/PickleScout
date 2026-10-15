# 2026-10-12 review、修正與 Bun / SRE 遷移計畫

## 範圍與進度規則

- 審查基準：`af216cf7078117dc8cc389743a347b75656c21e3`；修正分支：`fix/review-runtime-boundaries`。
- 使用者要求先 review；嚴重問題修正後開 PR；Bun 與 [issue #2](https://github.com/iskWang/PickleScout/issues/2) 一起規劃。
- 使用者已批准 Astra 高風險修正：CORS 設定、自癒執行邊界、確認的秘密外洩路徑，以及必要測試／文件；未批准部署、依賴安裝或資料刪除。
- 使用者另要求先留下可接續的工作清單，再派工修正。此文件是交接來源，不把計畫當作完成證據。
- 不做純排版重構、不改生成專案 Cucumber 11.0.0 / Playwright 1.60.0 精確版本；不把 Bun 遷移擴大成生成 ZIP 的 runtime 遷移。
- 狀態只能是待處理、實作中、待驗證、完成、受阻。完成需要實際執行證據與獨立 review。

## P1：本次修正

### R1 — REST CORS 忽略 Compose 的前端來源

- **證據**：`docker-compose.yml:26` 設定 `CORS_ORIGINS=http://localhost:5175`，原 `packages/backend/src/index.ts:35` 卻只允許 5173。SSE 自己讀環境設定，REST 沒有。
- **實際重現**：安裝中的 Fastify / @fastify/cors 注入 OPTIONS；5173 有 ACAO，5175 沒有。瀏覽器預設 Compose UI 因而不能跨來源呼叫 REST。
- **修法**：REST 使用 `CORS_ORIGINS` 精確來源清單。未設定保留原預設，空設定拒絕跨來源；不接受 `*`。不改 routes、啟動順序或方法清單。
- **範圍**：`packages/backend/src/index.ts`、`index.test.ts`、README 設定說明。
- **驗收**：設定的 5175 與多來源清單正常；不明來源、偽造網域後綴、空清單、萬用字元均不能取得 ACAO；真實路由 400 失敗回應仍保留正確 CORS。
- **狀態：待驗證**。Astra 已實作；父代理執行 `node node_modules/vitest/vitest.mjs run src/index.test.ts`（backend 目錄），16 tests passed。獨立 reviewer 已檢視修正，未指出 CORS blocking finding；尚待完整檢查、文件與 PR。

### R2 — 自癒接受模型產生的可執行檔案

- **證據**：`worker/verifier.ts:345-405` 直接回傳模型 JSON 的 `files`；`worker/index.ts:191-229` 合併後寫入 steps 並執行。新增檔名與原檔附加程式都沒有可信的完整程式邊界。
- **實際重現**：呼叫真正的 `validateOutput` 與 `TEMPLATE_CATALOG`，額外 `extra.ts` 內容為無害的環境 canary 賦值，得到 `{valid:true,issues:[]}`。沒有執行該程式，也未宣稱已證實遠端攻擊。
- **觸發前提**：驗證失敗、允許重試、模型回傳受不可信頁面／provider 影響的內容。Cucumber 在後端載入 steps，子程序繼承環境。
- **修正原則**：模型只能提供受驗證的修復資料，不能提供可執行程式。使用固定程式套用 selector／timeout 等修復；不以程式碼黑名單或「只檢查檔名」冒充安全邊界。
- **需先解決的契約**：PRD §3.4 允許 selector、timeout 等修復且凍結 Gherkin；專案又要求模板實作不可由 self-healer 改寫。必須讓資料式修復保留固定模板與 Gherkin 意圖，不能把 self-heal 偷改成 no-op。若既有產物契約無法做到，需明列最小必要變更，不偷偷停用功能。
- **驗收**：正常 selector 修復能改變定位行為；未知修復欄位、任意程式字串、額外檔案、原檔附加程式、移除 assertion 或改 scenario 的回應不能寫入／執行；固定模板、feature、ZIP 與驗證目錄一致；失敗時仍留下可解釋的未驗證結果。無網路的 entrypoint smoke 與故障路徑必須實跑。
- **狀態：待驗證（2026-10-15）**。Astra 已實作資料式修復；驗證端限制與 World adapter 對齊（value ≤300、selector ≤500、XPath 判斷、重複來源 key），且驗證端只會比 World 嚴格。`Promise.withResolvers` 改為 Node 20 可用寫法。25 組邊界／真值表測試以真實 `attemptSelfHeal` 與真實 World 範本執行，全部通過。

### R3 — 原始上游錯誤與子程序輸出可能洩漏秘密

- **證據**：`worker/index.ts:269-286` 將原始 Error.message 存入 JobState.error 並送 SSE；GET 移除 llm/auth，但保留 error。Verifier stdout/stderr 另會进入 llm_log、verification 與 self-heal 診斷。
- **限制**：尚未證實某個真實 provider 回顯秘密；已確認應用程式缺少此輸出邊界。不得把此條件式問題寫成已發生外洩。
- **修法原則**：在持久化錯誤與 SSE 的共同輸出邊界處理，保留可用但安全的診斷；不可只修某個 catch 而漏掉其他事件。識別可取得的 submitted API key／auth password 等秘密，未知不可信診斷應採安全訊息；不得記錄原始秘密作 debug。
- **驗收**：注入 canary API key/password 的上游例外與子程序輸出；Redis job error、GET、即時 SSE、重播 SSE 與日誌不得含 canary；正常錯誤仍可辨識。覆蓋狀態不存在／讀取失敗等失敗路徑，不能因遮蔽而重新洩漏。
- **狀態：待驗證（2026-10-15）**。Astra 已完成共同邊界：worker 一律拋出新的安全 Error（無原始 message／stack／cause），BullMQ failed handler 只傳安全文字，Redis 的 error 欄位寫入與讀取都清理，API key／password 完整保留。父代理獨立 oracle（canary `sk-CANARY-7f3a`／`pw-CANARY-91c2`）3/3 通過。

## P2：已確認但不混入未授權操作

### R4 — syntax-only 不解析 Gherkin

- `worker/verifier.ts:78-104` 只執行 tsc；前置 step-resolution 是逐行 regex，不是真正 Gherkin parser。違反 PRD §3.5。
- 修法：使用既有 Cucumber/Gherkin 能力做不啟動 browser 的解析；不能新增套件而未先取得批准。
- 驗收：合法 TS + 畸形 feature 必須失敗；合法 feature 正常；不啟動 Chromium。
- **狀態：待處理**。靜態 evidence 已由獨立 reviewer 複核；尚未實跑重現。

### R5 — 儲存清理漏掉 action-logs，且只在啟動執行

- `worker/explorer.ts` 寫入 `action-logs/{hash}.json`；`startup.ts:72-100` 只掃 screenshots/generated/outputs；沒有 PRD 承諾的每小時掃描。
- 與 #2 強相關：API / worker 拆分後不可讓每個 API 啟動都把正在 worker 執行的 job 當孤兒或清掉共享檔案。
- 驗收：過期工作四類資料正確清理；存活、執行中的工作完整保留；多角色啟動不錯殺；錯誤／競爭時不得刪錯資料。
- **狀態：受阻**。涉及共享狀態與定時破壞性清理；本輪批准明確不含資料刪除，需另取得限定授權。此時不操作 `/storage` 或 Redis。

## 非阻擋的簡化候選

- `JobDetailPage.tsx` 的「New Job with Same Config」實際僅導回首頁，且旁邊已有 New Job。需修標籤或去掉重複入口，不宣稱能重試原設定。
- 完成畫面有兩個 Copy URL；可只保留一個。優先度低，不為此做 UI 重構。
- 不因 TypeScript 型別推斷就刪除資料邊界的 fallback；瀏覽器儲存資料仍可能來自舊版本。

## Bun + issue #2：同一計畫、分開驗收

1. **先修 R1–R3，建立可重現的 baseline**。Bun 不是安全修正或 queue 故障的替代品。
2. **拆 API / worker 入口與責任**。Queue producer 不應強迫載入 browser worker；決定唯一 recovery / cleanup owner。API 重啟不得終止仍由 worker 處理的 job。
3. **Bun 切換分兩個檢查點**：workspace / lockfile / build 工具；服務 runtime。用真實 Stagehand 3、Playwright 1.60.0、BullMQ 5、ioredis、child-process abort/cleanup 驗證後才能宣稱相容。現有 Node/pnpm 生成 ZIP 與 verifier 子程序契約明確保留，除非另行遷移並驗證。
4. **本機 k3s + Terraform**：Terraform 管 lab 環境與 bootstrap；Kubernetes 管 frontend、API、worker、Redis、Service/Ingress、ConfigMap/Secret、PVC、資源上限與 probes。API 和 worker 共享的儲存路徑要可實際存取；不加 HA/HPA/service mesh。
5. **Health 與 metrics**：liveness 表示程序可回應；readiness 表示角色必要依賴就緒，避免 Redis 暫斷引發重啟風暴。Prometheus / Grafana 區分 system 與 pipeline；由既有 state/verification/token 資料導出，不另外造 eval 平台。Redis TTL 與 SSE 最後 50 筆不能當永久歷史；metrics 不放 URL/hash/secrets 等高基數或敏感 label。
6. **三個以上受控故障演練**：API 終止而 worker 繼續；worker 中斷／恢復；storage 或 Redis 不可用。記錄 UI、Kubernetes 行為、metric/log、是否自動恢復、人工步驟。實跑才勾選。
7. **保留 Compose 開發**；更新兩份 README 的可執行操作步驟。獨立 `video/` 非 root workspace，除非要求，不納入 runtime 遷移。

**目前狀態：評估完成，未開始部署／Bun 切換。** 本機可用 Node v25.8.0、Bun 1.3.14；這不等於 Docker Node 20 或 Bun 相容性已通過。

## 驗證與交付清單

- [x] 讀取 issue #2、現況 source 與先前 review。
- [x] 唯讀 scouts 分開追查 pipeline 與部署／前端；獨立 reviewer 複核候選。
- [x] 重現預設 CORS 問題與自癒檢查器放行額外程式檔。
- [x] R1 scoped entrypoint regression：16 passed。
- [x] R1 README 說明（`CORS_ORIGINS` 段落已加入兩份 README）。
- [x] R2 資料介面、固定程式邊界、正向／惡意／故障驗收（單元層級；未對真實 Chromium 實跑）。
- [x] R3 共用輸出邊界、canary 漏洩驗收（單元層級；外部 Redis／BullMQ 以替身取代）。
- [ ] R4 無 browser 的真實 Gherkin 解析驗收。（不在本輪範圍）
- [x] 所有變更的 typecheck / lint / tests，含 shared build 前置：2026-10-15 直接以各套件 tsc／eslint／vitest 執行，全部 exit 0；最終 backend 236 passed／5 skipped，frontend 11 passed（main 基準為 backend 134 passed）。
- [x] 變更後獨立 review 與所有 callsites／測試／文件整合：Terra 第一輪 PARTIALLY AGREE（fill_by_label 修復來源不是實際使用的 locator；自癒固定訊息不在 llm_log 白名單），兩處修正並補測試後重審 AGREE。
- [x] 提交、push、開 PR：commit `b01114d`，[PR #5](https://github.com/iskWang/PickleScout/pull/5)；PR 明列已修／未修／未跑的項目。

工具限制：本次 `pnpm --version` 被 bash policy 的 `pnpm *` 規則拒絕；不得透過 wrapper 繞過。獨立 Node/Vitest 執行已成功。完整 repo 指定 pnpm 檢查若仍受阻，需明確揭露，不能聲稱已跑。

## R2 / R3 實作介面（父代理決定）

### R2：固定 World adapter，模型只提供 JSON

- `attemptSelfHeal(state, artifactDir, errors, signal?)` 回傳資料，不回傳 files。由 verifier 讀取已生成的 `intent-spec.json`，列出可修 action locator；回應使用嚴格 schema。
- 固定 `repair.json`：
  ```json
  {"version":1,"locators":[{"method":"getByRole","value":"Submit","role":"button","selector":"[data-testid=\"submit\"]"}],"actionTimeoutMs":30000}
  ```
- `method` 只允許 `getByRole`、`getByLabel`、`getByText`；`role` 只用於 getByRole，值必須來自原 action。selector 是交給 Playwright locator 的資料字串，不插入程式碼；拒絕 XPath、空字串、過長字串、未知欄位、重複來源與原 intent 不存在的來源。
- 同一 getByText 來源若用於 assert_visible / assert_not_visible，不允許 remap，以免變更 assertion 意義。selector 修復限 click/fill/select 動作。action timeout 為 30000–45000 的整數；navigation、assertion 與 Cucumber timeout 不變。這是明確的安全限制，不宣稱支援任意 wait strategy 或 assertion 程式碼重寫。
- `CustomWorld.page` 的固定 adapter 只攔截上述 locator 方法；其餘 Page 方法綁定原 page。相符來源轉為原 page.locator(selector)，不相符則原呼叫原封不動。指派 page 時套用 action timeout；沒有 repair 時維持原行為。
- packager 初次 prepare 寫入空 repair plan；worker 每輪只寫驗證過的 repair.json，feature / steps 不重寫。ZIP 加入同一份 repair.json；world 與 verification/ZIP 使用同一模板。
- 無效模型資料：顯示固定拒絕訊息，保留原驗證失敗與既有未驗證打包行為；不可執行／打包任何模型提供的程式檔。

### R3：只限制診斷輸出，不改工作憑證

- 在 `safeLog.ts` 提供共用固定錯誤分類與事件診斷清理：未知 error / err / stack / cause 字串不外送；錯誤回傳固定安全訊息。保留既有 sensitive-field redaction。
- `redis.ts` 儲存／讀取 job 的 error 欄位，以及 SSE replay 的 error / verification.errors / llm_log 診斷，均走相同清理；內部 llm.apiKey / auth.password 必須完整保存以執行 job。
- `sse.ts` 對相同安全 event 同時 buffer 與 publish，不得 publish 原始未處理物件。不要為遮蔽而新增 Redis 查詢／秘密快取。
- worker catch / BullMQ failed handler 不再 rethrow 或記錄原始上游錯誤；固定安全訊息仍能讓 job 進 failed。Verifier 不再即時轉送任意 stdout/stderr 到 SSE；內部修復資料與外部診斷分開處理。
- 此修正不宣稱可以從一般頁面內容、screenshots 或 ZIP 自動辨識所有未知秘密；那是另外的資料保護議題。安全目標是原始例外／子程序診斷不能成為外洩通道。
