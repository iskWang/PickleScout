# PickleScout — Pipeline Unit Test Plan

> Version: 1.0 | Created: 2026-05-18
> Replaces: ad-hoc full job flow runs for pipeline regression testing
> Runner: vitest in `packages/backend` — `pnpm test` exits in < 15 s, no Docker, no real LLM API

---

## Why This Exists

Every fix to the pipeline (generator prompt, verifier error extraction, self-heal JSON parsing) was previously validated by submitting a full job to the running stack — 3–5 minutes per attempt, real LLM tokens, Docker required. This plan replaces that loop with targeted unit tests that run in seconds and catch each failure category deterministically.

**Known failure categories this plan guards against:**

| # | Category | Root Cause | First Seen |
|---|----------|-----------|------------|
| 1 | DOM API in generated steps | `STEP_SHARED_RULES` missing runtime guard | job `I8u-mnBQ9znRYCo3x0J3T` |
| 2 | Self-heal returns invalid JSON | `JSON.parse(raw)` not using `stripMarkdownJson` | jobs `SOBKXS`, `7a8Y7HqX` |
| 3 | Self-heal receives empty errors | Verifier filtered output too aggressively; empty context = LLM can't fix | same |
| 4 | Hallucination guard fires on 1-step explore | `stagehand.act("Navigate")` LLM no-op on weak models | `tz_-8RPz3U` |

---

## Architecture

```
packages/backend/src/worker/
├── generator.ts          ← exports STEP_SHARED_RULES, stripMarkdownJson
├── verifier.ts           ← exports extractCucumberErrors, attemptSelfHeal
├── generator.test.ts     ← existing + new stripMarkdownJson + prompt-string tests
├── generator.fixtures.test.ts   ← NEW: LLM fixture compliance tests
├── verifier.test.ts      ← NEW: extractCucumberErrors + self-heal tests
└── __fixtures__/
    ├── pass2-common-steps.json      ← recorded real LLM output (Pass 2a)
    ├── pass2-feature-steps.json     ← recorded real LLM output (Pass 2b)
    ├── cucumber-result-failed.json  ← realistic cucumber JSON with failures
    ├── cucumber-result-passed.json  ← all-pass cucumber report
    └── cucumber-result-mixed.json   ← some passed, some failed, some undefined

scripts/
└── record-llm-fixtures.ts   ← one-shot: call real LLM, write to __fixtures__/
```

---

## Phase 1 — Generator: Prompt String Assertions (A 方案)

**File:** `generator.test.ts` (extend existing file)
**Purpose:** Assert that `STEP_SHARED_RULES` contains every required guard — no real LLM call needed.

### Required export

Add to `generator.ts`:
```typescript
export { STEP_SHARED_RULES };
// (change `const` to `export const`)
```

### Test cases

```typescript
import { STEP_SHARED_RULES } from './generator';

describe('STEP_SHARED_RULES — runtime guard', () => {
  it('forbids document', () => {
    expect(STEP_SHARED_RULES).toContain('NEVER use: document');
  });
  it('forbids window', () => {
    expect(STEP_SHARED_RULES).toContain('window');
  });
  it('forbids HTMLInputElement', () => {
    expect(STEP_SHARED_RULES).toContain('HTMLInputElement');
  });
  it('forbids localStorage / sessionStorage / navigator', () => {
    expect(STEP_SHARED_RULES).toContain('localStorage');
    expect(STEP_SHARED_RULES).toContain('sessionStorage');
    expect(STEP_SHARED_RULES).toContain('navigator');
  });
  it('prescribes world.page as access pattern', () => {
    expect(STEP_SHARED_RULES).toContain('world.page');
  });
  it('forbids XPath', () => {
    expect(STEP_SHARED_RULES).toContain('XPath is FORBIDDEN');
  });
  it('requires expect() in Then steps', () => {
    expect(STEP_SHARED_RULES).toContain('Every Then step must contain at least one expect() call');
  });
  it('specifies all three required imports', () => {
    expect(STEP_SHARED_RULES).toContain('@cucumber/cucumber');
    expect(STEP_SHARED_RULES).toContain('@playwright/test');
    expect(STEP_SHARED_RULES).toContain('../support/world');
  });
});
```

---

## Phase 2 — Generator: LLM Fixture Compliance (B 方案)

**Files:** `__fixtures__/pass2-*.json` + `generator.fixtures.test.ts`
**Purpose:** Record real LLM output once; validate it on every subsequent `pnpm test`.

### Step 1: Record fixtures

Run once (requires `OPENROUTER_API_KEY` env var, real LLM call):

```bash
bun run scripts/record-llm-fixtures.ts
```

