# PickleScout

> LLM-driven browser agent that explores your web app and generates a ready-to-run **Cucumber.js + Playwright** test project.

**Browse once, test forever.**

[中文版 README](README.zh-TW.md)

---

## What it does

1. **Explore** — Stagehand (Playwright + LLM) navigates your app and records an `ActionLog` of every interaction.
2. **Generate** — Two-pass LLM pipeline converts the `ActionLog` into Gherkin `.feature` files and TypeScript Playwright step definitions.
3. **Verify** — Generated tests are run once with `cucumber-js` inside the backend. If they fail, a self-healing LLM call attempts selector and timeout fixes.
4. **Package** — Everything is zipped into a standalone project you can drop into any CI/CD pipeline — zero LLM dependency at runtime.

---

## Architecture

```mermaid
graph TD
    U([User / Browser]) -->|submit URL + LLM key| FE[Frontend\nReact + Vite]
    FE -->|POST /api/jobs| API[Backend API\nFastify]
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

### Service responsibilities

| Service | Tech | Role |
|---------|------|------|
| Frontend | React 18 + Vite 5 + TypeScript | Job submission, real-time SSE display, zip download |
| Backend | Fastify 4 + Node 20 + TypeScript | REST API, SSE proxy, BullMQ worker host |
| Redis | Redis 7 | Job state store, SSE event buffer, BullMQ queue |
| Stagehand | Playwright + LLM | Browser exploration — **generation phase only** |
| Storage | Docker volume `/storage` | Screenshots, action logs, generated zips |

---

## Pipeline state machine

```mermaid
stateDiagram-v2
    [*] --> queued : POST /api/jobs
    queued --> exploring : worker picks up job
    exploring --> generating : ActionLog captured
    generating --> verifying : feature + step files written
    verifying --> completed : cucumber-js passes
    verifying --> self_healing : cucumber-js fails
    self_healing --> verifying : repaired files, retry
    self_healing --> failed : max retries exceeded
    verifying --> failed : unrecoverable error
    generating --> failed : LLM error
    exploring --> failed : browser / network error
    completed --> [*]
    failed --> [*]
```

---

## Data flow (sequence)

```mermaid
sequenceDiagram
    actor U as User
    participant F as Frontend
    participant B as Backend API
    participant W as Worker
    participant S as Stagehand
    participant L as LLM API
    participant R as Redis

    U->>F: URL + LLM config
    F->>B: POST /api/jobs
    B->>R: SET job:{hash} (status=queued)
    B-->>F: { hash }
    F->>B: GET /api/jobs/:hash/events (SSE)

    B->>W: BullMQ enqueue
    W->>R: SET status=exploring
    W->>S: explore(url)
    S-->>W: ActionLog (goto/click/fill/observe entries)

    W->>R: SET status=generating
    W->>L: Pass 1 — ActionLog → .feature files
    L-->>W: Gherkin scenarios
    W->>L: Pass 2 — .feature → IntentSpec JSON (template mapping)
    L-->>W: IntentSpec JSON
    W->>W: Assemble step files from IntentSpec + template catalog

    W->>R: SET status=verifying
    W->>W: pnpm install + cucumber-js
    alt tests pass
        W->>W: zip artifacts
        W->>R: SET status=completed
        W-->>F: SSE complete { resultUrl, summary }
    else tests fail → self-heal
        W->>R: SET status=self_healing
        W->>L: repair selectors / timeouts
        L-->>W: patched step files
        W->>W: retry cucumber-js
        W->>R: SET status=completed or failed
    end

    U->>F: click Download
    F->>B: GET /api/jobs/:hash/result
    B-->>F: result.zip
```

---

## Data model

### Redis key schema

```mermaid
graph LR
    subgraph Redis
        J["job:{hash}\n(JSON, TTL 7d)"]
        E["events:{hash}\n(List, last 50 events, TTL 7d)"]
        BQ["bull:{queue}:*\n(managed by BullMQ)"]
    end
    J -- "one-to-many" --> E
    J -- "one-to-one" --> BQ
