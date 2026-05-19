/**
 * Generator worker — Two-pass LLM generation.
 *
 * Pass 1: ActionLog → Gherkin .feature files
 * Pass 2: ActionLog + .feature → .steps.ts files (step text frozen after Pass 1)
 *
 * PRD §3.2, §6.5, §6.6
 */

import path from 'path';
import fs from 'fs/promises';
import OpenAI from 'openai';
import { z, ZodError } from 'zod';
import type { ActionLog, IntentSpec, JobState, LLMConfig, TokenUsage } from '../types';
import { updateJobStatus, getJobState } from '../redis';
import { emitEvent } from './sse';
import { safeLog } from '../utils/safeLog';
import { TEMPLATE_CATALOG } from '../templates/steps/index';
import { assembleStepFiles, assembleFeatureFiles } from './assembler';
import { buildPageModel, buildSelectorRegistry } from './mapper';
import { validateOutput } from './output-validator';

const LLM_TIMEOUT = parseInt(process.env.LLM_CALL_TIMEOUT_SEC ?? '60', 10) * 1000;
const STORAGE_DIR = process.env.STORAGE_DIR ?? '/storage';

// ─── OpenAI Client Factory ─────────────────────────────────────────────────────

export function buildOpenAIClient(llm: LLMConfig): OpenAI {
  if (llm.provider === 'anthropic') {
    throw new Error(`Provider 'anthropic' is not supported by the generator; use openai, openrouter, gemini, or custom`);
  }

  const options: ConstructorParameters<typeof OpenAI>[0] = {
    apiKey: llm.apiKey,
    timeout: LLM_TIMEOUT,
  };

  if (llm.provider === 'openrouter') {
    options.baseURL = llm.baseURL ?? 'https://openrouter.ai/api/v1';
    options.defaultHeaders = {
      'HTTP-Referer': 'https://picklescout.app',
      'X-Title': 'PickleScout',
    };
  } else if (llm.provider === 'gemini') {
    // Google's OpenAI-compatible endpoint
    options.baseURL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
  } else if (llm.provider === 'custom' && llm.baseURL) {
    options.baseURL = llm.baseURL;
  }

  return new OpenAI(options);
}

// Strip markdown code fences that some models wrap JSON in
export function stripMarkdownJson(raw: string): string {
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  return match ? match[1].trim() : raw.trim();
}

// ─── Pass 1: ActionLog → Feature Files ────────────────────────────────────────

export function formatActionLogEntry(e: ActionLog['entries'][number]): string {
  return `[${e.type}] ${e.url ?? e.text ?? e.selector ?? ''} ${e.value ? `= "${e.value}"` : ''}`.trim();
}

type ParsedElement = { label: string; role: 'button' | 'link' | 'menuitem' | 'input' | 'other'; gherkin: string };

export function parseStagehandDescription(desc: string): ParsedElement | null {
  const ROLE_SUFFIXES: Array<[RegExp, ParsedElement['role']]> = [
    [/^(.+?)\s+button(?:\s+.+)?$/i, 'button'],
    [/^Link to(?:\s+the)?\s+(.+)$/i, 'link'],
    [/^(.+?)\s+link(?:\s+.+)?$/i, 'link'],
    [/^(.+?)\s+menu\s+item(?:\s+.+)?$/i, 'menuitem'],
    [/^(.+?)\s+(?:input\s+field|input|combobox|field|text\s+box)(?:\s+.+)?$/i, 'input'],
  ];

  for (const [re, role] of ROLE_SUFFIXES) {
    const m = desc.match(re);
    if (!m) continue;
    // For "Link to X" pattern, capture group 1 is the destination label
    const label = m[1].trim();
    if (label.length < 2) continue;
    const gherkin =
      role === 'button' ? `When I click the "${label}" "button"` :
      role === 'link'   ? `When I click the "${label}" "link"` :
      role === 'menuitem' ? `When I click the "${label}" "menuitem"` :
      `When I fill the "${label}" field with "..."`;
    return { label, role, gherkin };
  }
  return null;
}

