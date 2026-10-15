import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import { readFileSync } from 'fs';
import { runInNewContext } from 'vm';
import * as ts from 'typescript';
import type OpenAI from 'openai';
import os from 'os';
import path from 'path';
import type * as GeneratorModule from './generator';
import fillByLabel from '../templates/steps/fill_by_label';

// Mock side-effecting modules before importing the module under test
vi.mock('./sse', () => ({ emitEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../redis', () => ({ updateJobStatus: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../utils/safeLog', () => ({ safeDiagnostic: (value: unknown) => JSON.stringify(value) }));
vi.mock('./generator', async (importOriginal) => {
  const actual = await importOriginal<typeof GeneratorModule>();
  return { ...actual, buildOpenAIClient: vi.fn() };
});

import { checkStepResolution, extractCucumberErrors, attemptSelfHeal } from './verifier';
import { buildOpenAIClient } from './generator';
import type { JobState } from '../types';

const FIXTURES = path.join(__dirname, '__fixtures__');

function makeJobState(): JobState {
  return {
    hash: 'test-hash',
    url: 'https://example.com',
    status: 'self_healing',
    llm: { provider: 'openrouter', apiKey: 'test-key', model: 'test-model' },
    options: { maxScenarios: 3, positiveRatio: 0.8, maxSteps: 15, verificationMode: 'smoke', maxRetries: 2 },
    tokenUsage: { promptTokens: 0, completionTokens: 0, estimatedCostUSD: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as JobState;
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

// ─── extractCucumberErrors ────────────────────────────────────────────────────

describe('extractCucumberErrors', () => {
  it('returns error string with scenario name on failure', async () => {
    const errors = await extractCucumberErrors(path.join(FIXTURES, 'cucumber-result-failed.json'), ['fallback']);
    expect(errors[0]).toContain('Create a new sales order');
  });

  it('includes the failed step name', async () => {
    const errors = await extractCucumberErrors(path.join(FIXTURES, 'cucumber-result-failed.json'), []);
    expect(errors[0]).toContain('I click the New button');
  });

  it('includes the error_message text', async () => {
    const errors = await extractCucumberErrors(path.join(FIXTURES, 'cucumber-result-failed.json'), []);
    expect(errors[0]).toContain('TimeoutError');
  });

  it('returns fallback when all steps pass', async () => {
    const fallback = ['no real errors'];
    const errors = await extractCucumberErrors(path.join(FIXTURES, 'cucumber-result-passed.json'), fallback);
    expect(errors).toEqual(fallback);
  });

  it('treats undefined steps as errors', async () => {
    const errors = await extractCucumberErrors(path.join(FIXTURES, 'cucumber-result-undefined.json'), []);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('treats pending steps as errors', async () => {
    const errors = await extractCucumberErrors(path.join(FIXTURES, 'cucumber-result-pending.json'), []);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('does not generate errors for skipped steps — only one error for the failed step', async () => {
    const errors = await extractCucumberErrors(path.join(FIXTURES, 'cucumber-result-failed.json'), []);
    expect(errors).toHaveLength(1);
  });

  it('falls back to raw array when file does not exist', async () => {
    const fallback = ['raw stderr output'];
    const errors = await extractCucumberErrors('/nonexistent/path.json', fallback);
    expect(errors).toEqual(fallback);
  });

  it('falls back to raw array when file contains invalid JSON', async () => {
    const fallback = ['raw stderr'];
    const errors = await extractCucumberErrors(path.join(FIXTURES, 'cucumber-result-invalid.json'), fallback);
    expect(errors).toEqual(fallback);
  });
});

describe('checkStepResolution — escaped string parameters', () => {
  it('matches a Cucumber string containing both quote styles', async () => {
    const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picklescout-resolution-'));
    await fs.mkdir(path.join(artifactDir, 'features'));
    await fs.mkdir(path.join(artifactDir, 'steps'));
    await fs.writeFile(
      path.join(artifactDir, 'features', 'quoted.feature'),
      `Feature: Quoted text

  Scenario: Quoted text
    Then I should see "Bob's \\"quoted\\" text"
`,
    );
    await fs.writeFile(
      path.join(artifactDir, 'steps', 'steps.ts'),
      `Then('I should see {string}', async function (text: string) {})`,
    );

    try {
      await expect(checkStepResolution(artifactDir)).resolves.toEqual([]);
    } finally {
      await fs.rm(artifactDir, { recursive: true, force: true });
    }
  });
});

// ─── attemptSelfHeal — data boundary (R2) ────────────────────────────────────

const INTENT_SPEC = {
  version: '1.0.0',
  targetUrl: 'https://example.com',
  scenarios: [
    {
      name: 'Submit flow',
      steps: [
        { templateId: 'navigate_to_url', params: { url: 'https://example.com' }, description: 'go' },
        { templateId: 'click_by_role', params: { name: 'Submit', role: 'button' }, description: 'click submit' },
        { templateId: 'click_by_text', params: { text: 'Continue' }, description: 'click continue' },
        { templateId: 'assert_visible', params: { text: 'Receipt' }, description: 'see receipt' },
      ],
    },
  ],
};

const VALID_LOCATOR = { method: 'getByRole', value: 'Submit', role: 'button', selector: '[data-testid="submit"]' };
const VALID_PLAN = { version: 1, locators: [VALID_LOCATOR], actionTimeoutMs: 45000 };


// Run the shipped template, not a second copy of its validator.
const worldCode = ts.transpileModule(
  readFileSync(path.join(__dirname, '../templates/world.ts.template'), 'utf-8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } },
).outputText;

function instantiateWorld(plan: unknown): unknown {
  const exports: { CustomWorld?: new (options: Record<string, unknown>) => unknown } = {};
  runInNewContext(worldCode, {
    exports,
    __dirname: '/generated/support',
    require(id: string): unknown {
      if (id === '@cucumber/cucumber') return { World: class {}, setWorldConstructor() {} };
      if (id === 'fs') return { readFileSync: () => JSON.stringify(plan) };
      if (id === 'path') return path;
      throw new Error(`Unexpected template dependency: ${id}`);
    },
  });
  if (!exports.CustomWorld) throw new Error('Missing CustomWorld export');
  return new exports.CustomWorld({});
}

function planWithLocator(locator: Record<string, unknown>, actionTimeoutMs = 30000) {
  return { version: 1, locators: [locator], actionTimeoutMs };
}

const VALIDATOR_CASES: Array<[string, unknown, boolean, boolean?]> = [
  ['selector length 500', planWithLocator({ ...VALID_LOCATOR, selector: 'a'.repeat(500) }), true],
  ['selector length 501', planWithLocator({ ...VALID_LOCATOR, selector: 'a'.repeat(501) }), false],
  ['empty selector', planWithLocator({ ...VALID_LOCATOR, selector: '' }), false],
  ['value length 300', planWithLocator({ ...VALID_LOCATOR, value: 'a'.repeat(300) }), true],
  ['value length 301', planWithLocator({ ...VALID_LOCATOR, value: 'a'.repeat(301) }), false],
  ['empty value', planWithLocator({ ...VALID_LOCATOR, value: '' }), false],
  ['whitespace value', planWithLocator({ ...VALID_LOCATOR, value: ' ' }), false, true],
  ['XPath prefix', planWithLocator({ ...VALID_LOCATOR, selector: 'xpath=//a' }), false],
  ['absolute XPath', planWithLocator({ ...VALID_LOCATOR, selector: '/html[1]/body' }), false, true],
  ['XPath descendant', planWithLocator({ ...VALID_LOCATOR, selector: '//div' }), false],
  ['uppercase XPath', planWithLocator({ ...VALID_LOCATOR, selector: 'XPATH=//a' }), false],
  ['padded XPath', planWithLocator({ ...VALID_LOCATOR, selector: '  XPATH=//a ' }), false],
  ['relative XPath', planWithLocator({ ...VALID_LOCATOR, selector: '../a' }), false],
  ['grouped XPath', planWithLocator({ ...VALID_LOCATOR, selector: '(//a)[1]' }), false],
  ['testid selector', planWithLocator(VALID_LOCATOR), true],
  ['class selector', planWithLocator({ ...VALID_LOCATOR, selector: 'button.primary' }), true],
  ['unknown plan key', { ...VALID_PLAN, extra: true }, false],
  ['unknown locator key', planWithLocator({ ...VALID_LOCATOR, extra: true }), false],
  ['missing role', planWithLocator({ method: 'getByRole', value: 'Submit', selector: 'button' }), false],
  ['role on getByText', planWithLocator({ method: 'getByText', value: 'Continue', role: 'button', selector: 'button' }), false],
  ['timeout 29999', planWithLocator(VALID_LOCATOR, 29999), false],
  ['timeout 45001', planWithLocator(VALID_LOCATOR, 45001), false],
  ['timeout 30000.5', planWithLocator(VALID_LOCATOR, 30000.5), false],
  ['timeout 30000', planWithLocator(VALID_LOCATOR, 30000), true],
  ['timeout 45000', planWithLocator(VALID_LOCATOR, 45000), true],
];
async function makeArtifactDir(intentSpec: unknown = INTENT_SPEC): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'picklescout-selfheal-'));
  await fs.writeFile(path.join(dir, 'intent-spec.json'), JSON.stringify(intentSpec), 'utf-8');
  return dir;
}

describe('attemptSelfHeal — repair data boundary', () => {
  let artifactDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    artifactDir = await makeArtifactDir();
  });

  afterEach(async () => {
    await fs.rm(artifactDir, { recursive: true, force: true });
  });

  it.each(VALIDATOR_CASES)('matches the generator/runtime boundary: %s', async (_name, plan, accepted, worldAccepted = accepted) => {
    const intent = {
      ...INTENT_SPEC,
      scenarios: [{
        ...INTENT_SPEC.scenarios[0],
        steps: [
          ...INTENT_SPEC.scenarios[0].steps,
          ...['a'.repeat(300), 'a'.repeat(301), '', ' '].map((name) => ({
            templateId: 'click_by_role', params: { name, role: 'button' }, description: 'boundary source',
          })),
        ],
      }],
    };
    await fs.writeFile(path.join(artifactDir, 'intent-spec.json'), JSON.stringify(intent));
    vi.mocked(buildOpenAIClient).mockReturnValue(mockLLMResponse(JSON.stringify(plan)));
    if (accepted) {
      const result = await attemptSelfHeal(makeJobState(), artifactDir, []);
      expect(result).toEqual(plan);
      expect(() => instantiateWorld(result)).not.toThrow();
    } else {
      await expect(attemptSelfHeal(makeJobState(), artifactDir, [])).rejects.toThrow('Self-heal response rejected.');
    }
    if (worldAccepted) {
      expect(() => instantiateWorld(plan)).not.toThrow();
    } else {
      expect(() => instantiateWorld(plan)).toThrow('Invalid repair plan: repair.json failed validation.');
    }
  });

  it('rejects distinct source tuples that collide in the runtime repair map', async () => {
    const locators = [
      { ...VALID_LOCATOR, role: 'button::primary', value: 'Submit' },
      { ...VALID_LOCATOR, role: 'button', value: 'primary::Submit' },
    ];
    await fs.writeFile(path.join(artifactDir, 'intent-spec.json'), JSON.stringify({
      ...INTENT_SPEC,
      scenarios: [{
        name: 'Runtime key collision',
        steps: locators.map(({ role, value }) => ({
          templateId: 'click_by_role', params: { name: value, role }, description: 'click',
        })),
      }],
    }));
    const plan = { ...VALID_PLAN, locators };
    vi.mocked(buildOpenAIClient).mockReturnValue(mockLLMResponse(JSON.stringify(plan)));
    await expect(attemptSelfHeal(makeJobState(), artifactDir, [])).rejects.toThrow('Self-heal response rejected.');
    expect(() => instantiateWorld(plan)).toThrow('Invalid repair plan: repair.json failed validation.');
  });

  it('accepts a valid plan using an allowed role locator at the timeout ceiling', async () => {
    vi.mocked(buildOpenAIClient).mockReturnValue(mockLLMResponse(JSON.stringify(VALID_PLAN)));
    const result = await attemptSelfHeal(makeJobState(), artifactDir, ['TimeoutError on submit']);
    expect(result).toEqual(VALID_PLAN);
  });

  it('parses a markdown-fenced valid plan response', async () => {
    const fenced = '```json\n' + JSON.stringify(VALID_PLAN) + '\n```';
    vi.mocked(buildOpenAIClient).mockReturnValue(mockLLMResponse(fenced));
    const result = await attemptSelfHeal(makeJobState(), artifactDir, []);
    expect(result).toEqual(VALID_PLAN);
  });

  it('rejects a locator for a source not present in the intent spec', async () => {
    const plan = { version: 1, locators: [{ method: 'getByText', value: 'Nonexistent', selector: 'x' }], actionTimeoutMs: 30000 };
    vi.mocked(buildOpenAIClient).mockReturnValue(mockLLMResponse(JSON.stringify(plan)));
    await expect(attemptSelfHeal(makeJobState(), artifactDir, [])).rejects.toThrow('Self-heal response rejected.');
  });

  it('rejects a getByRole locator with the wrong role for its source', async () => {
    const plan = { version: 1, locators: [{ method: 'getByRole', value: 'Submit', role: 'link', selector: 'x' }], actionTimeoutMs: 30000 };
    vi.mocked(buildOpenAIClient).mockReturnValue(mockLLMResponse(JSON.stringify(plan)));
    await expect(attemptSelfHeal(makeJobState(), artifactDir, [])).rejects.toThrow('Self-heal response rejected.');
  });

  it('rejects a getByText locator that remaps an assertion source (Receipt)', async () => {
    const plan = { version: 1, locators: [{ method: 'getByText', value: 'Receipt', selector: 'x' }], actionTimeoutMs: 30000 };
    vi.mocked(buildOpenAIClient).mockReturnValue(mockLLMResponse(JSON.stringify(plan)));
    await expect(attemptSelfHeal(makeJobState(), artifactDir, [])).rejects.toThrow('Self-heal response rejected.');
  });

  it('rejects duplicate locators for the same source', async () => {
    const plan = { version: 1, locators: [VALID_LOCATOR, VALID_LOCATOR], actionTimeoutMs: 30000 };
    vi.mocked(buildOpenAIClient).mockReturnValue(mockLLMResponse(JSON.stringify(plan)));
    await expect(attemptSelfHeal(makeJobState(), artifactDir, [])).rejects.toThrow('Self-heal response rejected.');
  });

  it('rejects an extra "files" key alongside otherwise-valid fields', async () => {
    const plan = { version: 1, locators: [], actionTimeoutMs: 30000, files: [{ filename: 'added.ts', content: 'x' }] };
    vi.mocked(buildOpenAIClient).mockReturnValue(mockLLMResponse(JSON.stringify(plan)));
    await expect(attemptSelfHeal(makeJobState(), artifactDir, [])).rejects.toThrow('Self-heal response rejected.');
  });

  it('rejects an unknown top-level key (filename)', async () => {
    const plan = { version: 1, locators: [], actionTimeoutMs: 30000, filename: 'append-to-steps.ts' };
    vi.mocked(buildOpenAIClient).mockReturnValue(mockLLMResponse(JSON.stringify(plan)));
    await expect(attemptSelfHeal(makeJobState(), artifactDir, [])).rejects.toThrow('Self-heal response rejected.');
  });

  it('rejects an XPath selector', async () => {
    const plan = { version: 1, locators: [{ method: 'getByText', value: 'Continue', selector: '//div[1]' }], actionTimeoutMs: 30000 };
    vi.mocked(buildOpenAIClient).mockReturnValue(mockLLMResponse(JSON.stringify(plan)));
    await expect(attemptSelfHeal(makeJobState(), artifactDir, [])).rejects.toThrow('Self-heal response rejected.');
  });

  it('rejects a timeout below the floor (29999)', async () => {
    const plan = { version: 1, locators: [], actionTimeoutMs: 29999 };
    vi.mocked(buildOpenAIClient).mockReturnValue(mockLLMResponse(JSON.stringify(plan)));
    await expect(attemptSelfHeal(makeJobState(), artifactDir, [])).rejects.toThrow('Self-heal response rejected.');
  });

  it('rejects a timeout above the ceiling (45001)', async () => {
    const plan = { version: 1, locators: [], actionTimeoutMs: 45001 };
    vi.mocked(buildOpenAIClient).mockReturnValue(mockLLMResponse(JSON.stringify(plan)));
    await expect(attemptSelfHeal(makeJobState(), artifactDir, [])).rejects.toThrow('Self-heal response rejected.');
  });

  it('rejects a fractional timeout', async () => {
    const plan = { version: 1, locators: [], actionTimeoutMs: 30000.5 };
    vi.mocked(buildOpenAIClient).mockReturnValue(mockLLMResponse(JSON.stringify(plan)));
    await expect(attemptSelfHeal(makeJobState(), artifactDir, [])).rejects.toThrow('Self-heal response rejected.');
  });

  it('rejects a null response', async () => {
    vi.mocked(buildOpenAIClient).mockReturnValue(mockLLMResponse('null'));
    await expect(attemptSelfHeal(makeJobState(), artifactDir, [])).rejects.toThrow('Self-heal response rejected.');
  });

  it('rejects a legacy file-array response carrying code instead of a data plan', async () => {
    const legacy = {
      files: [
        { filename: 'added.ts', content: 'export default 1;' },
        { filename: 'append-to-steps.ts', content: 'Given("x", async () => {})' },
      ],
    };
    vi.mocked(buildOpenAIClient).mockReturnValue(mockLLMResponse(JSON.stringify(legacy)));
    await expect(attemptSelfHeal(makeJobState(), artifactDir, [])).rejects.toThrow('Self-heal response rejected.');
  });

  it('rejects a non-JSON response', async () => {
    vi.mocked(buildOpenAIClient).mockReturnValue(mockLLMResponse('I cannot repair these files.'));
    await expect(attemptSelfHeal(makeJobState(), artifactDir, [])).rejects.toThrow('Self-heal response rejected.');
  });

  it('never writes any file to the artifact directory', async () => {
    vi.mocked(buildOpenAIClient).mockReturnValue(mockLLMResponse(JSON.stringify(VALID_PLAN)));
    await attemptSelfHeal(makeJobState(), artifactDir, []);
    const entries = await fs.readdir(artifactDir);
    expect(entries).toEqual(['intent-spec.json']);
  });
});

describe('attemptSelfHeal — repair reaches the real step implementation', () => {
  it('a fill_by_label repair redirects the textbox lookup the shipped step actually performs', async () => {
    const artifactDir = await makeArtifactDir({
      ...INTENT_SPEC,
      scenarios: [{
        name: 'Fill email',
        steps: [{ templateId: 'fill_by_label', params: { field: 'Email', value: 'a@b.c' }, description: 'fill' }],
      }],
    });
    const plan = planWithLocator({ method: 'getByRole', value: 'Email', role: 'textbox', selector: '#email' });
    vi.mocked(buildOpenAIClient).mockReturnValue(mockLLMResponse(JSON.stringify(plan)));
    try {
      const accepted = await attemptSelfHeal(makeJobState(), artifactDir, []);

      const filled: string[] = [];
      const locatorFor = (source: string) => {
        const locator = { count: async () => (source === '#email' ? 1 : 0), first: () => locator, fill: async () => { filled.push(source); } };
        return locator;
      };
      // Unrepaired lookups find nothing; only the repaired selector matches.
      const page = {
        setDefaultTimeout: () => undefined,
        locator: locatorFor,
        getByRole: () => locatorFor('role'),
        getByLabel: () => locatorFor('label'),
      };
      const world = instantiateWorld(accepted) as { page: unknown };
      world.page = page;

      let step: ((this: unknown, field: string, value: string) => Promise<void>) | undefined;
      const stepCode = ts.transpileModule(fillByLabel.implementation, { compilerOptions: { target: ts.ScriptTarget.ES2019 } }).outputText;
      runInNewContext(stepCode, { When: (_pattern: string, fn: typeof step) => { step = fn; } });
      await step?.call(world, 'Email', 'a@b.c');

      expect(filled).toEqual(['#email']);
    } finally {
      await fs.rm(artifactDir, { recursive: true, force: true });
    }
  });
});
