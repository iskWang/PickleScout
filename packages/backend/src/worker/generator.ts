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
import type { ActionLog, JobState, LLMConfig, TokenUsage } from '../types';
import { updateJobStatus, getJobState } from '../redis';
import { emitEvent } from './sse';
import { safeLog } from '../utils/safeLog';

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

function patternFromKey(key: string): string {
  return key.slice(key.indexOf(':') + 1);
}

// Strip markdown code fences that some models wrap JSON in
function stripMarkdownJson(raw: string): string {
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  return match ? match[1].trim() : raw.trim();
}

// ─── Pass 1: ActionLog → Feature Files ────────────────────────────────────────

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

  const systemPrompt = `You are a Gherkin test scenario writer.
Generate Cucumber .feature files based on the provided browser ActionLog.

STEP TEXT RULES:
- Feature step text must use ACTUAL QUOTED VALUES, e.g. When I click the "New" button — NEVER write {string}, {int}, or any placeholder in .feature files
- {string} and {int} are ONLY for step definitions (*.steps.ts); they must never appear in Gherkin scenario steps
- Use realistic values derived from the ActionLog (button labels, field names, status texts observed in the browser)
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
${actionLog.entries
  .map((e) => `[${e.type}] ${e.selector ?? e.url ?? e.text ?? ''} ${e.value ? `= "${e.value}"` : ''}`)
  .join('\n')}

Generate ${options.maxScenarios} Cucumber .feature file scenarios.`;

  const { content: raw, usage } = await llmCall(client, llm.model, systemPrompt, userPrompt, signal);
  if (!raw) throw new Error('LLM returned empty content for Pass 1');
  await accumulateTokens(state, usage);
  const parsed = FeatureFilesSchema.parse(JSON.parse(stripMarkdownJson(raw)));
  return parsed.files;
}

// ─── Pass 2: ActionLog + Features → Step Files ────────────────────────────────

const StepFilesSchema = z.object({
  files: z.array(
    z.object({
      filename: z.string(),    // e.g. "login.steps.ts"
      content: z.string(),     // TypeScript step definitions
    })
  ),
});

const CommonStepSchema = z.object({
  files: z.array(z.object({ filename: z.string(), content: z.string() })).length(1),
});

const STEP_SHARED_RULES = `SELECTOR PRIORITY (annotate with a comment):
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

IMPORTS:
- import { Given, When, Then } from '@cucumber/cucumber';
- import { expect } from '@playwright/test';
- import type { CustomWorld } from '../support/world';`;

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

