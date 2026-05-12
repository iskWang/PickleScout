# PickleScout — Product Requirements Document

> Sends a pickle into the wild. Returns with Gherkin specs.

PickleScout is an LLM-driven browser agent that explores web-based business applications and automatically generates self-contained Cucumber.js + Playwright test projects — ready to drop into CI/CD.

---

## Document History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-05-11 | Initial release |
| 1.1 | 2026-05-12 | Translated to English. Renamed to PickleScout. Tightened product scope. Added Action Log schema, self-healing scope, verification modes, URL normalization, SSE Last-Event-ID, version pinning, optional `auth` in MVP. |

---

## 1. Overview

### 1.1 Goal

Provide a web interface where a user submits a URL pointing to a web-based business application. The system uses an LLM-driven browser agent to explore CRUD-style user journeys and produces a self-contained Cucumber.js + Playwright test project that can run in any CI/CD environment.

### 1.2 Product Boundary

**Suitable targets**

- ERP systems (Odoo, ERPNext, Dolibarr)
- CRM systems (EspoCRM, SuiteCRM)
- Admin dashboards
- Traditional SSR or SPA business systems with form-driven CRUD workflows
- Targets must be reachable from the self-host deployment (publicly accessible URLs, or internal services on the same network)

**Not recommended**

- Marketing or landing pages
- Highly animated consumer SaaS
- Infinite-scroll applications
- Anti-bot protected sites (Cloudflare challenge, hCaptcha, reCAPTCHA)
- Sites with auth gateways requiring OAuth, SSO, MFA, or SAML

### 1.3 Core Value

- Reduces the barrier to writing E2E tests — non-technical stakeholders can read the generated `.feature` files
- Reduces selector maintenance cost — the LLM agent verifies selector reachability inside a real browser during generation
- Generated artifacts are deterministic at execution time. The generation phase itself is probabilistic due to LLM-driven exploration.

### 1.4 Target Users

- Individual developers and small QA teams
- Engineers building smoke tests for existing business applications
- Researchers validating the feasibility of LLM-generated tests

### 1.5 Deployment Scenario

- Personal self-host on Mac Mini (16 GB)
- Single-host Docker Compose deployment
- Out of scope: multi-tenant, cloud, Kubernetes

---

## 2. System Architecture

### 2.1 Two-Phase Architecture

```
┌─────────────────────────────────────────────┐
│  Phase 1: Generation (Web App, one-off)      │
│                                              │
│  Frontend ──→ Backend ──→ Stagehand ──→ LLM  │
│                            │                 │
│                            └─→ Chromium      │
│                                              │
│  Output: Cucumber + Playwright project (zip) │
│  Property: deterministic at execution time   │
└─────────────────────────────────────────────┘
                    ↓
           [User downloads / commits]
                    ↓
┌─────────────────────────────────────────────┐
│  Phase 2: Execution (CI/CD, repeatable)      │
│                                              │
│  GitHub Actions ──→ Cucumber + Playwright    │
│                          ↓                   │
│                    test reports (JUnit/HTML) │
│                                              │
│  Property: standard toolchain, no LLM        │
└─────────────────────────────────────────────┘
```

**Key principle**: the output project's `package.json` contains no LLM SDK and no Stagehand dependency. Stagehand is only used during generation to translate "natural-language intent" into "concrete selector + action". The final artifact uses Playwright APIs only.

### 2.2 Technology Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Frontend | React + Vite + TypeScript | Developer productivity |
| Backend | Node.js + TypeScript (single service) | Same ecosystem as Stagehand |
| Browser automation | Stagehand v3 (built on Playwright) | LLM-native primitives, automatic self-healing |
| Browser engine | Chromium only | Unified execution environment |
| LLM | OpenAI-compatible API (OpenRouter, OpenAI priority) | Provider flexibility |
| Queue / State | Redis 7 + bullmq | Simple, lightweight |
| Test framework (output) | Cucumber.js + Playwright | Gherkin for stakeholders, Playwright for stability |
| Containerization | Docker Compose | Sufficient for self-host |

### 2.3 Container Layout

```yaml
services:
  frontend:
    build: ./frontend
    ports: ['5173:5173']

  backend:
    build: ./backend
    ports: ['3000:3000']
    environment:
      REDIS_URL: redis://redis:6379
      MAX_CONCURRENT_JOBS: 2
      STORAGE_DIR: /storage
      JOB_TTL_DAYS: 7
    volumes:
      - storage:/storage
    depends_on: [redis]

  redis:
    image: redis:7-alpine
    command: redis-server --save 60 1
    # Internal network only — never bind to host port in production
    volumes: [redis-data:/data]

volumes:
  storage:
  redis-data:
```

**Security note**: Redis must not expose its port to the host or external networks. It is reachable only on the internal Docker network from the backend.

---

## 3. Functional Requirements

### 3.1 LLM Provider Abstraction

#### Supported providers

| Provider | baseURL | Default model | Stagehand integration |
|----------|---------|---------------|----------------------|
| OpenAI | `api.openai.com/v1` | `gpt-5.5` | Native |
| OpenRouter | `openrouter.ai/api/v1` | `anthropic/claude-haiku-4.5` | `CustomOpenAIClient` (workaround required) |
| Anthropic | `api.anthropic.com` | `claude-haiku-4.5` | Native |
| Google Gemini | `generativelanguage.googleapis.com/v1beta` | `gemini-2.5-flash` | Native |
| Custom (OpenAI-compatible) | User input | User input | `CustomOpenAIClient` |

**MVP priority**: OpenAI + OpenRouter. Others are nice-to-have.

#### Model constraints

