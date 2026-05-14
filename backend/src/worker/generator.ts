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

function buildOpenAIClient(llm: LLMConfig): OpenAI {
  if (llm.provider === 'anthropic' || llm.provider === 'gemini') {
    throw new Error(`Provider '${llm.provider}' is not supported by the generator; use openai, openrouter, or custom`);
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
  } else if (llm.provider === 'custom' && llm.baseURL) {
    options.baseURL = llm.baseURL;
  }

  return new OpenAI(options);
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
- Feature step text must be precise (case, whitespace, punctuation matter)
- Use {string} for quoted string parameters, {int} for integer parameters
- Write clear, business-readable Gherkin in English

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

  const response = await client.chat.completions.create({
    model: llm.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
  }, { signal });

  const usage = response.usage;
  if (usage) {
    const delta: TokenUsage = {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      estimatedCostUSD: estimateCost(llm.model, usage.prompt_tokens, usage.completion_tokens),
    };
    const prior = await getCumulativeTokens(state);
    const cumulative: TokenUsage = {
      promptTokens: prior.promptTokens + delta.promptTokens,
      completionTokens: prior.completionTokens + delta.completionTokens,
      estimatedCostUSD: prior.estimatedCostUSD + delta.estimatedCostUSD,
    };
    await updateJobStatus(state.hash, { tokenUsage: cumulative });
    await emitEvent(state.hash, { type: 'token_usage', delta, cumulative });
  }

  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error('LLM returned empty content for Pass 1');
  const parsed = FeatureFilesSchema.parse(JSON.parse(raw));
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

async function pass2GenerateSteps(
  state: JobState,
  actionLog: ActionLog,
  featureFiles: Array<{ filename: string; content: string }>,
  client: OpenAI,
  signal?: AbortSignal
): Promise<Array<{ filename: string; content: string }>> {
  const { llm } = state;

  const systemPrompt = `You are a Playwright + Cucumber.js step definition writer.
Generate TypeScript .steps.ts files matching the provided .feature files exactly.

SELECTOR PRIORITY (annotate with a comment):
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
- Do NOT redeclare steps already in common.steps.ts (Given I am logged in, When I fill {string} with {string}, Then the page title should contain {string})

ASSERTION RULES:
- Every Then step must contain at least one expect() call
- A Then step may NOT consist solely of waitForLoadState or waitForSelector
- Validate business outcomes: status text, IDs, URLs, visible text

IMPORTS:
- import { Given, When, Then } from '@cucumber/cucumber';
- import { expect } from '@playwright/test';
- import type { CustomWorld } from '../support/world';

Return a JSON object with a "files" array, each item having "filename" and "content" fields.
Also include a "common.steps.ts" file for any shared steps.`;

  const featuresText = featureFiles
    .map((f) => `=== ${f.filename} ===\n${f.content}`)
    .join('\n\n');

  const userPrompt = `Generate TypeScript step definitions for these feature files.
The step text is FROZEN — match it exactly.

Target URL: ${actionLog.targetUrl}
Actions recorded:
${actionLog.entries
  .map((e) => `[${e.type}] selector: ${e.selector ?? 'N/A'} value: ${e.value ?? 'N/A'}`)
  .join('\n')}

Feature files to implement:
${featuresText}`;

  const response = await client.chat.completions.create({
    model: llm.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
  }, { signal });

  const usage = response.usage;
  if (usage) {
    const delta: TokenUsage = {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      estimatedCostUSD: estimateCost(llm.model, usage.prompt_tokens, usage.completion_tokens),
    };
    const prior = await getCumulativeTokens(state);
    const cumulative: TokenUsage = {
      promptTokens: prior.promptTokens + delta.promptTokens,
      completionTokens: prior.completionTokens + delta.completionTokens,
      estimatedCostUSD: prior.estimatedCostUSD + delta.estimatedCostUSD,
    };
    await updateJobStatus(state.hash, { tokenUsage: cumulative });
    await emitEvent(state.hash, { type: 'token_usage', delta, cumulative });
  }

  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error('LLM returned empty content for Pass 2');
  const parsed = StepFilesSchema.parse(JSON.parse(raw));
  return parsed.files;
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  // Rough pricing estimates (USD per 1M tokens) — not a real bill
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