export function extractObservedElements(entries: ActionLog['entries'], targetUrl?: string): string[] {
  const seen = new Map<string, ParsedElement>(); // label → parsed
  let onTargetPage = !targetUrl;

  for (const e of entries) {
    if (e.type === 'goto') {
      onTargetPage = !targetUrl || (e.url ?? '').startsWith(targetUrl.replace(/\/$/, ''));
      continue;
    }
    if (!onTargetPage || !e.text) continue;
    for (const part of e.text.split(';')) {
      const trimmed = part.trim();
      if (trimmed.length < 3 || trimmed.length > 80) continue;
      const parsed = parseStagehandDescription(trimmed);
      if (parsed && !seen.has(parsed.label)) {
        seen.set(parsed.label, parsed);
      }
    }
  }
  return [...seen.values()].slice(0, 50).map((p) => p.gherkin);
}

const FeatureFilesSchema = z.object({
  files: z.array(
    z.object({
      filename: z.string(),    // e.g. "01_login_flow.feature"
      content: z.string(),     // raw Gherkin
    })
  ),
});

async function pass1GenerateFeatures(
  state: JobState,
  actionLog: ActionLog,
  client: OpenAI,
  signal?: AbortSignal
): Promise<Array<{ filename: string; content: string }>> {
  const { options, llm } = state;
  const positiveCount = Math.round(options.maxScenarios * options.positiveRatio);
  const negativeCount = options.maxScenarios - positiveCount;

  const observedElements = extractObservedElements(actionLog.entries, actionLog.targetUrl);
  const elementsBlock = observedElements.length > 0
    ? `\nOBSERVED ELEMENTS — USE THESE EXACT GHERKIN PATTERNS:
The following step patterns were derived from actual browser observations. Copy them verbatim into your scenarios. Do NOT invent other element names.

${observedElements.map((g) => `- ${g}`).join('\n')}

For assertions (Then steps), use: Then I should see "LABEL" — where LABEL is the quoted label from one of the patterns above.
`
    : '';

  const systemPrompt = `You are a Gherkin test scenario writer.
Generate Cucumber .feature files based on the provided browser ActionLog.
${elementsBlock}
STEP TEXT RULES:
- Feature step text must use ACTUAL QUOTED VALUES — NEVER write {string}, {int}, or any placeholder
- Element names in steps MUST come from the OBSERVED ELEMENTS list above. Do NOT invent names.
- Strip element-type suffixes: "New button" → use "New", not "New button"
- Step text must be precise (case, whitespace, punctuation matter)

SCENARIO LIMIT:
- Generate at most ${options.maxScenarios} scenarios total
- Allocate ${positiveCount} positive (happy path) and ${negativeCount} negative scenarios
- Priority: login flow > primary CRUD > secondary flows > error handling
- If fewer distinct flows exist, generate fewer scenarios

FILE NAMING:
- Use sequential numbering: 01_login_flow.feature, 02_sales_order.feature, etc.

ASSERTIONS:
- Every Then step must validate a business outcome (status text, ID, URL, visible text)
- Do not write Then steps that only check "page did not crash"

Return a JSON object with a "files" array, each item having "filename" and "content" fields.`;

  const userPrompt = `ActionLog for ${actionLog.targetUrl}:
Inferred journeys: ${actionLog.inferredJourneys.join(', ')}
${state.hint ? `User hint: ${state.hint}` : ''}

Actions recorded:
${actionLog.entries.map(formatActionLogEntry).join('\n')}

Generate ${options.maxScenarios} Cucumber .feature file scenarios.`;

  const { content: raw, usage } = await llmCall(client, llm.model, systemPrompt, userPrompt, signal);
  if (!raw) throw new Error('LLM returned empty content for Pass 1');
  await accumulateTokens(state, usage);
  const parsed = FeatureFilesSchema.parse(JSON.parse(stripMarkdownJson(raw)));
  return parsed.files;
}

// ─── Pass 2: ActionLog + Features → IntentSpec ────────────────────────────────