- Must support structured output / function calling
- The UI lists known-working models per provider to prevent users from selecting incompatible options
- Custom provider shows a warning: "Verify that this model supports structured output."
- Ollama small models (< 32 B parameters) are flagged as "experimental, not recommended."

### 3.2 Generation Flow

```
1. User submits URL + LLM config + options on /
2. POST /api/jobs → returns jobHash
3. Redirect to /jobs/:jobHash
4. SSE connection to /api/jobs/:jobHash/stream receives progress
5. Stagehand agent explores the target → ActionLog
6. Two-pass LLM generation:
   Pass 1: action_log → .feature (Gherkin)
   Pass 2: action_log + .feature → .steps.ts
7. (Optional) Verifier runs Cucumber + Playwright once
8. On failure, self-heal up to maxRetries
9. Package output as zip, status becomes `completed`
10. User downloads
```

### 3.3 Execution Flow (CI/CD)

The user commits the generated artifact into their own repository and runs it via GitHub Actions (or any CI):

```yaml
# .github/workflows/e2e.yml
name: E2E Tests
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }
  schedule: [{ cron: '0 2 * * *' }]

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - run: pnpm install --frozen-lockfile
      - run: npx playwright install chromium --with-deps
      - run: pnpm test
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: e2e-report, path: reports/ }
```

The execution phase involves no LLM and no Stagehand.

### 3.4 Self-Healing Scope

When verification fails, the self-healing pass may modify only:

**Allowed**
- Selector replacement (e.g. fall back from CSS class to `aria-label`)
- Timeout adjustment (extend `waitForSelector` durations)
- Wait strategy adjustment (replace `networkidle` with explicit element wait)
- Assertion refinement (tighten or loosen a regex while preserving intent)

**Disallowed**
- Changing scenario intent or business meaning
- Removing assertions
- Modifying the text of feature steps (the Gherkin scenario is frozen after Pass 1)
- Silently removing failed scenarios

A failed scenario that cannot be healed within `maxRetries` is kept in the output with a `@unhealed` tag in the feature file and reported in the final summary.

### 3.5 Verification Modes

To accommodate Mac Mini resource constraints, the verifier supports three modes selectable via the request options:

| Mode | Behavior | When to use |
|------|----------|-------------|
| `syntax-only` | Parse `.feature` + compile `.steps.ts` only; do not launch browser | Fast feedback, no browser cost |
| `smoke` (default) | Run each scenario once, no retry on flake | Default for MVP |
| `full` | Run twice on flake before declaring failure | Higher confidence, more time |

### 3.6 Flaky Test Policy

- A scenario that fails verification is rerun once before triggering self-healing (in `full` mode only)
- CSS animations are disabled on the page where possible: `page.addStyleTag({ content: '* { animation-duration: 0s !important; transition-duration: 0s !important; }' })`
- Prefer explicit element-state assertions over `networkidle` waits in generated steps

### 3.7 Browser Isolation

- Each verification run uses a freshly created `browser.newContext()`
- All `storageState`, cookies, and profile data are destroyed after the job completes
- No browser data persists between jobs

---

## 4. API Contract

### 4.1 Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/jobs` | Create a generation job |
| `GET` | `/api/jobs/:hash` | Poll job status (fallback for SSE) |
| `GET` | `/api/jobs/:hash/stream` | SSE event stream |
| `GET` | `/api/jobs/:hash/result` | Download output zip |
| `GET` | `/api/jobs/:hash/result?unverified=true` | Download unverified output (on failure) |
| `DELETE` | `/api/jobs/:hash` | Cancel or remove a job |

### 4.2 Request and Response Schemas

```ts
// POST /api/jobs request body
interface CreateJobRequest {
  url: string;
  hint?: string;                  // e.g. "Focus on login and order creation"
  auth?: AuthConfig;              // optional, form-based only
  llm: {
    provider: 'openai' | 'openrouter' | 'anthropic' | 'gemini' | 'custom';
    apiKey: string;
    model: string;
    baseURL?: string;             // required only when provider = 'custom'
  };
  options: {
    maxScenarios: number;         // 1-10, default 10
    positiveRatio: number;        // 0.0-1.0, default 0.6
    maxSteps: number;             // agent exploration cap, default 30
    verificationMode: 'syntax-only' | 'smoke' | 'full';  // default 'smoke'
    maxRetries: number;           // self-healing retry cap, default 2
  };
}

interface AuthConfig {
  type: 'form';                   // only 'form' supported in MVP
  loginUrl: string;
  username: string;
  password: string;
  usernameSelector?: string;      // optional; LLM infers when omitted
  passwordSelector?: string;
  submitSelector?: string;
}

// POST /api/jobs response
interface CreateJobResponse {
  hash: string;                   // nanoid(21)
  status: JobStatus;
  createdAt: number;
}

type JobStatus =
  | 'queued'
  | 'exploring'
  | 'generating'
  | 'verifying'
  | 'self_healing'
  | 'completed'
  | 'failed';
```

**Scope of `auth`**:
- Form-based credentials only (`<input>` fields and a submit button)
- No OAuth, SSO, MFA, SAML, or any auth-gateway flow
- Credentials follow the same storage policy as `llm.apiKey` (Redis with TTL, redacted from logs)

### 4.3 URL Normalization

Before persisting and processing, URLs are normalized:

- Trim trailing slash unless the URL is a bare host
- Lowercase the scheme and host
- Strip URL fragments (`#...`)
- Preserve querystring as-is (order significant)
- Reject `javascript:`, `file:`, and `data:` schemes

Two URLs that normalize to the same string are treated as the same target.

### 4.4 SSE Events

