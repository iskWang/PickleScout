# PickleScout 全專案審查

## 結論

本輪以 HEAD `5dfca51` 為基準，確認的 8 項 finding（3 項 P1、5 項 P2）均已修正並完成目前可執行的驗證。風險集中在工作狀態一致性、前端終態呈現、驗證關卡，以及產出物與重試流程的一致性。

本報告保留原始審查基準、觸發條件、證據與影響，並在各 finding 標示目前修正狀態。兩輪獨立 spec/quality review 的最終結果均無 blocking findings；Docker compose smoke 與完整建立 Job／LLM E2E 已完成，尚未執行的是 live browser E2E，詳見「修正後驗證」。


## 範圍與基準

- 審查對象：HEAD `5dfca51` 的 PickleScout 全專案。
- 產品流程範圍：Explore → Generate（含 Pass 2）→ Verify/self-heal → Package，以及前端工作頁面、SSE、產出專案 CI。
- 前次審查文件：`.agents/review-findings.md`。
- 本輪為靜態審查；已逐項親讀 HEAD 原始碼，並對候選進行獨立二次驗證與去重。

## 與前次審查的關係

前次審查日期為 2026-05-13，記錄於 `.agents/review-findings.md`，固定點為 `2103ea6`、`fc771e6`、`4ebf10e`，並記錄 26 項修正。該文件也列出當時尚未審查的 `worker/index.ts`、`worker/packager.ts`、`routes/download.ts` 與全部前端檔案。

本輪 findings 以目前 HEAD 為準，不重述前次已記錄的修正。P1 #1 延伸了前次 Open Question #1，但確認的問題是終態被覆寫為 `completed`，不是單純「取消後工作仍繼續執行」。P2 #3 與前次 `stream.ts` 的 cleanup 修正相鄰，但觸發根因不同：本輪問題是 `close` 監聽器註冊過晚。

## 優先級定義

- **P1**：會使取消或終態失效、讓核心驗證關卡恆定失敗，或造成使用者看見與後端不一致的工作結果；應先處理。
- **P2**：會使重試、資源釋放、產出 CI、資料一致性或 provider 設定在明確條件下失效；次於 P1，但仍需排入修正。
## 修正狀態

| Finding | 狀態 | 已採修正落地點 |
|---|---|---|
| P1-1 | 已修正 | `redis.ts` 終態守衛；`worker/index.ts` 在各階段與 final status 前重讀狀態 |
| P1-2 | 已修正 | `JobDetailPage.tsx` 保留輪詢 status/error 並處理 HTTP 失敗；`startup.ts` 補送終態 SSE |
| P1-3 | 已修正 | `scripts/self-test.sh` 與 `scripts/phase0-validate.sh` 改用實際 `steps/*.ts`/`*.js` |
| P2-1 | 已修正 | `generator.ts` 的 `rerunPass2` 同步重產 features、steps 與 intent spec，`index.ts` 更新 artifact |
| P2-2 | 已修正 | `assembler.ts` 以 Cucumber 字串引用與跳脫處理插值值，並補行為測試 |
| P2-3 | 已修正 | `stream.ts` 在所有 await 前註冊 close cleanup，並加 closed guard |
| P2-4 | 已修正 | `github-workflow.yml.template` 改用 `pnpm install --no-frozen-lockfile` |
| P2-5 | 已修正 | `JobFormPage.tsx` 對 custom provider 強制 Base URL；輸入欄位標記 required |


## Findings

### P1-1 [已修正]：processJob 可能把取消或失敗的工作覆寫為 completed