// Pass 2a: generate common.steps.ts with all shared/navigation steps
async function pass2aGenerateCommon(
  state: JobState,
  actionLog: ActionLog,
  featuresText: string,
  client: OpenAI,
  signal?: AbortSignal
): Promise<{ filename: string; content: string }> {

  const system = `You are a Playwright + Cucumber.js step definition writer.
${STEP_SHARED_RULES}

Your task: generate ONLY "common.steps.ts" containing every step that appears in more than one feature file, OR that is a navigation/setup step (login, navigation menus, page loads).
Do NOT include scenario-specific assertion steps in common.steps.ts.
Return a JSON object: { "files": [{ "filename": "common.steps.ts", "content": "..." }] }`;

  const user = `Target URL: ${actionLog.targetUrl}
Actions recorded:
${actionLog.entries.map((e) => `[${e.type}] selector: ${e.selector ?? 'N/A'} value: ${e.value ?? 'N/A'}`).join('\n')}

Feature files:
${featuresText}`;

  const { content, usage } = await llmCall(client, state.llm.model, system, user, signal);
  if (!content) throw new Error('LLM returned empty content for Pass 2a');
  await accumulateTokens(state, usage);

  const parsed = CommonStepSchema.parse(JSON.parse(stripMarkdownJson(content)));
  return parsed.files[0];
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

function injectMissingStubs(
  files: Array<{ filename: string; content: string }>,
  required: Array<{ keyword: string; pattern: string }>,
  commonKeys: Set<string>,
): Array<{ filename: string; content: string }> {
  if (files.length === 0) return files;

  // Collect all pattern strings defined across generated files
  const allDefined = new Set<string>();
  for (const k of commonKeys) allDefined.add(patternFromKey(k));
  for (const f of files) {
    for (const k of extractStepPatterns(f.content)) allDefined.add(patternFromKey(k));
  }

  const missing = required.filter(({ pattern }) => !allDefined.has(pattern));
  if (missing.length === 0) return files;

  const stubLines: string[] = [''];
  for (const { keyword, pattern } of missing) {
    const paramCount = (pattern.match(/\{string\}/g) ?? []).length;
    const paramDecl = Array.from({ length: paramCount }, (_, i) => `_arg${i}: string`).join(', ');
    const fnArgs = paramDecl ? `, ${paramDecl}` : '';
    stubLines.push(`${keyword}('${pattern}', async function (this: CustomWorld${fnArgs}) {`);
    stubLines.push(`  return 'pending';`);
    stubLines.push(`});`);
  }

  const last = files[files.length - 1];
  return [
    ...files.slice(0, -1),
    { filename: last.filename, content: last.content + stubLines.join('\n') + '\n' },
  ];
}

// Pass 2b: generate feature-specific step files, given pattern signatures from common.steps.ts.
// Uses signatures (not full content) to keep the prompt small and reduce the chance the
// LLM ignores the "do not redeclare" rule on weaker models.
async function pass2bGenerateFeatureSteps(
  state: JobState,
  actionLog: ActionLog,
  featureFiles: Array<{ filename: string; content: string }>,
  featuresText: string,
  commonSteps: { filename: string; content: string },
  client: OpenAI,
  signal?: AbortSignal
): Promise<Array<{ filename: string; content: string }>> {
  const commonKeys = extractStepPatterns(commonSteps.content);

  const requiredPatterns = extractRequiredStepCoverage(featureFiles);
  const commonPatterns = new Set([...commonKeys].map(patternFromKey));

  const requiredLines = requiredPatterns
    .filter(({ pattern }) => !commonPatterns.has(pattern))
    .map(({ keyword, pattern }) => `- ${keyword}('${pattern}')`)
    .join('\n');

  const signatureLines = [...commonKeys]
    .map((k) => `- ${k.slice(0, k.indexOf(':'))}('${patternFromKey(k)}')`)
    .join('\n');

  const system = `You are a Playwright + Cucumber.js step definition writer.
${STEP_SHARED_RULES}

These step signatures are already defined in common.steps.ts.
You MUST NOT redeclare any of them in feature-specific files.
Cucumber loads common.steps.ts automatically — duplicates cause an Ambiguous error.

=== Reserved signatures (DO NOT redeclare) ===
${signatureLines || '(none)'}

=== Required patterns — YOU MUST implement ALL of these EXACTLY as written ===
Pattern strings must match character-for-character (word order, "button" vs "link", etc.).
${requiredLines || '(all covered by common.steps.ts)'}

Return a JSON object: { "files": [{ "filename": "XX_name.steps.ts", "content": "..." }, ...] }
Do NOT include common.steps.ts in the output — only feature-specific files.`;

  const user = `Target URL: ${actionLog.targetUrl}
Actions recorded:
${actionLog.entries.map((e) => `[${e.type}] selector: ${e.selector ?? 'N/A'} value: ${e.value ?? 'N/A'}`).join('\n')}

Feature files to implement (one .steps.ts per .feature file):
${featuresText}`;

  const { content, usage } = await llmCall(client, state.llm.model, system, user, signal);
  if (!content) throw new Error('LLM returned empty content for Pass 2b');
  await accumulateTokens(state, usage);

  const parsed = StepFilesSchema.parse(JSON.parse(stripMarkdownJson(content)));
  const deduped = parsed.files
    .filter((f) => path.basename(f.filename) !== 'common.steps.ts')
    .map((f) => ({ filename: f.filename, content: dedupeStepFile(f.content, commonKeys) }));
  return injectMissingStubs(deduped, requiredPatterns, commonKeys);
}

// Pass 2 (public): two-sub-pass + programmatic dedup to prevent duplicate step definitions
async function pass2GenerateSteps(
  state: JobState,
  actionLog: ActionLog,
  featureFiles: Array<{ filename: string; content: string }>,
  client: OpenAI,
  signal?: AbortSignal
): Promise<Array<{ filename: string; content: string }>> {
  const featuresText = featureFiles.map((f) => `=== ${f.filename} ===\n${f.content}`).join('\n\n');
  const commonSteps = await pass2aGenerateCommon(state, actionLog, featuresText, client, signal);
  const featureSteps = await pass2bGenerateFeatureSteps(state, actionLog, featureFiles, featuresText, commonSteps, client, signal);
  return [commonSteps, ...featureSteps];
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

  // Pass 2: Generate step files (step text is now frozen)
  await emitEvent(hash, { type: 'llm_log', message: 'Pass 2: generating step definitions…' });

  let stepFiles: Array<{ filename: string; content: string }>;
  try {
    stepFiles = await pass2GenerateSteps(state, actionLog, featureFiles, client, signal);
  } catch (err) {
    if (!(err instanceof SyntaxError) && !(err instanceof ZodError)) throw err;
    // eslint-disable-next-line no-console
    console.warn(safeLog({ msg: 'Pass 2 parse error, retrying', hash, err: String(err) }));
    await emitEvent(hash, { type: 'llm_log', message: 'LLM output parse error, retrying Pass 2…' });
    stepFiles = await pass2GenerateSteps(state, actionLog, featureFiles, client, signal);
  }

  // eslint-disable-next-line no-console
  console.log(safeLog({ msg: 'Pass 2 complete', hash, stepFileCount: stepFiles.length }));
  await emitEvent(hash, {
    type: 'llm_log',
    message: `Pass 2 complete: ${stepFiles.length} step file(s) generated`,
  });

  // Persist generated files to storage
  const genDir = path.join(STORAGE_DIR, 'generated', hash);
  await fs.mkdir(path.join(genDir, 'features'), { recursive: true });
  await fs.mkdir(path.join(genDir, 'steps'), { recursive: true });

  for (const f of featureFiles) {
    await fs.writeFile(path.join(genDir, 'features', path.basename(f.filename)), f.content, 'utf-8');
  }
  for (const s of stepFiles) {
    await fs.writeFile(path.join(genDir, 'steps', path.basename(s.filename)), s.content, 'utf-8');
  }

  return { featureFiles, stepFiles };
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

  let stepFiles: Array<{ filename: string; content: string }>;
  try {
    stepFiles = await pass2GenerateSteps(state, actionLog, featureFiles, client, signal);
  } catch (err) {
    if (!(err instanceof SyntaxError) && !(err instanceof ZodError)) throw err;
    // eslint-disable-next-line no-console
    console.warn(safeLog({ msg: 'Pass 2 retry parse error, retrying once', hash, err: String(err) }));
    await emitEvent(hash, { type: 'llm_log', message: 'LLM output parse error, retrying Pass 2…' });
    stepFiles = await pass2GenerateSteps(state, actionLog, featureFiles, client, signal);
  }

  const genDir = path.join(STORAGE_DIR, 'generated', hash);
  for (const s of stepFiles) {
    await fs.writeFile(path.join(genDir, 'steps', path.basename(s.filename)), s.content, 'utf-8');
  }

  // eslint-disable-next-line no-console
  console.log(safeLog({ msg: 'Pass 2 retry complete', hash, stepFileCount: stepFiles.length }));
  await emitEvent(hash, {
    type: 'llm_log',
    message: `Pass 2 retry complete: ${stepFiles.length} step file(s) regenerated`,
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
