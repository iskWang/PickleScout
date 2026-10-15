/**
 * Verifier worker — runs generated tests to ensure they pass.
 *
 * Modes (PRD §3.5):
 * - syntax-only: Parse .feature + tsc compile only; no browser
 * - smoke (default): Run cucumber-js once per scenario, no flake retry
 * - full: Run twice on flake before declaring failure (Phase 2)
 *
 * Self-healing scope (PRD §3.4 / review R2):
 * - attemptSelfHeal returns DATA ONLY (a RepairPlan of Playwright locators + a
 *   timeout), never program files or code. The model never sees or edits
 *   step/feature source; it can only pick stable locators already present in
 *   the generated intent spec.
 * - Disallowed: changing scenario intent, removing assertions, modifying step
 *   text, remapping an assertion's source to an action locator.
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import type { JobState, StepResolutionResult, VerificationMode, IntentSpec } from '../types';
import { updateJobStatus } from '../redis';
import { emitEvent } from './sse';
import { buildOpenAIClient, stripMarkdownJson } from './generator';
import { safeDiagnostic } from '../utils/safeLog';

export interface VerificationResult {
  passed: boolean;
  errors: string[];
  mode: VerificationMode;
}

// ─── Main Verifier ────────────────────────────────────────────────────────────

export async function runVerifier(
  state: JobState,
  artifactDir: string,
  signal?: AbortSignal
): Promise<VerificationResult> {
  const { hash, options } = state;

  await updateJobStatus(hash, { status: 'verifying' });
  await emitEvent(hash, { type: 'status', status: 'verifying' });

  switch (options.verificationMode) {
    case 'syntax-only':
      return runSyntaxCheck(hash, artifactDir, signal);
    case 'smoke':
    case 'full':
    default:
      return runCucumberSmoke(hash, artifactDir, options.verificationMode, signal);
  }
}

// ─── Shared: ensure node_modules exist in artifactDir ────────────────────────

async function ensureInstalled(artifactDir: string, signal?: AbortSignal): Promise<void> {
  const exists = await fs
    .access(path.join(artifactDir, 'node_modules'))
    .then(() => true)
    .catch(() => false);
  if (exists) return;

  await new Promise<void>((resolve, reject) => {
    const install = spawn('pnpm', ['install', '--ignore-scripts'], {
      cwd: artifactDir,
      timeout: 120_000,
      signal,
    });
    install.on('error', reject);
    install.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('Dependency installation failed.'));
    });
  });
}

// ─── Syntax-only: tsc compile check ──────────────────────────────────────────

async function runSyntaxCheck(hash: string, artifactDir: string, signal?: AbortSignal): Promise<VerificationResult> {
  await emitEvent(hash, { type: 'llm_log', message: 'Syntax check: installing deps…' });
  await ensureInstalled(artifactDir, signal);
  await emitEvent(hash, { type: 'llm_log', message: 'Syntax check: compiling TypeScript…' });

  return new Promise((resolve, reject) => {
    const proc = spawn(
      'pnpm',
      ['exec', 'tsc', '--noEmit', '--strict', '--target', 'ES2022', '--module', 'commonjs'],
      {
        cwd: artifactDir,
        env: process.env,
        timeout: 60_000,
        signal,
      }
    );

    const errors: string[] = [];
    proc.stderr.on('data', (chunk: Buffer) => errors.push(chunk.toString()));
    proc.stdout.on('data', (chunk: Buffer) => errors.push(chunk.toString()));

    proc.on('error', reject);
    proc.on('close', (code) => {
      const passed = code === 0;
      resolve({ passed, errors: passed ? [] : errors, mode: 'syntax-only' });
    });
  });
}

// ─── Smoke / Full: run cucumber-js ───────────────────────────────────────────

async function runCucumberSmoke(
  hash: string,
  artifactDir: string,
  mode: 'smoke' | 'full',
  signal?: AbortSignal
): Promise<VerificationResult> {
  await emitEvent(hash, {
    type: 'llm_log',
    message: `Verification: running cucumber-js (${mode} mode)…`,
  });

  await ensureInstalled(artifactDir, signal);
  const result = await spawnCucumber(hash, artifactDir, signal);

  if (!result.passed && mode === 'full') {
    // In full mode, retry once on flake before self-healing
    await emitEvent(hash, { type: 'llm_log', message: 'Flake detected, retrying once…' });
    const retryResult = await spawnCucumber(hash, artifactDir, signal);
    return { ...retryResult, mode };
  }

  return { ...result, mode };
}

async function spawnCucumber(hash: string, artifactDir: string, signal?: AbortSignal): Promise<Pick<VerificationResult, 'passed' | 'errors'>> {
  return new Promise((resolve, reject) => {
    const resultPath = `/tmp/cucumber-result-${hash}.json`;
    const proc = spawn(
      'pnpm',
      ['exec', 'cucumber-js', '--format', `json:${resultPath}`, '--format', 'progress'],
      {
        cwd: artifactDir,
        env: process.env,
        timeout: 300_000,
        signal,
      }
    );

    const output: string[] = [];
    const collect = (chunk: Buffer) => { output.push(chunk.toString()); };
    proc.stdout.on('data', collect);
    proc.stderr.on('data', collect);

    proc.on('error', reject);
    proc.on('close', async (code) => {
      const passed = code === 0;
      if (passed) {
        await fs.unlink(resultPath).catch(() => undefined);
        resolve({ passed: true, errors: [] });
        return;
      }

      // Extract meaningful failure messages from the cucumber JSON report
      const errors = await extractCucumberErrors(resultPath, output);
      await fs.unlink(resultPath).catch(() => undefined);
      resolve({ passed: false, errors });
    });
  });
}

type CucumberJson = Array<{
  elements?: Array<{
    name?: string;
    steps?: Array<{
      result?: { status: string; error_message?: string; duration?: number };
      name?: string;
    }>;
  }>;
}>;

export async function extractCucumberErrors(resultPath: string, fallback: string[]): Promise<string[]> {
  try {
    const raw = await fs.readFile(resultPath, 'utf-8');
    const report = JSON.parse(raw) as CucumberJson;
    const errors: string[] = [];

    for (const feature of report) {
      for (const scenario of feature.elements ?? []) {
        for (const step of scenario.steps ?? []) {
          const result = step.result;
          if (result && result.status !== 'passed' && result.status !== 'skipped') {
            const scenarioName = scenario.name ?? 'unknown scenario';
            const stepName = step.name ?? 'unknown step';
            const msg = result.error_message ?? `Step "${stepName}" ${result.status}`;
            errors.push(`Scenario: ${scenarioName}\n  Step: ${stepName}\n  ${msg}`);
          }
        }
      }
    }

    return errors.length > 0 ? errors : fallback;
  } catch {
    return fallback;
  }
}

// ─── Step Resolution Validator (PRD §6.6) ────────────────────────────────────

const STEP_KEYWORDS = ['Given', 'When', 'Then', 'And', 'But'] as const;

const CUCUMBER_PARAM_MAP: Record<string, string> = {
  string: `(?:"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`,
  int: '-?\\d+',
  float: '-?\\d+\\.?\\d*',
  word: '\\S+',
};

function cucumberExpressionToRegex(expr: string): RegExp {
  const parts = expr.split(/(\{(?:string|int|float|word)\})/);
  const regexStr = parts.map((part) => {
    const m = part.match(/^\{(\w+)\}$/);
    if (m) return CUCUMBER_PARAM_MAP[m[1]] ?? '.+';
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return new RegExp(`^${regexStr}$`);
}

function buildStepRegexes(content: string): RegExp[] {
  const patterns: RegExp[] = [];
  // Matches: Given(/regex/flags, ...) or Given('expr', ...) or Given("expr", ...)
  const re = /(?:Given|When|Then|And|But)\(\s*(?:\/((?:[^/\\]|\\.)*)\/?([gimsuy]*)|'([^']+)'|"([^"]+)")\s*,/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    try {
      if (match[1] !== undefined) {
        patterns.push(new RegExp(match[1], match[2] ?? ''));
      } else {
        const expr = match[3] ?? match[4] ?? '';
        patterns.push(cucumberExpressionToRegex(expr));
      }
    } catch {
      // Malformed pattern — skip
    }
  }
  return patterns;
}

interface ParsedScenario {
  name: string;
  steps: string[];
}

function parseFeatureFile(content: string): { featureName: string; scenarios: ParsedScenario[] } {
  const lines = content.split('\n');
  let featureName = '';
  const scenarios: ParsedScenario[] = [];
  let current: ParsedScenario | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Feature:')) {
      featureName = trimmed.slice('Feature:'.length).trim();
    } else if (trimmed.startsWith('Scenario Outline:')) {
      if (current) scenarios.push(current);
      current = { name: trimmed.slice('Scenario Outline:'.length).trim(), steps: [] };
    } else if (trimmed.startsWith('Scenario:')) {
      if (current) scenarios.push(current);
      current = { name: trimmed.slice('Scenario:'.length).trim(), steps: [] };
    } else if (current) {
      for (const kw of STEP_KEYWORDS) {
        if (trimmed.startsWith(`${kw} `)) {
          // Replace Scenario Outline <var> and accidental {param} placeholders with quoted values for matching
          const stepText = trimmed.slice(kw.length + 1).trim()
            .replace(/<[^>]+>/g, '"value"')
            .replace(/\{string\}/g, '"value"')
            .replace(/\{int\}/g, '0')
            .replace(/\{float\}/g, '0.0')
            .replace(/\{word\}/g, 'word');
          current.steps.push(stepText);
          break;
        }
      }
    }
  }
  if (current) scenarios.push(current);
  return { featureName, scenarios };
}

export async function checkStepResolution(artifactDir: string): Promise<StepResolutionResult[]> {
  const featuresDir = path.join(artifactDir, 'features');
  const stepsDir = path.join(artifactDir, 'steps');

  let featureFilenames: string[] = [];
  let stepFilenames: string[] = [];
  try {
    [featureFilenames, stepFilenames] = await Promise.all([
      fs.readdir(featuresDir).then((files) => files.filter((f) => f.endsWith('.feature'))),
      fs.readdir(stepsDir).then((files) => files.filter((f) => f.endsWith('.ts'))),
    ]);
  } catch {
    return []; // Directories not yet created — nothing to check
  }

  const allPatterns: RegExp[] = [];
  for (const filename of stepFilenames) {
    const content = await fs.readFile(path.join(stepsDir, filename), 'utf-8');
    allPatterns.push(...buildStepRegexes(content));
  }

  const results: StepResolutionResult[] = [];

  for (const filename of featureFilenames) {
    const content = await fs.readFile(path.join(featuresDir, filename), 'utf-8');
    const { featureName, scenarios } = parseFeatureFile(content);

    for (const scenario of scenarios) {
      const unresolvedSteps: string[] = [];
      const ambiguousSteps: string[] = [];

      for (const stepText of scenario.steps) {
        const matchCount = allPatterns.filter((p) => p.test(stepText)).length;
        if (matchCount === 0) unresolvedSteps.push(stepText);
        else if (matchCount > 1) ambiguousSteps.push(stepText);
      }

      if (unresolvedSteps.length > 0 || ambiguousSteps.length > 0) {
        results.push({
          feature: featureName || filename,
          scenario: scenario.name,
          unresolvedSteps,
          ambiguousSteps,
        });
      }
    }
  }

  return results;
}

// ─── Self-heal attempt ────────────────────────────────────────────────────────

export interface RepairPlan {
  version: 1;
  locators: Array<{
    method: 'getByRole' | 'getByLabel' | 'getByText';
    value: string;
    role?: string;
    selector: string;
  }>;
  actionTimeoutMs: number;
}

type RepairLocator = RepairPlan['locators'][number];
type LocatorMethod = RepairLocator['method'];

interface LocatorTuple {
  method: LocatorMethod;
  value: string;
  role?: string;
}

function tupleKey(t: LocatorTuple): string {
  return `${t.method}\u0000${t.value}\u0000${t.role ?? ''}`;
}

// Templates whose locator may be repaired, mapped to the source tuple they expose.
const REPAIRABLE_EXTRACTORS: Record<string, (params: Record<string, string>) => LocatorTuple | undefined> = {
  click_by_text: (p) => (p.text ? { method: 'getByText', value: p.text } : undefined),
  click_by_label: (p) => (p.label ? { method: 'getByLabel', value: p.label } : undefined),
  click_by_role: (p) => (p.name && p.role ? { method: 'getByRole', value: p.name, role: p.role } : undefined),
  // fill_by_label tries getByRole('textbox', { name }) first and only falls back to
  // getByLabel when nothing matches, so the textbox role is the source a repair must target.
  fill_by_label: (p) => (p.field ? { method: 'getByRole', value: p.field, role: 'textbox' } : undefined),
  select_option: (p) => (p.dropdown ? { method: 'getByLabel', value: p.dropdown } : undefined),
};

const ASSERTION_TEMPLATES: Record<string, true> = { assert_visible: true, assert_not_visible: true };

// Sources used by click/fill/select, minus any source also used by an assertion
// (so a repair can never silently change what an assertion checks for).
function buildAllowedLocators(intentSpec: IntentSpec): Map<string, LocatorTuple> {
  const allowed = new Map<string, LocatorTuple>();
  const excluded = new Set<string>();

  for (const scenario of intentSpec.scenarios ?? []) {
    for (const step of scenario.steps ?? []) {
      const extractor = REPAIRABLE_EXTRACTORS[step.templateId];
      if (extractor) {
        const tuple = extractor(step.params ?? {});
        if (tuple) allowed.set(tupleKey(tuple), tuple);
        continue;
      }
      if (ASSERTION_TEMPLATES[step.templateId]) {
        const text = step.params?.text;
        if (text) excluded.add(tupleKey({ method: 'getByText', value: text }));
      }
    }
  }

  for (const key of excluded) allowed.delete(key);
  return allowed;
}

async function readIntentSpec(artifactDir: string): Promise<IntentSpec> {
  const raw = await fs.readFile(path.join(artifactDir, 'intent-spec.json'), 'utf-8');
  return JSON.parse(raw) as IntentSpec;
}

const EMPTY_REPAIR_PLAN: RepairPlan = { version: 1, locators: [], actionTimeoutMs: 30000 };

async function readCurrentRepairPlan(artifactDir: string): Promise<RepairPlan> {
  try {
    const raw = await fs.readFile(path.join(artifactDir, 'repair.json'), 'utf-8');
    return JSON.parse(raw) as RepairPlan;
  } catch {
    return EMPTY_REPAIR_PLAN;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectedError(): Error {
  return new Error('Self-heal response rejected.');
}

const ROLE_LOCATOR_KEYS = ['method', 'value', 'role', 'selector'] as const;
const PLAIN_LOCATOR_KEYS = ['method', 'value', 'selector'] as const;

// Keep these bounds and XPath checks aligned with the standalone World template.
const MAX_VALUE_LENGTH = 300;
const MAX_SELECTOR_LENGTH = 500;

function isXPathSelector(selector: string): boolean {
  const s = selector.trim().toLowerCase();
  return s.startsWith('//') || s.startsWith('..') || s.startsWith('(') || s.startsWith('xpath=');
}

function validateLocator(item: unknown, allowed: Map<string, LocatorTuple>, seen: Set<string>): RepairLocator {
  if (!isPlainObject(item)) throw rejectedError();

  const method = item.method;
  if (method !== 'getByRole' && method !== 'getByLabel' && method !== 'getByText') throw rejectedError();

  const allowedKeys: readonly string[] = method === 'getByRole' ? ROLE_LOCATOR_KEYS : PLAIN_LOCATOR_KEYS;
  const keys = Object.keys(item);
  if (keys.length !== allowedKeys.length || !keys.every((k) => allowedKeys.includes(k))) throw rejectedError();

  const value = item.value;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_VALUE_LENGTH) throw rejectedError();

  let role: string | undefined;
  if (method === 'getByRole') {
    const roleValue = item.role;
    if (typeof roleValue !== 'string' || roleValue.trim().length === 0) throw rejectedError();
    role = roleValue;
  }

  const selector = item.selector;
  if (typeof selector !== 'string' || selector.length === 0 || selector.length > MAX_SELECTOR_LENGTH) throw rejectedError();
  const lowerSelector = selector.trim().toLowerCase();
  if (isXPathSelector(selector) || lowerSelector.includes('/html[') || lowerSelector.startsWith('/')) {
    throw rejectedError();
  }

  const key = tupleKey({ method, value, role });
  // World uses this key for both duplicate detection and runtime lookup.
  const runtimeKey = `${method}::${role ?? ''}::${value}`;
  if (!allowed.has(key) || seen.has(runtimeKey)) throw rejectedError();
  seen.add(runtimeKey);

  return role !== undefined ? { method, value, role, selector } : { method, value, selector };
}

const PLAN_KEYS = ['version', 'locators', 'actionTimeoutMs'] as const;

function validateRepairPlan(data: unknown, allowed: Map<string, LocatorTuple>): RepairPlan {
  if (!isPlainObject(data)) throw rejectedError();

  const keys = Object.keys(data);
  if (keys.length !== PLAN_KEYS.length || !keys.every((k) => (PLAN_KEYS as readonly string[]).includes(k))) {
    throw rejectedError();
  }
  if (data.version !== 1) throw rejectedError();

  const actionTimeoutMs = data.actionTimeoutMs;
  if (
    typeof actionTimeoutMs !== 'number' ||
    !Number.isInteger(actionTimeoutMs) ||
    actionTimeoutMs < 30000 ||
    actionTimeoutMs > 45000
  ) {
    throw rejectedError();
  }

  if (!Array.isArray(data.locators) || data.locators.length > 100) throw rejectedError();

  const seen = new Set<string>();
  const locators = data.locators.map((item) => validateLocator(item, allowed, seen));

  return { version: 1, locators, actionTimeoutMs };
}

export async function attemptSelfHeal(
  state: JobState,
  artifactDir: string,
  errors: string[],
  signal?: AbortSignal
): Promise<RepairPlan> {
  const { hash } = state;

  await emitEvent(hash, { type: 'status', status: 'self_healing' });
  await emitEvent(hash, { type: 'llm_log', message: 'Self-healing: analyzing verification failures…' });

  const intentSpec = await readIntentSpec(artifactDir);
  const currentPlan = await readCurrentRepairPlan(artifactDir);
  const allowed = buildAllowedLocators(intentSpec);

  const client = buildOpenAIClient(state.llm);

  const systemPrompt = `You are a Playwright self-healing repair planner.
Return ONLY a JSON object with this exact shape, no other keys:
{ "version": 1, "locators": [{ "method": "getByRole" | "getByLabel" | "getByText", "value": string, "role"?: string, "selector": string }], "actionTimeoutMs": number }

Rules:
- Every locator's method/value/role MUST exactly match one entry from ALLOWED SOURCES below. Do not invent, rename, or remap sources.
- "role" is present only when method is "getByRole", and must match the role shown for that source.
- "selector" is plain data handed to a Playwright locator; it is never executed as code. No XPath: no "xpath=" prefix, no "/html[", no leading "/", "..", or "(". Max ${MAX_SELECTOR_LENGTH} characters.
- actionTimeoutMs MUST be an integer between 30000 and 45000.
- Return at most 100 locators; never repeat the same source twice.
- Do NOT return program files, filenames, step code, or any key other than version/locators/actionTimeoutMs.`;

  const allowedList =
    [...allowed.values()]
      .map((t) => (t.role ? `${t.method} "${t.value}" (role: ${t.role})` : `${t.method} "${t.value}"`))
      .join('\n') || '(none)';

  const userPrompt = `Target URL: ${intentSpec.targetUrl}

ALLOWED SOURCES (only these may be repaired):
${allowedList}

Current repair plan:
${JSON.stringify(currentPlan)}

Verification errors:
${safeDiagnostic(errors)}

Return the repaired JSON plan now.`;

  const response = await client.chat.completions.create(
    {
      model: state.llm.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
    },
    { signal }
  );

  const raw = response.choices[0]?.message?.content;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripMarkdownJson(raw ?? ''));
  } catch {
    throw rejectedError();
  }

  return validateRepairPlan(parsed, allowed);
}