Every event has an incrementing numeric `id` enabling replay via `Last-Event-ID`.

```ts
interface StreamEventBase {
  id: number;                     // monotonic per job
  ts: number;                     // unix ms
}

type StreamEvent = StreamEventBase & (
  | { type: 'status'; status: JobStatus }
  | { type: 'step'; stepNumber: number; action: string; selector?: string }
  | { type: 'screenshot'; url: string }
  | { type: 'llm_log'; message: string }
  | { type: 'token_usage'; delta: TokenUsage; cumulative: TokenUsage }
  | { type: 'verification'; passed: boolean; errors?: string[] }
  | { type: 'complete'; resultUrl: string; summary: JobSummary }
  | { type: 'error'; message: string; retryable: boolean }
);

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  estimatedCostUSD: number;
}

interface JobSummary {
  scenarioCount: number;
  unhealedScenarios: number;
  featureFiles: string[];
  verificationPassed: boolean;
  totalTokens: number;
  estimatedCostUSD: number;
}
```

#### Replay protocol

1. Client connects with optional `Last-Event-ID: <lastSeenId>` header
2. Server queries Redis `events:{hash}` list, replays all events with `id > lastSeenId`
3. Server then streams live events
4. If the job is already terminal, server pushes the final state and closes the connection

### 4.5 Job State Machine

```
queued → exploring → generating → verifying → completed
                                      ↓
                                self_healing → verifying → completed
                                      ↓ (exceeds maxRetries)
                                   failed (output preserved as unverified)
```

### 4.6 ActionLog Schema

The ActionLog is the canonical record of agent exploration and the input to both the generator and the verifier.

```ts
interface ActionLogEntry {
  id: string;                     // nanoid(10)
  type: 'goto' | 'observe' | 'click' | 'fill' | 'select' | 'wait' | 'assert';
  url?: string;                   // for 'goto'
  selector?: string;              // selector actually used by Stagehand
  selectorStrategy?:              // documentation of fallback level used
    | 'data-testid' | 'aria-label' | 'role' | 'css' | 'text';
  value?: string;                 // for 'fill' / 'select'
  text?: string;                  // observed text (for 'observe' / 'assert')
  screenshotPath?: string;        // relative path under /storage/screenshots/{hash}/
  timestamp: number;
}

interface ActionLog {
  jobHash: string;
  targetUrl: string;
  entries: ActionLogEntry[];
  inferredJourneys: string[];     // LLM-tagged groupings, e.g. "login", "create_order"
}
```

The ActionLog is persisted alongside the output zip for debugging and future regeneration.

---

## 5. Data Storage

### 5.1 Redis Layout

| Key | Content | TTL |
|-----|---------|-----|
| `job:{hash}` | Job state JSON (includes `apiKey` and optional `auth`) | 7 days |
| `events:{hash}` | Last 50 SSE events (Redis list) | 7 days |
| `bull:generation:*` | bullmq queue keys | bullmq-managed |

Example job state:

```json
{
  "hash": "V1StGXR8_Z5jdHi6B-myT",
  "status": "exploring",
  "url": "https://demo.odoo.com/odoo/sales",
  "hint": "Focus on login and order creation",
  "auth": null,
  "llm": {
    "provider": "openrouter",
    "apiKey": "sk-or-...",
    "model": "anthropic/claude-haiku-4.5",
    "baseURL": "https://openrouter.ai/api/v1"
  },
  "options": { "maxScenarios": 10, "verificationMode": "smoke", "..." : "..." },
  "progress": {
    "currentStep": 12,
    "maxSteps": 30,
    "lastAction": "click 'Confirm'"
  },
  "tokenUsage": {
    "promptTokens": 4821,
    "completionTokens": 1203,
    "estimatedCostUSD": 0.003
  },
  "createdAt": 1715430000000
}
```

### 5.2 File System Layout

```
/storage/
├── screenshots/{jobHash}/
│   ├── step-001.png
│   ├── step-002.png
│   └── ...
├── action-logs/{jobHash}.json
└── outputs/{jobHash}/
    ├── result.zip
    └── result_unverified.zip   # preserved on verification failure
```

**Cleanup policy**

- Job completes or fails → screenshots cleaned 1 hour later (kept for SSE replay)
- Job expires (Redis key gone) → hourly cron sweep removes orphaned directories
- Backend startup scan: any `/storage` directory without a corresponding Redis job is removed

### 5.3 Sensitive-Data Handling

- `apiKey` and `auth.password` are stored as plaintext in Redis, protected by the 7-day TTL
- Redis must run only on the internal Docker network (no host port binding)
- HTTPS terminates at a reverse proxy (out of scope to specify) before reaching the backend
- Sensitive fields are never written to logs (see Log Redaction §8.3) and never appear in SSE events or error messages
- On backend startup, all non-terminal jobs are marked `failed` to prevent orphan jobs holding stale credentials

---

## 6. Output Artifact Specification

### 6.1 File Structure

```
generated-tests/
├── features/
│   ├── 01_login_flow.feature
│   └── 02_sales_order.feature
├── steps/
│   ├── common.steps.ts           # shared steps (e.g. "I am logged in")
│   ├── login.steps.ts
│   └── sales_order.steps.ts
├── support/
│   ├── world.ts                  # Cucumber World
│   └── hooks.ts                  # Before/After hooks
├── cucumber.js
├── playwright.config.ts
├── package.json                  # exact-pinned versions
├── tsconfig.json
├── .github/workflows/e2e.yml
├── .env.example
└── README.md
```

### 6.2 Feature Example

`features/01_login_flow.feature`