export const STEP_SHARED_RULES = `SELECTOR PRIORITY (annotate with a comment):
  1. [data-testid="..."]
  2. [aria-label="..."]
  3. [role="..."]
  4. CSS class / attribute
  5. :has-text() (combinable)
  6. XPath is FORBIDDEN

FILE ORDERING within each file:
  imports → module-level state → Given → When → Then

STEP TEXT RULES:
- Step definitions MUST match feature step text exactly (case, whitespace, punctuation)
- Use {string} for string params, {int} for integer params

ASSERTION RULES:
- Every Then step must contain at least one expect() call
- A Then step may NOT consist solely of waitForLoadState or waitForSelector
- Validate business outcomes: status text, IDs, URLs, visible text

RUNTIME ENVIRONMENT — CRITICAL:
- Steps run in Node.js (NOT a browser). NEVER use: document, window, HTMLElement, HTMLInputElement, localStorage, sessionStorage, navigator, or any browser-global API.
- Use ONLY: Playwright Page API (world.page.click, world.page.fill, world.page.locator, world.page.waitForSelector, world.page.goto, world.page.getByRole, etc.) and expect() from @playwright/test.
- world.page is available via the CustomWorld context parameter. Always type it as: const { page } = world as CustomWorld;

IMPORTS:
- import { Given, When, Then } from '@cucumber/cucumber';
- import { expect } from '@playwright/test';
- import type { CustomWorld } from '../support/world';`;

const TEMPLATE_CATALOG_VERSION = '1.0.0';

const IntentStepSchema = z.object({
  templateId: z.string(),
  params: z.record(z.string(), z.string()),
  description: z.string(),
});

const IntentScenarioSchema = z.object({
  name: z.string(),
  steps: z.array(IntentStepSchema),
});

const ASSERT_TEMPLATES = new Set(['assert_visible', 'assert_not_visible', 'assert_url_contains']);

const IntentSpecSchema = z.object({
  version: z.string(),
  targetUrl: z.string(),
  scenarios: z.array(IntentScenarioSchema),
}).superRefine((spec, ctx) => {
  spec.scenarios.forEach((scenario, i) => {
    if (scenario.steps.length === 0) return;
    if (scenario.steps[0].templateId !== 'navigate_to_url') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scenarios', i, 'steps', 0], message: `Scenario "${scenario.name}": first step must be navigate_to_url, got "${scenario.steps[0].templateId}"` });
    }
    const hasAssertion = scenario.steps.some((s) => ASSERT_TEMPLATES.has(s.templateId));
    if (!hasAssertion) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scenarios', i], message: `Scenario "${scenario.name}": missing assertion step (assert_visible / assert_not_visible / assert_url_contains)` });
    }
  });
});

function buildCatalogJson(): string {
  return JSON.stringify(
    TEMPLATE_CATALOG.map((t) => ({
      id: t.templateId,
      params: t.requiredParams,
      gherkinVerb: t.gherkinVerb,
      stepPattern: t.stepPattern,
      example: t.example,
    })),
    null,
    2,
  );
}

export async function pass2GenerateIntentSpec(
  state: JobState,
  actionLog: ActionLog,
  featureFiles: Array<{ filename: string; content: string }>,
  client: OpenAI,
  signal?: AbortSignal,
): Promise<IntentSpec> {
  const { llm } = state;
  const catalogJson = buildCatalogJson();
  const featuresText = featureFiles.map((f) => `=== ${f.filename} ===\n${f.content}`).join('\n\n');

  const system = `You are a test scenario mapper. Your job is to map each Gherkin test step to a template from the catalog below.

OUTPUT: A JSON object with this exact shape:
{
  "version": "${TEMPLATE_CATALOG_VERSION}",
  "targetUrl": "<url>",
  "scenarios": [
    {
      "name": "<scenario name>",
      "steps": [
        {
          "templateId": "<id from catalog>",
          "params": { "<param_name>": "<actual value>" },
          "description": "<human description of what this step does>"
        }
      ]
    }
  ]
}

RULES:
- Use ONLY template IDs from the catalog below. Do NOT invent new IDs.
- For click_by_role, the 'role' param MUST be one of: button, link, tab, menuitem, checkbox, radio
- If a Gherkin step cannot be mapped to any template, OMIT it (do not include it in the steps array)
- Do NOT output TypeScript. Do NOT output Gherkin text. Output ONLY the JSON object.

MANDATORY SCENARIO STRUCTURE (violations cause the entire output to be rejected and retried):
- RULE 1: Every scenario's FIRST step MUST be navigate_to_url with the full target URL. No exceptions.
- RULE 2: Every scenario MUST contain at least one assertion step: assert_visible, assert_not_visible, or assert_url_contains. A scenario with only click/fill steps is invalid.
- RULE 3: Do NOT fabricate URLs. Only use the targetUrl or paths clearly observed in the ActionLog.

TEMPLATE CATALOG:
${catalogJson}`;

  const user = `Target URL: ${actionLog.targetUrl}

Gherkin feature files to map:
${featuresText}

ActionLog (browser observations for context):
${actionLog.entries.slice(0, 50).map(formatActionLogEntry).join('\n')}`;

  const { content: raw, usage } = await llmCall(client, llm.model, system, user, signal);
  if (!raw) throw new Error('LLM returned empty content for Pass 2 IntentSpec');
  await accumulateTokens(state, usage);

  return IntentSpecSchema.parse(JSON.parse(stripMarkdownJson(raw)));
}