```

| Key pattern | Type | TTL | Contents |
|---|---|---|---|
| `job:{hash}` | String (JSON) | 7 days | Full `JobState` — status, LLM config, token usage, error, hallucination flags |
| `events:{hash}` | List (JSON) | 7 days | Last 50 `StreamEvent` objects for SSE replay on reconnect |
| `bull:*` | Various | BullMQ-managed | Queue internals |

### JobState schema

```mermaid
erDiagram
    JobState {
        string hash PK
        JobStatus status
        string url
        string hint
        LLMConfig llm
        JobOptions options
        AuthConfig auth
        JobProgress progress
        TokenUsage tokenUsage
        number createdAt
        number updatedAt
        string error
        boolean hallucinationRisk
        string hallucinationReason
    }

    LLMConfig {
        LLMProvider provider
        string apiKey
        string model
        string baseURL
    }

    JobOptions {
        number maxScenarios
        number positiveRatio
        number maxSteps
        VerificationMode verificationMode
        number maxRetries
    }

    TokenUsage {
        number promptTokens
        number completionTokens
        number estimatedCostUSD
    }

    ActionLog {
        string jobHash FK
        string targetUrl
        ActionLogEntry[] entries
        string[] inferredJourneys
    }

    ActionLogEntry {
        string id
        ActionType type
        string selector
        SelectorStrategy selectorStrategy
        string value
        string text
        string screenshotPath
        number timestamp
    }

    JobState ||--o{ ActionLog : "recorded during exploration"
    ActionLog ||--|{ ActionLogEntry : "contains"
    JobState ||--|| LLMConfig : "uses"
    JobState ||--|| JobOptions : "uses"
    JobState ||--|| TokenUsage : "accumulates"
```

### SSE event types

```mermaid
graph LR
    subgraph StreamEvent types
        ST[status\njob phase change]
        SP[step\nexplorer action]
        SS[screenshot\nscreenshot URL]
        SL[llm_log\nLLM progress message]
        SU[token_usage\ndelta + cumulative]
        SV[verification\npassed / errors]
        SC[complete\nresultUrl + summary]
        SE[error\nmessage + retryable]
    end
```

---

## Generated output structure

Every job produces a self-contained zip:

```
generated-tests/
├── features/
│   ├── 01_login_flow.feature
│   └── 02_sales_order.feature
├── steps/
│   ├── common.steps.ts        ← shared navigation + login steps
│   ├── 01_login_flow.steps.ts
│   └── 02_sales_order.steps.ts
├── support/
│   ├── world.ts               ← Cucumber World (Playwright page context)
│   └── hooks.ts               ← Before/After browser lifecycle
├── cucumber.js                ← Cucumber config
├── playwright.config.ts
├── package.json               ← exact-pinned: @cucumber/cucumber@11.0.0, @playwright/test@1.60.0
├── tsconfig.json
├── .github/workflows/e2e.yml  ← ready-to-use GitHub Actions workflow
├── .env.example
└── README.md
```

---

## Quick start

### Prerequisites

- Docker + Docker Compose
- An API key for one of: OpenAI, OpenRouter, Google Gemini, or any OpenAI-compatible endpoint

### Run locally

```bash
git clone https://github.com/iskWang/PickleScout
cd picklescout
docker compose up
```

Open [http://localhost:5173](http://localhost:5173).

### Run the generated tests

```bash
unzip result.zip -d my-tests
cd my-tests
npm install
npx playwright install chromium --with-deps
cp .env.example .env   # set BASE_URL, APP_USER, APP_PASS
npm test
```

---

## Configuration

| Field | Description | Default |
|---|---|---|
| **URL** | Target web app to explore | — |
| **Hint** | Optional plain-language description of key user flows | — |
| **LLM Provider** | `openai` · `openrouter` · `gemini` · `custom` | — |
| **Model** | Any model supported by the provider | — |
| **Max scenarios** | Total Gherkin scenarios to generate | 10 |
| **Positive ratio** | Fraction of happy-path vs negative scenarios | 0.8 |
| **Verification mode** | `syntax-only` · `smoke` · `full` | `smoke` |
| **Auth** | Optional form-based login (URL, username, password, selectors) | — |

### Supported LLM providers

| Provider | Notes |
|---|---|
| OpenAI | `gpt-4o`, `gpt-4o-mini`, etc. |
| OpenRouter | Any model on openrouter.ai |
| Google Gemini | Via OpenAI-compatible endpoint |
| Custom | Any OpenAI-compatible base URL |

> **Note:** Anthropic (Claude) is supported for exploration (via OpenRouter) but not directly — the OpenAI SDK is used for generation and self-healing.

---

## Self-test

After modifying any worker file, run the built-in pipeline smoke test:

```bash
./scripts/self-test.sh           # smoke — happy path
./scripts/self-test.sh negative  # hallucination guard
./scripts/self-test.sh all       # both
```

See [`.agents/self-test.md`](.agents/self-test.md) for assertion semantics and failure mode lookup table.

---

## Development

```bash
# Start all services
docker compose up

# Frontend only (hot-reload)
pnpm dev:frontend

# Backend only (ts-node-dev watch)
pnpm dev:backend

# Typecheck all workspaces
pnpm -r typecheck

# Lint
pnpm -r lint

# Unit tests
pnpm -r test
```

### Monorepo layout

```
packages/
  shared/    # @picklescout/shared — types shared by frontend + backend
  frontend/  # React + Vite
  backend/   # Fastify + Stagehand + BullMQ
.agents/     # Agent context docs (architecture, specs, self-test)
scripts/     # self-test.sh
docs/        # PRD, progress log, LLM provider notes
```

---

## License

MIT