```gherkin
Feature: User Login
  As a system user
  I want to log in with my credentials
  So that I can access the system

  Scenario: Successful login with valid credentials
    Given I am on the login page "https://demo.odoo.com/web/login"
    When I fill "login" with "admin"
    And I fill "password" with "admin"
    And I click the login button
    Then I should be redirected to the dashboard
    And the page title should contain "Discuss"

  Scenario: Failed login with invalid credentials
    Given I am on the login page "https://demo.odoo.com/web/login"
    When I fill "login" with "admin"
    And I fill "password" with "wrong_password"
    And I click the login button
    Then I should see error message "Wrong login/password"
```

### 6.3 Steps Example

`steps/common.steps.ts`

```ts
import { Given, When, Then } from '@cucumber/cucumber';
import { expect, BrowserContextOptions } from '@playwright/test';
import type { CustomWorld } from '../support/world';

// module-level state
let cachedAuthState: BrowserContextOptions['storageState'] | null = null;

// ─── Given ────────────────────────────────────────────────────────────────

Given('I am logged in', async function (this: CustomWorld) {
  if (cachedAuthState) {
    // selector: cookie injection — no DOM interaction
    await this.context.addCookies(
      (cachedAuthState as Awaited<ReturnType<typeof this.context.storageState>>).cookies
    );
    await this.page.goto(`${process.env.BASE_URL}/odoo`);
    await this.page.waitForURL(/\/odoo/);
  } else {
    await this.page.goto(`${process.env.BASE_URL}/web/login`);
    // selector: input[name="login"] (CSS attribute, no data-testid available)
    await this.page.fill('input[name="login"]', process.env.APP_USER ?? 'admin');
    await this.page.fill('input[name="password"]', process.env.APP_PASS ?? 'admin');
    await this.page.click('button[type="submit"]');
    await this.page.waitForURL(/\/odoo/);
    cachedAuthState = await this.context.storageState();
  }
});

Given('I am on the login page {string}', async function (this: CustomWorld, url: string) {
  await this.page.goto(url);
  await this.page.waitForSelector('input[name="login"]');
});

// ─── When ─────────────────────────────────────────────────────────────────

When('I fill {string} with {string}', async function (
  this: CustomWorld, field: string, value: string
) {
  // selector: input[name="{field}"] (CSS attribute)
  await this.page.fill(`input[name="${field}"]`, value);
});

// ─── Then ─────────────────────────────────────────────────────────────────

Then('the page title should contain {string}', async function (
  this: CustomWorld, text: string
) {
  await expect(this.page).toHaveTitle(new RegExp(text));
});
```

### 6.4 Boilerplate

`support/world.ts`

```ts
import { World, setWorldConstructor, IWorldOptions } from '@cucumber/cucumber';
import { Browser, BrowserContext, Page } from '@playwright/test';

export class CustomWorld extends World {
  browser!: Browser;
  context!: BrowserContext;
  page!: Page;
  constructor(options: IWorldOptions) { super(options); }
}
setWorldConstructor(CustomWorld);
```

`support/hooks.ts`

```ts
import { BeforeAll, AfterAll, Before, After } from '@cucumber/cucumber';
import { chromium, Browser } from '@playwright/test';
import type { CustomWorld } from './world';

let browser: Browser;

BeforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

AfterAll(async () => {
  await browser.close();
});

Before(async function (this: CustomWorld) {
  this.context = await browser.newContext();
  this.page = await this.context.newPage();
  // disable animations for stability
  await this.page.addStyleTag({
    content: '*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }',
  });
});

After(async function (this: CustomWorld) {
  await this.context.close();
});
```

`cucumber.js`

```js
module.exports = {
  default: {
    require: ['steps/**/*.ts', 'support/**/*.ts'],
    requireModule: ['ts-node/register'],
    format: ['progress-bar', 'html:reports/report.html', 'json:reports/results.json'],
    paths: ['features/**/*.feature'],
  }
};
```

`package.json` (exact-pinned versions — no caret or tilde)

```json
{
  "name": "picklescout-generated-tests",
  "version": "1.0.0",
  "scripts": {
    "test": "cucumber-js",
    "test:report": "cucumber-js --format html:reports/report.html"
  },
  "dependencies": {
    "@cucumber/cucumber": "11.0.0",
    "@playwright/test": "1.50.0"
  },
  "devDependencies": {
    "typescript": "5.5.0",
    "ts-node": "10.9.0",
    "@types/node": "20.0.0"
  }
}
```

The exact-pinned policy prevents drift in generated artifacts. The generator embeds the version string used at generation time.

### 6.5 LLM Generation Rules (System Prompt)

```
STEP TEXT RULES:
- Feature step text and step-definition regex must match exactly (case, whitespace, punctuation)
- Use {string} for quoted parameters, {int} for integers
- Do not redeclare any step already in common.steps.ts

FILE ORDERING:
- imports → module-level state → Given → When → Then

SELECTOR PRIORITY (annotate the choice in a comment):
  1. [data-testid="..."]
  2. [aria-label="..."]
  3. [role="..."]
  4. CSS class / attribute
  5. :has-text() (combinable)
  6. XPath is forbidden

ASSERTION RULES:
- Every Then step must contain at least one expect()
- A Then step may not consist solely of waitForLoadState or waitForSelector
- Assertions must validate business outcomes (status text, IDs, URLs), not merely "page did not crash"

SCENARIO LIMIT:
- Generate at most {maxScenarios} scenarios total
- Allocate {positiveCount} positive (happy path) and {negativeCount} negative
- Positive: primary user journey, expected successful outcomes
- Negative: invalid input, missing required fields, boundary conditions
- If the target has fewer distinct flows than the limit, generate fewer
- Priority: login flow > primary CRUD > secondary flows > error handling

GENERATION ORDER (two-pass):
  Pass 1: action_log → .feature (Gherkin only)
  Pass 2: action_log + .feature → steps files (Pass 1 step text is frozen)
```