The script calls `pass2aGenerateCommon` and `pass2bGenerateFeatureSteps` against a small canned `ActionLog` (5 steps, Odoo sales), then writes the raw JSON responses to `__fixtures__/`.

**Fixture format:**
```json
{
  "recorded_at": "2026-05-18T12:00:00Z",
  "model": "anthropic/claude-sonnet-4-5",
  "files": [
    { "filename": "common.steps.ts", "content": "import { Given, When, Then } from '@cucumber/cucumber';\n..." }
  ]
}
```

### Step 2: Compliance tests

```typescript
// generator.fixtures.test.ts
import pass2Common from './__fixtures__/pass2-common-steps.json';
import pass2Feature from './__fixtures__/pass2-feature-steps.json';

const DOM_API_PATTERN = /\bdocument\b|\bwindow\b|\bHTMLElement\b|\bHTMLInputElement\b|\blocalStorage\b|\bsessionStorage\b|\bnavigator\./;

describe('LLM fixture compliance — Pass 2', () => {
  const allFiles = [...pass2Common.files, ...pass2Feature.files];

  it('no file uses DOM APIs', () => {
    for (const f of allFiles) {
      expect(DOM_API_PATTERN.test(f.content), `${f.filename} contains DOM API`).toBe(false);
    }
  });

  it('every Then step has at least one expect()', () => {
    for (const f of allFiles) {
      const thenBlocks = f.content.match(/Then\([^)]+,\s*async[^}]+\}/gs) ?? [];
      for (const block of thenBlocks) {
        expect(block, `${f.filename}: Then block missing expect()`).toContain('expect(');
      }
    }
  });

  it('every file imports from @cucumber/cucumber', () => {
    for (const f of allFiles) {
      expect(f.content, `${f.filename}`).toContain('@cucumber/cucumber');
    }
  });

  it('every file uses Playwright page API (world.page or const { page })', () => {
    for (const f of allFiles) {
      const hasPageAccess = f.content.includes('world.page') || f.content.includes('const { page }');
      expect(hasPageAccess, `${f.filename}: no world.page access`).toBe(true);
    }
  });
});
```

---

## Phase 3 — Generator: `stripMarkdownJson`

**File:** `generator.test.ts` (extend existing file)
**Purpose:** Edge-case coverage for the JSON fence stripper used by generator and self-healer.

