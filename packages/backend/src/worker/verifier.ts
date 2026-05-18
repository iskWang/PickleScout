/**
 * Verifier worker — runs generated tests to ensure they pass.
 *
 * Modes (PRD §3.5):
 * - syntax-only: Parse .feature + tsc compile only; no browser
 * - smoke (default): Run cucumber-js once per scenario, no flake retry
 * - full: Run twice on flake before declaring failure (Phase 2)
 *
 * Self-healing scope (PRD §3.4):
 * - Allowed: selector replacement, timeout adjustment, wait strategy, assertion refinement
 * - Disallowed: changing scenario intent, removing assertions, modifying step text
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import type { JobState, StepResolutionResult, VerificationMode } from '../types';
import { updateJobStatus } from '../redis';
import { emitEvent } from './sse';
import { buildOpenAIClient } from './generator';

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
    const out: string[] = [];
    install.stdout?.on('data', (chunk: Buffer) => out.push(chunk.toString()));
    install.stderr?.on('data', (chunk: Buffer) => out.push(chunk.toString()));
    install.on('error', reject);
    install.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pnpm install failed (exit ${code}): ${out.slice(-5).join('')}`));
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
      ['exec', 'cucumber-js', '--format', `json:${resultPath}`],
      {
        cwd: artifactDir,
        env: process.env,
        timeout: 300_000, // 5 min max per verification run
        signal,
      }
    );

    const output: string[] = [];
    proc.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    proc.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));

    proc.on('error', reject);
    proc.on('close', (code) => {
      const passed = code === 0;
      const errors = passed ? [] : output.filter((l) => l.includes('Error') || l.includes('failed'));
      fs.unlink(resultPath).catch(() => undefined);
      resolve({ passed, errors });
    });
  });
}

// ─── Step Resolution Validator (PRD §6.6) ────────────────────────────────────

const STEP_KEYWORDS = ['Given', 'When', 'Then', 'And', 'But'] as const;

const CUCUMBER_PARAM_MAP: Record<string, string> = {
  string: '(?:"[^"]*"|\'[^\']*\')',
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

export async function attemptSelfHeal(
  state: JobState,
  stepFiles: Array<{ filename: string; content: string }>,
  errors: string[],
  signal?: AbortSignal
): Promise<Array<{ filename: string; content: string }>> {
  const { hash } = state;

  await emitEvent(hash, { type: 'status', status: 'self_healing' });
  await emitEvent(hash, {
    type: 'llm_log',
    message: `Self-healing: attempting selector/timeout fixes (errors: ${errors.slice(0, 2).join('; ')})`,
  });

  const client = buildOpenAIClient(state.llm);

  const systemPrompt = `You are a Playwright test maintainer performing self-healing repairs.
You may ONLY make these changes:
- Replace CSS selectors with more stable alternatives (prefer aria-label, role, data-testid)
- Extend waitForSelector / waitForURL timeouts
- Replace networkidle waits with explicit element waits
- Tighten or loosen regex in assertions while preserving business intent

You MUST NOT:
- Change scenario intent or business meaning
- Remove any assertion (expect() calls)
- Modify Gherkin step text (it is frozen)
- Remove test scenarios
- Omit files you weren't asked to repair — return EVERY input file in the output, unchanged if you made no edits

The filename field MUST be a bare basename (e.g. "common.steps.ts"), NEVER a path like "steps/common.steps.ts".

Return ALL provided files as a JSON object: { "files": [{ "filename": string, "content": string }] }`;

  const filesText = stepFiles.map((f) => `=== ${f.filename} ===\n${f.content}`).join('\n\n');

  const response = await client.chat.completions.create({
    model: state.llm.model,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Verification errors:\n${errors.join('\n')}\n\nStep files to repair:\n${filesText}`,
      },
    ],
    response_format: { type: 'json_object' },
  }, { signal });

  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error('Self-heal LLM returned empty content');

  let parsed: { files?: Array<{ filename: string; content: string }> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Self-heal LLM returned invalid JSON');
  }
  if (!Array.isArray(parsed?.files)) {
    throw new Error('Self-heal LLM returned unexpected structure (missing files array)');
  }
  return parsed.files;
}