### 6.6 Compile-Time Validation

Before any verification run, the system validates that every feature step resolves to exactly one step definition:

```ts
interface StepResolutionResult {
  feature: string;
  scenario: string;
  unresolvedSteps: string[];      // step text with no matching definition
  ambiguousSteps: string[];       // step text matching multiple definitions
}
```

If `unresolvedSteps` or `ambiguousSteps` is non-empty, the generator regenerates Pass 2 once. If still failing, the job ends in `failed` with a clear diagnostic.

---

## 7. Frontend UI

### 7.1 Routes

```
/                    → New Job form
/jobs/:hash          → Job detail (progress + result)
/jobs/:hash (404)    → Not found / expired
```

### 7.2 Screen 1: New Job (`/`)

```
┌─────────────────────────────────────────────┐
│  🥒 PickleScout                              │
├─────────────────────────────────────────────┤
│  Target URL                                  │
│  [ https://demo.odoo.com/odoo/sales      ]  │
│                                              │
│  Hint (optional)                             │
│  [ Focus on login and order creation     ]  │
│                                              │
│  LLM Provider                                │
│  [ OpenRouter ▾ ]  [ anthropic/claude... ▾] │
│  [ API Key  ••••••••••••                 ]  │
│  ⚠ Key is stored in server memory with       │
│    7-day expiry, never logged.               │
│                                              │
│  ▸ Authentication (optional)                 │
│  ▸ Advanced Options                          │
│                                              │
│  [ Generate Tests → ]                        │
│                                              │
│  ─────────── Recent Jobs ───────────         │
│  demo.odoo.com  2h ago  ✅  #V1StGX...       │
└─────────────────────────────────────────────┘
```

**Authentication section** (collapsed by default):

```
Login URL         [ https://.../login          ]
Username          [ admin                       ]
Password          [ ••••••••                    ]
(Selectors are auto-detected; leave blank.)
```

**Advanced Options** (collapsed by default):

```
Max scenarios     [10]   (1-10)
Positive ratio    [60%]  slider
Max agent steps   [30]
Verification mode [smoke ▾]   syntax-only / smoke / full
Max retries       [2]
```

### 7.3 Screen 2: Job Detail (`/jobs/:hash`)

#### Status bar (always visible)

```
┌──────────────────────────────────────────────┐
│  demo.odoo.com/odoo/sales                    │
│  ● Exploring   Step 12 / ~30   [Cancel]      │
│  Tokens: 4,821  Est. cost: ~$0.003           │
└──────────────────────────────────────────────┘
```

Status colors:

- `queued` gray
- `exploring` / `generating` / `verifying` / `self_healing` blue / purple / orange
- `completed` green
- `failed` red

#### In-progress section

```
┌──────────────────┬──────────────────────────┐
│  Action Log      │  Screenshots              │
│                  │                           │
│ ✓ goto /sales    │  [Step 3] [Step 7]        │
│ ✓ observe page   │  [Step 12] ...            │
│ ✓ click "New"    │                           │
│ ⟳ fill product   │  (click to enlarge)       │
└──────────────────┴──────────────────────────┘
```

#### Completed section

```
┌──────────────────────────────────────────────┐
│  ✅ Generation Complete                       │
│  8 scenarios (1 unhealed)                    │
│  6,204 tokens  •  ~$0.004                    │
│  Verification: ✅ 7 passed, 1 unhealed        │
│                                              │
│  [ ⬇ Download ZIP ]  [ 🔗 Copy Job URL ]    │
│                                              │
│  ⚠ AI-generated tests. Review before         │
│    adding to CI/CD.                          │
│                                              │
│  Preview                                     │
│  ┌────────────────────────────────────────┐  │
│  │ features/ ▾                            │  │
│  │   01_login_flow.feature                │  │
│  │   02_sales_order.feature               │  │
│  │ steps/                                 │  │
│  │   common.steps.ts                      │  │
│  └────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────┐  │
│  │ Feature: User Login          (syntax  │  │
│  │   Scenario: Successful login...        │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

#### Failed section

```
┌──────────────────────────────────────────────┐
│  ❌ Generation Failed                         │
│  Verification failed after 2 retries.        │
│  Last error: Selector not found: .o_sale...  │
│                                              │
│  [ ↻ Retry with same config ]                │
│  [ + New Job ]                               │
│                                              │
│  Partial output available (unverified):      │
│  [ ⬇ Download anyway ]  → triggers warning   │
└──────────────────────────────────────────────┘
```

**Retry behavior**: cancel current job (DELETE Redis key) → create a new job with the same config (apiKey and auth fetched from the original Redis entry before deletion) → navigate to the new jobHash page.

**Download Anyway modal**:

```
⚠ Unverified Output

These tests were generated but could not be
verified against the target URL. They may
contain incorrect selectors or missing
assertions. Review carefully before adding
to CI/CD.

[ Cancel ]  [ Download Anyway ]
```

### 7.4 Components

| Component | Responsibility |
|-----------|---------------|
| `JobForm` | URL, hint, provider, options |
| `ProviderSelector` | provider dropdown, API key, model |
| `AuthPanel` | collapsible form-auth fields |
| `OptionsPanel` | collapsible advanced options |
| `JobStatusBar` | status badge, step counter, token meter (SSE-driven) |
| `ActionLogPanel` | live agent action list |
| `ScreenshotGallery` | thumbnails + lightbox |
| `FeaturePreview` | file tree + syntax-highlighted code |
| `RecentJobs` | localStorage-backed list on landing page |
| `TokenMeter` | tokens + estimated cost |
| `UnverifiedDownloadModal` | warning before degraded download |

### 7.5 localStorage Layout

```ts
interface RecentJob {
  hash: string;
  url: string;
  createdAt: number;
  status: JobStatus;
  scenarioCount?: number;
}