- **位置**：`packages/backend/src/worker/index.ts:244-247`
- **觸發條件**：在 exploring、generating、verifying 或 self-healing 期間取消工作；或後端重啟後，BullMQ stalled job 重派並重新進入 `processJob`。
- **證據**：`redis.ts:67-75` 的 `updateJobStatus` 沒有終態守衛，patch 會直接覆蓋狀態。DELETE handler 先在 `jobs.ts:167` 寫入 `failed` 與 `Cancelled by user`，但 `processJob` 在階段之間不重讀狀態；最後 `index.ts:245-247` 無條件寫入 `finalStatus`。探索器雖在 `explorer.ts:239-243` 讀取消旗標並跳出迴圈，仍會在 `explorer.ts:346-368` 正常組合結果並返回。
- **影響**：取消後 LLM、瀏覽器與安裝流程仍可能繼續執行並產生成本；Redis 狀態可能由 `failed` 翻回 `completed`，輪詢結果與使用者已收到的取消錯誤不一致，且可能產出 `result.zip`。
- **已採修正**：`redis.ts` 的 `updateJobStatus` 對既有終態保留 lifecycle status；`worker/index.ts` 在開始、探索後、生成前後、self-heal 迴圈及寫入 final status 前重讀 job state，若已是終態便立即返回且不覆寫。
- **修後驗證**：啟動工作，在 generating 階段 DELETE；之後 GET `/api/jobs/:hash` 應維持 `failed`／`Cancelled by user`，不可變成 `completed`。

### P1-2 [已修正]：前端丟棄輪詢的 status/error，死掉的工作仍顯示進行中

- **位置**：`packages/frontend/src/pages/JobDetailPage.tsx:27-36`
- **觸發條件**：後端重啟後將非終態工作標成 failed，但沒有補發終態 SSE；或使用過期／不存在的 hash。
- **證據**：`applyJobData`（27-32）只取 URL 與 hallucination 欄位，丟掉 `status`、`error`。兩處 fetch（36-39、45-49）只呼叫 `r.json()`，沒有檢查 `r.ok`。渲染條件在 `JobDetailPage.tsx:137` 為 `(isActive || (!isCompleted && !isFailed))`；當 stream status 為 null 時仍會渲染進度面板。後端重啟標記見 `startup.ts:45-49`，SSE 終態 cleanup 見 `stream.ts:100-104`。
- **影響**：頁面可能永久停在 exploring/generating，Cancel 仍可用，EventSource 約每 3 秒無限重連。過期 hash 的 404 JSON 也可能被當作正常資料，顯示空的進行中面板，不符合 not-found／expired 行為。
- **已採修正**：`JobDetailPage.tsx` 的兩處 fetch 檢查 `r.ok`，404 顯示 not-found；`applyJobData` 保存輪詢的 `status` 與 `error`，在 stream 沒有值時作為 fallback。`startup.ts` 標記失敗時補送 error 與 status SSE 事件。
- **修後驗證**：送出工作、重啟後端並重整詳情頁；數秒內應顯示 failed 與 `Service restarted`，EventSource 不再無限重連。過期 hash 應顯示 not-found／expired 狀態。

### P1-3 [已修正]：兩個 shell 驗證關卡比對永不產生的 `*.steps.ts`

- **位置**：`scripts/self-test.sh:159-163`；同根因：`scripts/phase0-validate.sh:111`
- **觸發條件**：執行任一腳本，與 pipeline 是否成功無關。
- **證據**：產生 step 檔名的唯一位置 `packages/backend/src/worker/assembler.ts:47` 固定回傳 `steps.ts`；`packager.ts:160` 因而打包為 `steps/steps.ts`。但 `self-test.sh:160` 要求 `steps/.*\.steps\.ts`，`phase0-validate.sh:111` 要求 `*.steps.ts` 或 `*.steps.js`；`steps.ts` 不含前置句點。
- **影響**：`self-test.sh` 的 ZIP 預期檔案斷言恆失敗並 exit 1。`phase0-validate.sh` 的步驟數恆為 0，在到達真正的 `pnpm exec cucumber-js --dry-run` 前退出，Phase 0 關卡無法驗證 step resolution。
- **已採修正**：`self-test.sh` 改比對 `steps/.*\.ts`；`phase0-validate.sh` 改在 `$OUT_DIR/steps` 計數 `.ts`/`.js` 檔案；同步更新 `.agents/self-test.md` 與 README 的檔名說明。
- **修後驗證**：對成功產出的 zip 執行兩個腳本；self-test 應通過 zip 斷言，phase0 應實際執行到 `cucumber-js --dry-run`。

### P2-1 [已修正]：rerunPass2 不重產 feature，重試產出不同源檔案