async function llmCall(
  client: OpenAI,
  model: string,
  system: string,
  user: string,
  signal?: AbortSignal
): Promise<{ content: string; usage: OpenAI.CompletionUsage | undefined }> {
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
  }, { signal });
  return { content: response.choices[0]?.message?.content ?? '', usage: response.usage };
}

async function accumulateTokens(
  state: JobState,
  usage: OpenAI.CompletionUsage | undefined
): Promise<void> {
  if (!usage) return;
  const delta: TokenUsage = {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    estimatedCostUSD: estimateCost(state.llm.model, usage.prompt_tokens, usage.completion_tokens),
  };
  const prior = await getCumulativeTokens(state);
  await updateJobStatus(state.hash, {
    tokenUsage: {
      promptTokens: prior.promptTokens + delta.promptTokens,
      completionTokens: prior.completionTokens + delta.completionTokens,
      estimatedCostUSD: prior.estimatedCostUSD + delta.estimatedCostUSD,
    },
  });
  await emitEvent(state.hash, { type: 'token_usage', delta, cumulative: {
    promptTokens: prior.promptTokens + delta.promptTokens,
    completionTokens: prior.completionTokens + delta.completionTokens,
    estimatedCostUSD: prior.estimatedCostUSD + delta.estimatedCostUSD,
  }});
}

