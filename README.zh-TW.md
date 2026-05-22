<div align="center">
  <img src="packages/frontend/public/logo.png" alt="PickleScout logo" width="120" />
  <br/>
  <img src="packages/frontend/public/slogan.png" alt="PickleScout — Web Scraping & Data Navigation" width="420" />
</div>

# PickleScout

> LLM 驅動的瀏覽器代理人，自動探索你的 Web 應用並產生即用的 **Cucumber.js + Playwright** 測試專案。

**瀏覽一次，測試永遠。**

[English README](README.md)

<div align="center">
  <video src="demo.mp4" controls width="720" title="PickleScout Demo — 瀏覽一次，測試永遠"></video>
</div>

---

## 它做什麼

1. **探索** — Stagehand（Playwright + LLM）自動瀏覽你的應用，記錄每一個互動為 `ActionLog`。
2. **生成** — 雙階段 LLM 流水線將 `ActionLog` 轉換為 Gherkin `.feature` 檔與 TypeScript Playwright 步驟定義。
3. **驗證** — 在後端用 `cucumber-js` 執行一次生成的測試。若失敗，自我修復 LLM 呼叫會嘗試修正 selector 和 timeout。
4. **打包** — 所有檔案打包成獨立 zip，可直接放入任何 CI/CD 流水線——執行時零 LLM 依賴。

---

## 架構

```mermaid
graph TD
    U([使用者 / 瀏覽器]) -->|送出 URL + LLM Key| FE[前端\nReact + Vite]
    FE -->|POST /api/jobs| API[後端 API\nFastify]
    FE -->|SSE /api/jobs/:hash/events| API
    API -->|enqueue| BQ[BullMQ]
    BQ -->|dequeue| WK[Worker]
    WK -->|explore| SH[Stagehand\nChromium]
    SH -->|ActionLog| WK
    WK -->|Pass 1 + 2| LLM[LLM API\nOpenAI / OpenRouter\n/ Gemini / Custom]
    LLM -->|feature + step files| WK
    WK -->|cucumber-js| VF[Verifier]
    VF -->|VerificationResult| WK
    WK -->|self-heal if needed| LLM
    WK -->|result.zip| FS[storage volume]
    WK -->|job state| RD[(Redis)]
    BQ --- RD
    API -->|GET /result| FS

    style SH fill:#8b5cf6,color:#fff
    style LLM fill:#f59e0b,color:#fff
    style RD fill:#dc2626,color:#fff
    style FS fill:#059669,color:#fff
```

### 服務職責

| 服務 | 技術 | 職責 |
|------|------|------|
| 前端 | React 18 + Vite 5 + TypeScript | 工作提交、即時 SSE 顯示、zip 下載 |
| 後端 | Fastify 4 + Node 20 + TypeScript | REST API、SSE 代理、BullMQ worker |
| Redis | Redis 7 | Job 狀態儲存、SSE 事件緩衝、BullMQ 佇列 |
| Stagehand | Playwright + LLM | 瀏覽器探索——**僅在生成階段使用** |
| Storage | Docker volume `/storage` | 截圖、action log、生成的 zip |

---

## 流水線狀態機

```mermaid
stateDiagram-v2
    [*] --> queued : POST /api/jobs
    queued --> exploring : worker 領取工作
    exploring --> generating : ActionLog 擷取完成
    generating --> verifying : feature + step 檔案寫入完畢
    verifying --> completed : cucumber-js 通過
    verifying --> self_healing : cucumber-js 失敗
    self_healing --> verifying : 修復後重試
    self_healing --> failed : 超過最大重試次數
    verifying --> failed : 無法恢復的錯誤
    generating --> failed : LLM 錯誤
    exploring --> failed : 瀏覽器 / 網路錯誤
    completed --> [*]
    failed --> [*]
```

---

## 資料流（循序圖）