- **位置**：`packages/backend/src/worker/generator.ts:556-562`
- **觸發條件**：首次 `checkStepResolution` 回報 unresolved 或 ambiguous（`index.ts:126`）。
- **證據**：正常路徑 `generator.ts:522-527` 以同一份 IntentSpec 同時寫入 features 與 steps。`rerunPass2` 卻對新的 LLM IntentSpec 只呼叫 `assembleStepFiles`（556），只覆寫 `intent-spec.json`（559）與 steps（560-562），features 保留舊內容。`index.ts:136` 只更新 `currentStepFiles`，`index.ts:241` 以舊 artifact 加新 steps 打包。
- **影響**：若 feature 本身造成解析失敗，重試不會改變失敗來源，只多一次 LLM 呼叫；若重試偶然通過，zip 內 features、steps、intent-spec.json 來自不同 IntentSpec，違反一致性。
- **已採修正**：`generator.ts` 的 `rerunPass2` 以新的 IntentSpec 同步呼叫並寫回 `assembleFeatureFiles` 與 `assembleStepFiles`，回傳 featureFiles、stepFiles 與 intentSpec；`index.ts` 同步更新 artifact 的 featureFiles。
- **修後驗證**：構造一次 step resolution 失敗；確認重試後 features 有更新，且 zip 內 features、steps、intent-spec.json 同源。

### P2-2 [已修正]：Gherkin 參數插值未跳脫引號與 `$` 樣式

- **位置**：`packages/backend/src/worker/assembler.ts:9-16`
- **觸發條件**：LLM 回傳的 params 值包含雙引號或 `$&`，例如含引號的按鈕文案、提示文字或標題。
- **證據**：`fillStepPattern` 以 `pattern.replace('{string}', `"${value}"`)` 直接包值，未跳脫雙引號，也未避免 replacement string 的 `$` 展開。產出由 `assembleFeatureFiles`（`assembler.ts:68`）使用；verifier 的 `{string}` regex 在 `verifier.ts:218-229` 以整行錨定比對。
- **影響**：產出的 `.feature` 步驟可能語法損壞，無法匹配 step regex，觸發結構上無法修好的 Pass 2 重試，最後工作失敗。
- **已採修正**：`assembler.ts` 以 Cucumber 字串引用規則處理值，跳脫反斜線與所選引號，並以函式 replacer 插入，避免 `$` replacement semantics；補上含引號與 `$&` 的 assembler 行為測試。
- **修後驗證**：以 `He said "hi"` 與含 `$&` 的 params 呼叫 `assembleFeatureFiles`；輸出應能被 verifier 的 `cucumberExpressionToRegex` 匹配。

### P2-3 [已修正]：SSE close 監聽器註冊過晚，早斷線會洩漏 Redis 連線與 interval

- **位置**：`packages/backend/src/routes/stream.ts:106-112`
- **觸發條件**：SSE 建立後、`request.raw.on('close', cleanup)` 註冊前，使用者重整、關閉分頁或 abort；Redis 延遲會放大此視窗。
- **證據**：回應標頭在 `stream.ts:47` 已送出；專用 Redis connection 於 `stream.ts:60` 建立。`request.raw.on('close', cleanup)` 到 `stream.ts:112` 才註冊，其前有 `subscribe`（75）、`getSseEvents`（94）、`getJobState`（100）三個 await。Node 不會重播已發生的 close 事件，因此 cleanup 不會被呼叫。
- **影響**：每次早斷線可能留下 Redis 連線及 25 秒 heartbeat interval；反覆連線可耗盡 Redis maxclients，並持續對已關閉的 socket 寫入。
- **已採修正**：`stream.ts` 將 `request.raw.on('close', cleanup)` 移到所有 await 前，並在 subscribe、事件讀取、狀態讀取及 heartbeat write 前檢查 `closed`。
- **修後驗證**：連線至 `/api/jobs/:hash/stream` 後立即 abort 數十次；Redis CLIENT LIST 數量應回穩，不應持續成長。

### P2-4 [已修正]：產出專案的 GitHub Actions 使用 frozen install，但 zip 沒有 lockfile