// localStorage key: 'recent_jobs'
// Max 20 entries; oldest evicted when exceeded.
```

---

## 8. Error Handling

### 8.1 Error Categories

| Category | Error | Behavior | Retry | User message |
|----------|-------|----------|-------|--------------|
| Input | Invalid URL format | Frontend validation blocks submit | — | "Enter a valid URL starting with http(s)://" |
| Input | URL unreachable (4xx/5xx/timeout) | job → `failed` | ❌ | "Could not reach the URL. Check it's publicly accessible." |
| LLM | API key invalid (401) | job → `failed` | ❌ | "Invalid API key. Please check your provider credentials." |
| LLM | Rate limit (429) | Exponential backoff (2 s, 4 s, 8 s) | ✅ auto 3× | SSE: "Rate limited, retrying in Xs…" |
| LLM | Model not found | job → `failed` | ❌ | "Model '{model}' not found." |
| LLM | Structured output parse failure | retry same step once | ✅ 1× | "LLM returned unexpected output. Try a different model." |
| Browser | Page load timeout | job → `failed` | ❌ | "Page took too long to load (>30s)." |
| Browser | Stagehand crash | job → `failed`, stack recorded | ❌ | "Browser automation error. See logs for details." |
| Generation | Feature / steps parse error | regenerate once | ✅ 1× | SSE: "Regenerating due to output error…" |
| Generation | Step definition resolution failure | regenerate Pass 2 once | ✅ 1× | SSE: "Resolving step definitions…" |
| Verification | Cucumber run failure | self-heal up to `maxRetries` | ✅ N× | SSE: "Verification failed, retrying (X/{max})…" |
| Verification | Exceeds `maxRetries` | job → `failed`, unverified output preserved | ❌ | "Tests could not be verified. You can still download." |
| Infra | Redis connection failure | HTTP 503 | ❌ | "Service temporarily unavailable." |
| Infra | Disk full | job → `failed` | ❌ | "Storage error. Contact administrator." |
| Infra | Process crash / restart | orphan jobs → `failed` | ❌ | "Service restarted. Please retry your job." |

### 8.2 SSE Reconnection

- The client uses `EventSource`'s native automatic reconnection
- The backend maintains `events:{hash}` in Redis (last 50 events)
- On reconnect, the client sends `Last-Event-ID` and the server replays missed events
- If the job is terminal, the server pushes the final state and closes the connection

### 8.3 Log Redaction

```ts
const REDACT_FIELDS = [
  'apiKey',
  'password',
  'cookie',
  'authorization',
  'auth.password',
];