```mermaid
sequenceDiagram
    actor U as 使用者
    participant F as 前端
    participant B as 後端 API
    participant W as Worker
    participant S as Stagehand
    participant L as LLM API
    participant R as Redis

    U->>F: URL + LLM 設定
    F->>B: POST /api/jobs
    B->>R: SET job:{hash} (status=queued)
    B-->>F: { hash }
    F->>B: GET /api/jobs/:hash/events (SSE)

    B->>W: BullMQ enqueue
    W->>R: SET status=exploring
    W->>S: explore(url)
    S-->>W: ActionLog (goto/click/fill/observe 條目)

    W->>R: SET status=generating
    W->>L: Pass 1 — ActionLog → .feature 檔
    L-->>W: Gherkin 場景
    W->>L: Pass 2 — .feature → IntentSpec JSON（模板映射）
    L-->>W: IntentSpec JSON
    W->>W: 從 IntentSpec + 模板目錄組裝步驟檔

    W->>R: SET status=verifying
    W->>W: pnpm install + cucumber-js
    alt 測試通過
        W->>W: 打包 zip
        W->>R: SET status=completed
        W-->>F: SSE complete { resultUrl, summary }
    else 測試失敗 → 自我修復
        W->>R: SET status=self_healing
        W->>L: 修復 selector / timeout
        L-->>W: 修補後的步驟檔
        W->>W: 重新執行 cucumber-js
        W->>R: SET status=completed 或 failed
    end

    U->>F: 點擊下載
    F->>B: GET /api/jobs/:hash/result
    B-->>F: result.zip
```

---

## 輸出結構

每個工作產生一個自包含的 zip：

```
generated-tests/
├── features/
│   ├── 01_login_flow.feature
│   └── 02_sales_order.feature
├── steps/
│   ├── 01_login_flow.steps.ts
│   └── 02_sales_order.steps.ts
├── support/
│   ├── world.ts               ← Cucumber World（Playwright page context）
│   └── hooks.ts               ← Before/After 瀏覽器生命週期
├── cucumber.js                ← Cucumber 設定
├── playwright.config.ts
├── package.json               ← 精確鎖版：@cucumber/cucumber@11.0.0、@playwright/test@1.60.0
├── tsconfig.json
├── .github/workflows/e2e.yml  ← 即用的 GitHub Actions workflow
├── .env.example
└── README.md
```

---

## 快速開始

### 前置需求

- Docker + Docker Compose
- 以下任一 LLM 的 API Key：OpenRouter 或任何 OpenAI 相容端點

### 本機執行

```bash
git clone https://github.com/iskWang/PickleScout
cd PickleScout
docker compose up
```

開啟 [http://localhost:5173](http://localhost:5173)。

### 執行生成的測試

```bash
unzip result.zip -d my-tests
cd my-tests
npm install
npx playwright install chromium --with-deps
cp .env.example .env   # 設定 BASE_URL、APP_USER、APP_PASS
npm test
```

---

## 設定參數

| 欄位 | 說明 | 預設 |
|------|------|------|
| **URL** | 目標 Web 應用的網址 | — |
| **Hint** | 可選的自然語言描述，說明主要使用者流程 | — |
| **LLM Provider** | `openrouter` · `custom` | — |
| **Model** | 該 provider 支援的任何模型 | — |
| **Max scenarios** | 生成的 Gherkin 場景總數上限 | 10 |
| **Positive ratio** | 正向路徑 vs 負向場景的比例 | 0.8 |
| **Verification mode** | `syntax-only` · `smoke` · `full` | `smoke` |
| **Auth** | 可選的表單登入（URL、帳號、密碼、selector） | — |

### 支援的 LLM Provider

| Provider | 說明 |
|---|---|
| OpenRouter | openrouter.ai 上的任何模型（目前主要測試 `google/gemini-3.1-flash-lite-preview`） |
| Custom | 任何 OpenAI 相容的 base URL |

> **注意：** OpenAI、Anthropic、Google Gemini 直接 API 支援尚在開發中，目前 UI 顯示為「coming soon」。

---

## 開發

```bash
# 啟動所有服務
docker compose up

# 前端（熱重載）
pnpm dev:frontend

# 後端（ts-node-dev watch）
pnpm dev:backend

# 所有 workspace typecheck
pnpm -r typecheck

# Lint
pnpm -r lint

# 單元測試
pnpm -r test
```

### Monorepo 結構

```
packages/
  shared/    # @picklescout/shared — 前後端共用型別
  frontend/  # React + Vite
  backend/   # Fastify + Stagehand + BullMQ
.agents/     # Agent context 文件（架構、規格、self-test）
scripts/     # self-test.sh
docs/        # PRD、進度日誌、LLM provider 說明
```

---

## License

MIT