- **位置**：`packages/backend/src/templates/github-workflow.yml.template:21-27`（安裝命令在 `:26`）
- **觸發條件**：任何產出專案第一次執行 GitHub Actions CI。
- **證據**：workflow 以 `pnpm/action-setup@v4` 固定 pnpm 9（21-23），接著在 26 執行裸的 `pnpm install`。`packager.ts:154-185` 打包 features、steps、support、設定檔、package.json 等，但沒有 `pnpm-lock.yaml`。CI 環境的 frozen install 找不到 lockfile 會以 `ERR_PNPM_NO_LOCKFILE` 中止。
- **影響**：產出專案的 GitHub Actions workflow 在安裝階段失敗，尚未進入 Chromium 或測試步驟；後端非 CI verifier 的 `pnpm install --ignore-scripts` 不會覆蓋這條路徑。
- **已採修正**：`github-workflow.yml.template` 將安裝命令改為 `pnpm install --no-frozen-lockfile`，讓沒有 lockfile 的產出 zip 可進入後續 CI 步驟。
- **修後驗證**：解壓產出 zip，在 `CI=true` 環境執行 `pnpm install`；應完成安裝並進入後續步驟。

### P2-5 [已修正]：custom provider 未填 Base URL 仍可送出，金鑰可能送至 api.openai.com

- **位置**：`packages/frontend/src/pages/JobFormPage.tsx:178-181`
- **觸發條件**：選擇 `Custom (OpenAI-compatible)`，填入 model，Base URL 留空後送出。
- **證據**：送出按鈕 disabled 運算式（178-181）只檢查 urlValid、apiKey、model，不檢查 custom provider 的 baseURL；`handleSubmit` 的早退條件也相同（71）。`ProviderSelector/index.tsx:62` 切換 custom 時將 baseURL 設為 undefined，Base URL input（110-117）沒有 required 或驗證。後端 schema 的 baseURL optional；`generator.ts:47` 只有在 custom 且 baseURL 有值時才覆寫 client baseURL，空值會使用 `api.openai.com` 預設值。
- **影響**：請求可能以 201 接受，第三方 API key 被送至非預期的 OpenAI endpoint；之後錯誤又指向錯誤 provider，難以診斷。
- **已採修正**：`JobFormPage.tsx` 將 custom provider 的非空 Base URL 納入送出按鈕 disabled 與 `handleSubmit` 早退條件；`ProviderSelector` 的 Base URL input 加上 `required` 與 `aria-required`。
- **修後驗證**：選 custom 並留空 Base URL；送出按鈕應保持 disabled，且不可建立 job。

## 原始建議修正順序（歷史）

1. **P1-1**：先建立終態不可覆寫的後端狀態邊界，避免取消／重啟後狀態反轉。
2. **P1-2**：同步修正前端輪詢與重啟後終態呈現，避免使用者看見虛假的進行中狀態。
3. **P1-3**：修正兩個 shell 關卡的檔名判斷，恢復驗證訊號。
4. **P2-3**：提前註冊 SSE cleanup，避免連線與 heartbeat 累積。
5. **P2-1、P2-2**：先修正重試的 features/steps 同源性，再修正插值跳脫，確保 Pass 2 能處理真實參數。
6. **P2-4、P2-5**：修正產出專案 CI 安裝契約與 custom provider 的送出閘門。

## 修正後驗證

- `bun run typecheck`：exit 0。
- `bun run lint`：exit 0；backend 仍有 4 個既有 warnings：`reconciler.ts` 2 個 console、`generator.test.ts` 1 個 any、`worker/index.ts` 1 個 console。
- `bun run test`：exit 0；backend 134 passed、5 skipped（fixture tests），frontend 11 passed。
- `bun run build`：exit 0。
- Docker compose smoke：images build 與 containers startup 成功；Redis healthy；backend `3100→container3000`，GET `/health` 回 200；frontend `5175→container5173`，HEAD `/` 回 200；startup logs 無 screenshots root warning。
- 預設 port 可由 `BACKEND_PORT`／`FRONTEND_PORT` 覆寫。
- 兩輪獨立 spec/quality review 的最終結果：無 blocking findings。
- 完整建立 Job／LLM E2E：PASS。job `3bDX0F7tvfWs7EIaLUeM9` completed；3 scenarios（`MAX_SCENARIOS=3`），每個 scenario 均有 `Then`；ZIP HTTP 200、11 entries、integrity OK；all step patterns covered；exact pins；Cucumber dry-run PASS（3 scenarios／12 steps，skipped as expected）。
- 尚未執行 live browser E2E。