function safeLog<T>(data: T): T {
  return JSON.parse(JSON.stringify(data, (key, value) =>
    REDACT_FIELDS.some(f => key === f || key.endsWith(`.${f}`)) ? '[REDACTED]' : value
  ));
}
```

---

## 9. Non-Functional Requirements

| Item | Spec | Notes |
|------|------|-------|
| Max job duration | 20 min | Beyond this → `failed`, browser instance released |
| Page load timeout | 30 s | Stagehand `goto` wait limit |
| LLM call timeout | 60 s | Single LLM API call limit |
| Max agent steps | 30 (configurable 1-50) | Prevents runaway exploration |
| Max scenarios | 10 (configurable 1-10) | Hard cap |
| Screenshot max size | 1920×1080, compressed < 500 KB | Storage efficiency |
| Output zip max size | 10 MB | Guard rail |
| Redis TTL | 7 days | Job state + apiKey + auth synchronized |
| Screenshot cleanup | 1 hour after job ends | Preserved for SSE replay |
| Concurrent jobs | `MAX_CONCURRENT_JOBS` env var, default 2 | Adjusted after Mac Mini 16 GB benchmarking |
| Log redaction | `apiKey`, `password`, `cookie`, `authorization` fields | Replaced with `[REDACTED]` |
| SSE event buffer | Last 50 events in Redis | For reconnect replay |
| Frontend recent jobs | localStorage, max 20 entries | Oldest evicted |

---

## 10. Out of Scope

### 10.1 Permanent Exclusions

**Browsers / platforms**
- Firefox / WebKit / Safari (Chromium only)
- Mobile browsers, native apps
- Desktop applications, browser extensions

**Test types**
- Performance, accessibility, visual regression
- Security / penetration testing
- API and unit test generation

**Output formats**
- Cypress, Selenium, Puppeteer, Robot Framework, pytest, Postman
- Cucumber.js + Playwright only

**Authentication**
- OAuth, SSO, MFA, SAML
- Auth-gateway redirects
- CAPTCHA solving

**Infrastructure**
- Cloud deployment, Kubernetes, HA, auto-scaling
- Multi-tenant SaaS, billing

### 10.2 Phase 2 Candidates

| Item | Reason for exclusion | Forward-compatibility hook |
|------|---------------------|---------------------------|
| Pages behind complex auth | Complex auth flows | `AuthConfig.type` extensible beyond `'form'` |
| CAPTCHA-protected pages | Requires third-party service | Could integrate Browserbase cloud |
| Batch URL processing | Single-job flow first | bullmq natively supports |
| Manual editing of artifacts | Requires editor UI | Currently: download zip |
| Artifact run history | Test management territory | Phase 2 could add archive |
| Playwright Test output | Needs separate generator | Reuses ActionLog input |
| Slack / email notifications | Not needed for side project | Completion event already in SSE |
| Local Ollama small models | Confirmed unreliable | Custom provider supports it at user's risk |
| Site crawling | Agent loop cost explodes | Single URL first |
| Observability metrics | Production-grade need | Add: generation success rate, verifier pass rate, avg retries, avg token usage |
| Prompt versioning | Regression analysis | Add `promptVersion` field to job state |
| Template-aware generation | Higher token efficiency | `targetType: 'odoo' \| 'erpnext' \| 'generic-crud'` with workflow priors and selector hints |

### 10.3 Boundary Definitions

**"Reachable URL" definition**
- ✅ Publicly accessible without an account
- ✅ Requires an account but user supplies form credentials via `auth`
- ❌ Paywalled content
- ❌ VPN / IP-whitelisted (backend cannot reach → fails, not a system bug)

**Artifact maintenance responsibility**
- The system is responsible only for the initial generation
- If the target site changes and selectors break → the user maintains or regenerates
- The system does not monitor changes, send notifications, or auto-repair

**LLM generation quality guarantee**
- The system guarantees that artifacts are "syntactically valid and executable" (via the verifier)
- The system does not guarantee complete business-logic coverage
- The UI must display a clear disclaimer: "AI-generated. Review before adding to CI/CD."

**Token cost**
- The system displays an "estimated cost", not a real bill
- If the pricing table goes stale, the displayed estimate drifts. This is not a bug.
- The user is solely responsible for their LLM API charges

**Legal and ethical use**
- The user is responsible for ensuring the target system permits automated access and testing
- The user is responsible for compliance with the target system's terms of service and applicable laws
- The system does not bypass `robots.txt`, anti-bot mechanisms, or rate limits beyond standard Playwright behavior

---

## 11. Development Plan

### Phase 0: Spike and Validation (1-2 weeks)

- Run Stagehand + OpenRouter (Claude Haiku 4.5) on a Mac Mini
- Run agent exploration against `demo.odoo.com` and assess ActionLog quality
- Benchmark how many concurrent Chromium instances 16 GB RAM supports
- Validate that two-pass LLM generation produces executable Cucumber + Playwright code

**Gate**: if Phase 0 shows LLM output quality below a usable threshold, reassess feasibility before continuing.

### Phase 1: MVP (4-6 weeks)

1. Backend: Node.js + Stagehand + Redis + bullmq
2. Frontend: form + job detail page
3. SSE wiring with Last-Event-ID replay
4. Cucumber artifact + zip download
5. OpenAI + OpenRouter providers
6. Optional form-based `auth`
7. Verification modes (`syntax-only`, `smoke`)
8. URL normalization + step-definition compile validation
9. Docker Compose deployment

### Phase 2: Stabilization (2-4 weeks)

1. Full self-healing loop with scope-restricted modifications
2. Complete error-handling coverage
3. Anthropic and Gemini providers
4. Recent jobs and Download Anyway
5. Live token-usage display
6. `full` verification mode

### Phase 3 (as needed)

- Complex auth support (`AuthConfig.type` beyond `'form'`)
- Batch URL processing
- Playwright Test output format
- Observability metrics
- Prompt versioning
- Template-aware generation

---

## Appendix A: Environment Variables

```
# Backend
REDIS_URL=redis://redis:6379
MAX_CONCURRENT_JOBS=2
STORAGE_DIR=/storage
JOB_TTL_DAYS=7
PAGE_TIMEOUT_SEC=30
LLM_CALL_TIMEOUT_SEC=60
JOB_MAX_DURATION_SEC=1200
LOG_LEVEL=info

# Never set as environment variables:
# - any LLM API key (provided per request)
# - any auth credential (provided per request)
```

## Appendix B: Recommended Demo Targets

| Name | URL | Use |
|------|-----|-----|
| Odoo | `https://demo.odoo.com` | Primary target; resets every 24 hours |
| Dolibarr | `https://www.dolibarr.org/onlinedemo.php` | Backup |
| webERP | Live demo on official site | Backup |
| EspoCRM | `https://www.espocrm.com/demo/` | CRM but similar user journeys |

## Appendix C: Risk Summary

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Unstable LLM output quality | MVP unusable | Phase 0 validation, verifier gating, human-review disclaimer |
| Stagehand OpenRouter bug | Provider unstable | `CustomOpenAIClient` workaround |
| Mac Mini 16 GB out of memory | Limited concurrency | Low `MAX_CONCURRENT_JOBS` default, benchmark-driven tuning |
| Token cost runaway | User charged unexpectedly | `maxSteps` / `maxRetries` caps, live token meter |
| Selector decay | Artifact hard to maintain | Stagehand self-healing, selector-priority rules |
| Self-healing scope creep | Tests semantically drift | Scoped allowlist (§3.4), unhealed scenarios tagged not removed |

---

## Appendix D: Agent Context Management

### D.1 Overview

PickleScout follows the **AGENTS.md open standard** (maintained by the Agentic AI Foundation under the Linux Foundation) for AI coding agent context. All AI coding tools read from a single source of truth: `AGENTS.md`.

| Tool | File read | Approach |
|------|-----------|----------|
| Claude Code | `CLAUDE.md` | Symlink → `AGENTS.md` |
| OpenAI Codex | `AGENTS.md` | Root file |
| GitHub Copilot | `AGENTS.md` | Root file |
| Cursor | `.cursorrules` | Out of scope for this project |

**Setup** (run once after cloning):

```bash
ln -s AGENTS.md CLAUDE.md
```

### D.2 File Structure