```typescript
import { stripMarkdownJson } from './generator';

describe('stripMarkdownJson', () => {
  it('strips ```json fence', () => {
    expect(stripMarkdownJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('strips plain ``` fence', () => {
    expect(stripMarkdownJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('passes through plain JSON unchanged', () => {
    expect(stripMarkdownJson('{"a":1}')).toBe('{"a":1}');
  });
  it('trims surrounding whitespace', () => {
    expect(stripMarkdownJson('  {"a":1}  ')).toBe('{"a":1}');
  });
  it('returns empty string on empty input', () => {
    expect(stripMarkdownJson('')).toBe('');
  });
});
```

---

## Phase 4 — Verifier: `extractCucumberErrors`

**File:** `verifier.test.ts` (new file)
**Purpose:** Confirm the error extractor returns useful context for self-healing.

### Fixture: `__fixtures__/cucumber-result-failed.json`

Minimal cucumber JSON report with one failed step:
```json
[{
  "uri": "features/01_sales.feature",
  "elements": [{
    "name": "Create a new sales order",
    "steps": [
      {
        "name": "I am on the Sales page",
        "result": { "status": "passed", "duration": 1000000 }
      },
      {
        "name": "I click the New button",
        "result": {
          "status": "failed",
          "error_message": "TimeoutError: page.waitForSelector: Timeout 30000ms exceeded.\nSelector: [data-menu-xmlid=\"sale.action_quotations\"]",
          "duration": 30000000000
        }
      },
      {
        "name": "I should see the order form",
        "result": { "status": "skipped", "duration": 0 }
      }
    ]
  }]
}]
```

Additional fixtures: `cucumber-result-passed.json` (all passed), `cucumber-result-undefined.json` (undefined step), `cucumber-result-pending.json` (pending step).

### Test cases

```typescript
// verifier.test.ts
import { vi, describe, it, expect } from 'vitest';
import path from 'path';

// Export extractCucumberErrors from verifier.ts for testing:
// export { extractCucumberErrors };  ← add to verifier.ts
import { extractCucumberErrors } from './verifier';

describe('extractCucumberErrors', () => {
  it('returns error string with scenario name on failure', async () => {
    const fixturePath = path.join(__dirname, '__fixtures__/cucumber-result-failed.json');
    const errors = await extractCucumberErrors(fixturePath, ['fallback']);
    expect(errors[0]).toContain('Create a new sales order');
  });

  it('includes the failed step name', async () => {
    const fixturePath = path.join(__dirname, '__fixtures__/cucumber-result-failed.json');
    const errors = await extractCucumberErrors(fixturePath, []);
    expect(errors[0]).toContain('I click the New button');
  });

  it('includes the error_message text', async () => {
    const fixturePath = path.join(__dirname, '__fixtures__/cucumber-result-failed.json');
    const errors = await extractCucumberErrors(fixturePath, []);
    expect(errors[0]).toContain('TimeoutError');
  });

  it('returns fallback when all steps pass', async () => {
    const fixturePath = path.join(__dirname, '__fixtures__/cucumber-result-passed.json');
    const fallback = ['no real errors'];
    const errors = await extractCucumberErrors(fixturePath, fallback);
    expect(errors).toEqual(fallback);
  });

  it('treats undefined steps as errors', async () => {
    const fixturePath = path.join(__dirname, '__fixtures__/cucumber-result-undefined.json');
    const errors = await extractCucumberErrors(fixturePath, []);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('treats pending steps as errors', async () => {
    const fixturePath = path.join(__dirname, '__fixtures__/cucumber-result-pending.json');
    const errors = await extractCucumberErrors(fixturePath, []);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('does not generate errors for skipped steps', async () => {
    // skipped step in failed fixture — only one error entry (the failed step)
    const fixturePath = path.join(__dirname, '__fixtures__/cucumber-result-failed.json');
    const errors = await extractCucumberErrors(fixturePath, []);
    expect(errors).toHaveLength(1);
  });

  it('falls back to raw array when file does not exist', async () => {
    const fallback = ['raw stderr output'];
    const errors = await extractCucumberErrors('/nonexistent/path.json', fallback);
    expect(errors).toEqual(fallback);
  });

  it('falls back to raw array when file contains invalid JSON', async () => {
    const fixturePath = path.join(__dirname, '__fixtures__/cucumber-result-invalid.json');
    // This fixture contains "not valid json"
    const fallback = ['raw stderr'];
    const errors = await extractCucumberErrors(fixturePath, fallback);
    expect(errors).toEqual(fallback);
  });
});
```

**Note:** These tests read real fixture files from disk — no `vi.mock('fs/promises')` needed. Add `cucumber-result-invalid.json` containing `"not valid json"` as a literal string.

---

## Phase 5 — Verifier: Self-Heal JSON Robustness

**File:** `verifier.test.ts` (continue same file)
**Purpose:** Confirm self-heal parses markdown-fenced and plain JSON; throws clearly on garbage.

### Mocks required

`attemptSelfHeal` has three external dependencies that must be mocked:

| Dependency | Why mock | vi.mock target |
|------------|----------|----------------|
| `buildOpenAIClient` | Prevents real API calls | `./generator` |
| `emitEvent` | Prevents Redis `rpush`/`expire` calls | `./sse` |
| `updateJobStatus` | Prevents Redis `SET job:…` calls | `../redis` |

```typescript
vi.mock('./sse', () => ({ emitEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../redis', () => ({ updateJobStatus: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./generator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./generator')>();
  return { ...actual, buildOpenAIClient: vi.fn() };
});
```

```typescript
import { vi } from 'vitest';
import type OpenAI from 'openai';
import { attemptSelfHeal } from './verifier';

// Mock the OpenAI client that buildOpenAIClient returns
vi.mock('./generator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./generator')>();
  return {
    ...actual,
    buildOpenAIClient: vi.fn(),
  };
});

function makeJobState(overrides = {}): JobState {
  return {
    hash: 'test-hash',
    url: 'https://example.com',
    status: 'self_healing',
    llm: { provider: 'openrouter', apiKey: 'test', model: 'test-model' },
    options: { maxScenarios: 3, positiveRatio: 0.8, maxSteps: 15, verificationMode: 'smoke', maxRetries: 2 },
    tokenUsage: { promptTokens: 0, completionTokens: 0, estimatedCostUSD: 0 },
    createdAt: Date.now(), updatedAt: Date.now(),
    ...overrides,
  } as JobState;
}

function mockLLMResponse(content: string): OpenAI {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
      },
    },
  } as unknown as OpenAI;
}

describe('attemptSelfHeal — JSON parsing', () => {
  const stepFiles = [{ filename: 'common.steps.ts', content: 'Given("x", async () => {})' }];
  const errors = ['TimeoutError on selector #btn'];

  it('handles plain JSON response', async () => {
    const payload = JSON.stringify({ files: [{ filename: 'common.steps.ts', content: 'fixed' }] });
    (buildOpenAIClient as ReturnType<typeof vi.fn>).mockReturnValue(mockLLMResponse(payload));
    const result = await attemptSelfHeal(makeJobState(), stepFiles, errors);
    expect(result[0].content).toBe('fixed');
  });

  it('handles markdown-fenced JSON response', async () => {
    const payload = '```json\n' + JSON.stringify({ files: [{ filename: 'common.steps.ts', content: 'fixed2' }] }) + '\n```';
    (buildOpenAIClient as ReturnType<typeof vi.fn>).mockReturnValue(mockLLMResponse(payload));
    const result = await attemptSelfHeal(makeJobState(), stepFiles, errors);
    expect(result[0].content).toBe('fixed2');
  });

  it('throws on non-JSON response', async () => {
    (buildOpenAIClient as ReturnType<typeof vi.fn>).mockReturnValue(mockLLMResponse('I cannot repair these files.'));
    await expect(attemptSelfHeal(makeJobState(), stepFiles, errors))
      .rejects.toThrow('Self-heal LLM returned invalid JSON');
  });

  it('throws on wrong structure (missing files key)', async () => {
    const payload = JSON.stringify({ result: [{ filename: 'x.ts', content: '...' }] });
    (buildOpenAIClient as ReturnType<typeof vi.fn>).mockReturnValue(mockLLMResponse(payload));
    await expect(attemptSelfHeal(makeJobState(), stepFiles, errors))
      .rejects.toThrow('Self-heal LLM returned unexpected structure');
  });
});
```

---

## Fixture Files to Create

| Path | Content | Notes |
|------|---------|-------|
| `__fixtures__/cucumber-result-failed.json` | 1 passed step + 1 failed + 1 skipped | Realistic TimeoutError message |
| `__fixtures__/cucumber-result-passed.json` | 3 passed steps | Triggers fallback path |
| `__fixtures__/cucumber-result-undefined.json` | 1 undefined step | Tests undefined → error |
| `__fixtures__/cucumber-result-pending.json` | 1 pending step | Tests pending → error |
| `__fixtures__/cucumber-result-invalid.json` | `"not valid json"` | Tests JSON parse fallback |
| `__fixtures__/pass2-common-steps.json` | Real LLM response | Run `record-llm-fixtures.ts` |
| `__fixtures__/pass2-feature-steps.json` | Real LLM response | Run `record-llm-fixtures.ts` |

---

## Required Code Changes Before Tests Can Run

| Change | File | Why |
|--------|------|-----|
| `export const STEP_SHARED_RULES` | `generator.ts` | Tests import it directly |
| `export { extractCucumberErrors }` | `verifier.ts` | Tests call it directly |
| `record-llm-fixtures.ts` script | `scripts/` | One-time LLM fixture recording |

---

## Implementation Order

```
1. export-step-shared-rules     (2 min — one keyword change)
2. prompt-string-tests          (10 min — extend generator.test.ts)
3. strip-markdown-tests         (5 min — extend generator.test.ts)
4. cucumber-error-fixture       (15 min — write 5 JSON fixture files)
5. export-verifier-internals    (2 min — one export change in verifier.ts)
6. extractor-tests              (15 min — new verifier.test.ts)
7. self-heal-tests              (20 min — extend verifier.test.ts with vi.mock)
8. record-llm-fixtures          (30 min — script + one real LLM call)
9. fixture-compliance-tests     (15 min — new generator.fixtures.test.ts)
```

**Total: ~2h including the one real LLM recording call. After that, `pnpm test` is free and < 15 s.**

---

---

## Explorer Navigation — Why Not Unit Tested Here

The `pageNavigate` fix (direct `page.goto()` instead of `stagehand.act("Navigate to URL")`) was validated by the running job flow and is the correct approach. It's intentionally excluded from this unit test plan for two reasons:

1. **Testability requires refactoring.** `pageNavigate` is a closure inside `runExplorer`, which has 15+ side effects (Redis updates, SSE events, screenshot writes, Stagehand init). Extracting it to a testable unit requires splitting `runExplorer` — a separate refactor task.
2. **The bug class is different.** Explorer bugs show up as "wrong number of steps" (observable in job output), not as silent type errors or JSON parse failures. The full smoke test (`scripts/smoke-test.sh`) is the right validation surface for this.

If `pageNavigate` needs unit testing, extract it as `export function buildNavigator(stagehand: V3): (url: string) => Promise<void>` — then it's a pure function that's trivially testable.

---

## Definition of Done

- `pnpm test` in `packages/backend` exits 0
- All 38 ISCs pass (see ISA at `MEMORY/WORK/20260518-123501_picklescout-pipeline-unit-tests/ISA.md`)
- No test requires `REDIS_URL`, Docker, or a live LLM API
- Adding a new DOM API to `STEP_SHARED_RULES` without a test update causes a red test
- Weakening the DOM-API guard in `STEP_SHARED_RULES` causes red tests in both prompt-string AND fixture-compliance suites