export function extractStepPatterns(content: string): Set<string> {
  const patterns = new Set<string>();
  // String/template literal patterns: Given('text', ...) / "text" / `text`
  const reStr = /\b(Given|When|Then)\s*\(\s*(['"`])((?:\\.|(?!\2).)*)\2/g;
  let m: RegExpExecArray | null;
  while ((m = reStr.exec(content)) !== null) {
    patterns.add(`${m[1]}:${m[3]}`);
  }
  // Regex patterns: Given(/^pattern$/, ...)
  const reRe = /\b(Given|When|Then)\s*\(\s*\/((?:\\.|[^/])+)\/[gimsu]*/g;
  while ((m = reRe.exec(content)) !== null) {
    patterns.add(`${m[1]}:/${m[2]}/`);
  }
  return patterns;
}

export function dedupeStepFile(content: string, commonKeys: Set<string>): string {
  if (commonKeys.size === 0) return content;
  const parts = content.split(/(?=^\s*(?:Given|When|Then)\s*\()/m);
  const kept = parts.filter((part, idx) => {
    if (idx === 0) return true;
    const mStr = part.match(/^\s*(Given|When|Then)\s*\(\s*(['"`])((?:\\.|(?!\2).)*)\2/);
    if (mStr) return !commonKeys.has(`${mStr[1]}:${mStr[3]}`);
    const mRe = part.match(/^\s*(Given|When|Then)\s*\(\s*\/((?:\\.|[^/])+)\/[gimsu]*/);
    if (mRe) return !commonKeys.has(`${mRe[1]}:/${mRe[2]}/`);
    return true;
  });
  return kept.join('');
}

export function extractRequiredStepCoverage(
  featureFiles: Array<{ filename: string; content: string }>
): Array<{ keyword: string; pattern: string }> {
  const seen = new Set<string>();
  const required: Array<{ keyword: string; pattern: string }> = [];
  let lastKeyword = 'When';

  for (const file of featureFiles) {
    for (const rawLine of file.content.split('\n')) {
      const line = rawLine.trim();
      if (/^(?:Feature|Scenario(?: Outline)?|Background|Examples):/.test(line)) {
        lastKeyword = 'When';
        continue;
      }
      const m = line.match(/^(Given|When|Then|And|But)\s+(.+)$/);
      if (!m) continue;

      let keyword = m[1];
      if (keyword === 'And' || keyword === 'But') keyword = lastKeyword;
      else lastKeyword = keyword;

      const pattern = m[2].trim().replace(/"[^"]*"/g, '{string}');
      if (!seen.has(pattern)) {
        seen.add(pattern);
        required.push({ keyword, pattern });
      }
    }
  }

  return required;
}

// ─── Main Generator ───────────────────────────────────────────────────────────

export interface GeneratedArtifact {
  featureFiles: Array<{ filename: string; content: string }>;
  stepFiles: Array<{ filename: string; content: string }>;
}

export async function runGenerator(
  state: JobState,
  actionLog: ActionLog,
  signal?: AbortSignal
): Promise<GeneratedArtifact> {
  const { hash, llm } = state;

  await updateJobStatus(hash, { status: 'generating' });
  await emitEvent(hash, { type: 'status', status: 'generating' });

  const client = buildOpenAIClient(llm);

  // eslint-disable-next-line no-console
  console.log(safeLog({ msg: 'Starting Pass 1 (feature generation)', hash }));
  await emitEvent(hash, { type: 'llm_log', message: 'Pass 1: generating Gherkin scenarios…' });

  // Pass 1: Generate feature files
  let featureFiles: Array<{ filename: string; content: string }>;
  try {
    featureFiles = await pass1GenerateFeatures(state, actionLog, client, signal);
  } catch (err) {
    if (!(err instanceof SyntaxError) && !(err instanceof ZodError)) throw err;
    // eslint-disable-next-line no-console
    console.warn(safeLog({ msg: 'Pass 1 parse error, retrying', hash, err: String(err) }));
    await emitEvent(hash, { type: 'llm_log', message: 'LLM output parse error, retrying Pass 1…' });
    featureFiles = await pass1GenerateFeatures(state, actionLog, client, signal);
  }

  // eslint-disable-next-line no-console
  console.log(safeLog({ msg: 'Pass 1 complete', hash, featureCount: featureFiles.length }));
  await emitEvent(hash, {
    type: 'llm_log',
    message: `Pass 1 complete: ${featureFiles.length} feature file(s) generated`,
  });

  // Pass 2: Map Gherkin steps to templates → IntentSpec
  await emitEvent(hash, { type: 'llm_log', message: 'Pass 2: mapping steps to templates…' });

  let intentSpec;
  try {
    intentSpec = await pass2GenerateIntentSpec(state, actionLog, featureFiles, client, signal);
  } catch (err) {
    if (!(err instanceof SyntaxError) && !(err instanceof ZodError)) throw err;
    // eslint-disable-next-line no-console
    console.warn(safeLog({ msg: 'Pass 2 parse error, retrying', hash, err: String(err) }));
    await emitEvent(hash, { type: 'llm_log', message: 'LLM output parse error, retrying Pass 2…' });
    intentSpec = await pass2GenerateIntentSpec(state, actionLog, featureFiles, client, signal);
  }

  const pageModel = buildPageModel(actionLog.entries);
  buildSelectorRegistry(pageModel); // validates; registry persisted for debugging

  const { files: stepFiles, unimplementedTemplates } = assembleStepFiles(intentSpec, TEMPLATE_CATALOG);
  const assembledFeatureFiles = assembleFeatureFiles(intentSpec, TEMPLATE_CATALOG);

  if (unimplementedTemplates.length > 0) {
    await emitEvent(hash, {
      type: 'llm_log',
      message: `Pass 2: ${unimplementedTemplates.length} template(s) not in catalog: ${unimplementedTemplates.join(', ')}`,
    });
  }

  // eslint-disable-next-line no-console
  console.log(safeLog({ msg: 'Pass 2 complete', hash, stepFileCount: stepFiles.length, unimplemented: unimplementedTemplates.length }));
  await emitEvent(hash, {
    type: 'llm_log',
    message: `Pass 2 complete: ${stepFiles.length} step file(s) assembled from templates`,
  });

  // Output validation — static analysis before packaging
  const validation = validateOutput(assembledFeatureFiles, stepFiles, TEMPLATE_CATALOG);
  if (!validation.valid) {
    const errors = validation.issues.filter((i) => i.severity === 'error');
    // eslint-disable-next-line no-console
    console.warn(safeLog({ msg: 'Output validation errors', hash, count: errors.length }));
    for (const issue of errors) {
      await emitEvent(hash, { type: 'llm_log', message: `[OUTPUT_VALIDATION] ${issue.code}: ${issue.message}` });
    }
  }

  // Persist generated files to storage
  const genDir = path.join(STORAGE_DIR, 'generated', hash);
  await fs.mkdir(path.join(genDir, 'features'), { recursive: true });
  await fs.mkdir(path.join(genDir, 'steps'), { recursive: true });

  await fs.writeFile(path.join(genDir, 'intent-spec.json'), JSON.stringify(intentSpec, null, 2), 'utf-8');

  for (const f of assembledFeatureFiles) {
    await fs.writeFile(path.join(genDir, 'features', path.basename(f.filename)), f.content, 'utf-8');
  }
  for (const s of stepFiles) {
    await fs.writeFile(path.join(genDir, 'steps', path.basename(s.filename)), s.content, 'utf-8');
  }

  return { featureFiles: assembledFeatureFiles, stepFiles };
}

// ─── Pass 2 retry (called by step resolution logic in index.ts) ───────────────

export async function rerunPass2(
  state: JobState,
  actionLog: ActionLog,
  featureFiles: Array<{ filename: string; content: string }>,
  signal?: AbortSignal
): Promise<Array<{ filename: string; content: string }>> {
  const { hash } = state;
  const client = buildOpenAIClient(state.llm);

  await emitEvent(hash, { type: 'llm_log', message: 'Step resolution failed — regenerating Pass 2…' });

  let intentSpec;
  try {
    intentSpec = await pass2GenerateIntentSpec(state, actionLog, featureFiles, client, signal);
  } catch (err) {
    if (!(err instanceof SyntaxError) && !(err instanceof ZodError)) throw err;
    // eslint-disable-next-line no-console
    console.warn(safeLog({ msg: 'Pass 2 retry parse error, retrying once', hash, err: String(err) }));
    await emitEvent(hash, { type: 'llm_log', message: 'LLM output parse error, retrying Pass 2…' });
    intentSpec = await pass2GenerateIntentSpec(state, actionLog, featureFiles, client, signal);
  }

  const { files: stepFiles } = assembleStepFiles(intentSpec, TEMPLATE_CATALOG);

  const genDir = path.join(STORAGE_DIR, 'generated', hash);
  await fs.writeFile(path.join(genDir, 'intent-spec.json'), JSON.stringify(intentSpec, null, 2), 'utf-8');
  for (const s of stepFiles) {
    await fs.writeFile(path.join(genDir, 'steps', path.basename(s.filename)), s.content, 'utf-8');
  }

  // eslint-disable-next-line no-console
  console.log(safeLog({ msg: 'Pass 2 retry complete', hash, stepFileCount: stepFiles.length }));
  await emitEvent(hash, {
    type: 'llm_log',
    message: `Pass 2 retry complete: ${stepFiles.length} step file(s) reassembled`,
  });

  return stepFiles;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const pricing: Record<string, { input: number; output: number }> = {
    'gpt-4o': { input: 5, output: 15 },
    'gpt-4o-mini': { input: 0.15, output: 0.6 },
    'anthropic/claude-haiku-4.5': { input: 0.8, output: 4 },
    'anthropic/claude-sonnet-4-5': { input: 3, output: 15 },
  };

  const rates = pricing[model] ?? { input: 1, output: 3 };
  return (promptTokens * rates.input + completionTokens * rates.output) / 1_000_000;
}

async function getCumulativeTokens(state: JobState): Promise<TokenUsage> {
  const current = await getJobState(state.hash);
  return current?.tokenUsage ?? { promptTokens: 0, completionTokens: 0, estimatedCostUSD: 0 };
}