```
picklescout/
├── AGENTS.md                    # Root: max 100 lines, commands + core rules + pointers
├── CLAUDE.md                    # Symlink: ln -s AGENTS.md CLAUDE.md
│
├── .agents/
│   ├── architecture.md          # Two-phase design, service boundaries, data flow
│   ├── frontend-style.md        # React + Vite + TS conventions, SSE client pattern
│   ├── backend-style.md         # Node.js conventions, Redis patterns, bullmq, safeLog
│   ├── react-patterns.md        # Component structure, custom hooks, state patterns
│   ├── templates/
│   │   ├── react-component.md   # Canonical component + test template
│   │   ├── react-hook.md        # Canonical hook template
│   │   └── api-route.md         # Canonical Fastify route + schema template
│   └── specs/
│       ├── auth-flow.md         # AuthConfig spec, session/cookie injection
│       ├── api-contract.md      # Full API schema (mirrors PRD §4)
│       └── state-management.md  # Job state machine, Redis layout, SSE event types
│
├── frontend/
│   └── AGENTS.md                # Frontend-specific: route map, Vite config, component layout
│
└── backend/
    └── AGENTS.md                # Backend-specific: Stagehand setup, env vars, Redis key policy
```

**Discovery rule**: agents read from repo root down to current working directory. The closest file wins — `backend/AGENTS.md` overrides root `AGENTS.md` for anything inside `backend/`.

### D.3 Root AGENTS.md: 100-Line Constraint

The root `AGENTS.md` must stay under 100 lines. Include only what an agent **cannot infer from the codebase alone**.

**Mandatory sections (in priority order)**:

1. Project summary (≤ 3 lines)
2. Tech stack with **exact versions**
3. Commands (dev, test, lint)
4. Absolute constraints (never / always / ask first)
5. Pointers to `.agents/` for detailed context

**What belongs in `.agents/` instead of root**:
- Architecture explanations and diagrams
- Detailed coding conventions with examples
- Code templates
- Spec documents

> **Research note**: An ETH Zurich 2025 study found LLM-generated AGENTS.md files *reduced* task success rates by ~3% and increased inference costs by 20–23%. All files in `.agents/` must be **human-written and maintained**, not auto-generated.

### D.4 Root AGENTS.md Template

```markdown
# PickleScout — Agent Context

LLM-driven browser agent → Cucumber.js + Playwright test projects.
Architecture overview: .agents/architecture.md

## Stack
- Frontend: React 18, Vite 5, TypeScript 5.5
- Backend: Node.js 20, TypeScript 5.5, Fastify 4
- Browser: Stagehand v3 (Chromium only)
- Queue: Redis 7 + bullmq 5
- Output: Cucumber.js 11.0.0 + Playwright 1.50.0 (exact-pinned)

## Commands
```bash
docker compose up             # start all services
cd frontend && pnpm dev       # Vite dev server
cd backend && pnpm dev        # ts-node-dev watch

pnpm lint                     # ESLint
pnpm typecheck                # tsc --noEmit (run before committing)
pnpm test                     # unit tests
```

## Absolute Constraints
- NEVER log apiKey, password, cookie, or authorization — always call safeLog() first
- Stagehand is generation-only; output artifacts NEVER import Stagehand or any LLM SDK
- Chromium only — no Firefox or WebKit code paths
- Pinned versions in generated output package.json MUST NOT use ^ or ~ prefixes
- Redis keys MUST follow the job:{hash} prefix convention

## Boundaries
Always (no confirmation needed):
- Read files, list directories
- Run lint / typecheck on a single file
- Run a single unit test

Ask first:
- pnpm add / pnpm install or adding any dependency
- docker compose up / down / restart
- Any Redis data deletion

Never:
- Modify /storage without a job context
- Add Stagehand or LLM SDK imports to frontend/
- Run Redis FLUSHALL

## Detailed Docs
- Architecture:      .agents/architecture.md
- Frontend style:    .agents/frontend-style.md
- Backend style:     .agents/backend-style.md
- React patterns:    .agents/react-patterns.md
- API contract:      .agents/specs/api-contract.md
- State machine:     .agents/specs/state-management.md
- Auth flow:         .agents/specs/auth-flow.md
```

### D.5 Per-Directory AGENTS.md Content

**`frontend/AGENTS.md`**
- Route map: `/` → `JobForm`, `/jobs/:hash` → `JobDetail`
- SSE client setup: `EventSource` + `Last-Event-ID` reconnection pattern
- Component file layout: `ComponentName/index.tsx` + `ComponentName.test.tsx`
- Syntax highlight library: `prism-react-renderer`
- localStorage key schema for `recent_jobs`

**`backend/AGENTS.md`**
- Stagehand: one instance per job, destroyed on job completion or failure
- bullmq worker concurrency controlled by `MAX_CONCURRENT_JOBS` env var
- Redis key prefix policy: `job:`, `events:`, `bull:`
- `safeLog()` is mandatory before any `logger.*` call that touches a job object
- Required env vars and expected format (see PRD Appendix A)

### D.6 Update Policy

| Trigger | Required action |
|---------|----------------|
| New pnpm dependency added | Update stack version in root `AGENTS.md` |
| New pnpm script added | Add to Commands section |
| API contract changed | Update `.agents/specs/api-contract.md` |
| New coding convention adopted | Update relevant `.agents/*.md` |
| New canonical pattern established | Update `.agents/templates/` |
| Root `AGENTS.md` approaches 100 lines | Move detail to `.agents/`, replace with pointer |

`AGENTS.md` and `.agents/` changes must be included in the **same PR** as the corresponding code change. Outdated agent context is worse than no context.