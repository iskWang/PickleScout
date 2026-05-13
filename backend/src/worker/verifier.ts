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
import type { JobState, VerificationMode } from '../types';
import { updateJobStatus } from '../redis';
import { emitEvent } from './sse';

const STORAGE_DIR = process.env.STORAGE_DIR ?? '/storage';

export interface VerificationResult {
  passed: boolean;
  errors: string[];
  mode: VerificationMode;
}

// ─── Main Verifier ────────────────────────────────────────────────────────────

export async function runVerifier(
  state: JobState,
  artifactDir: string
): Promise<VerificationResult> {
  const { hash, options } = state;

  await updateJobStatus(hash, { status: 'verifying' });
  await emitEvent(hash, { type: 'status', status: 'verifying' });

  switch (options.verificationMode) {
    case 'syntax-only':
      return runSyntaxCheck(hash, artifactDir);
    case 'smoke':
    case 'full':
    default:
      return runCucumberSmoke(hash, artifactDir, options.verificationMode);
  }
}

// ─── Syntax-only: tsc compile check ──────────────────────────────────────────

async function runSyntaxCheck(hash: string, artifactDir: string): Promise<VerificationResult> {
  await emitEvent(hash, { type: 'llm_log', message: 'Syntax check: compiling TypeScript…' });

  return new Promise((resolve, reject) => {
    const proc = spawn(
      'bunx',
      ['tsc', '--noEmit', '--strict', '--target', 'ES2022', '--module', 'commonjs'],
      {
        cwd: artifactDir,
        env: { ...process.env },
        timeout: 60_000,
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
  mode: 'smoke' | 'full'
): Promise<VerificationResult> {
  await emitEvent(hash, {
    type: 'llm_log',
    message: `Verification: running cucumber-js (${mode} mode)…`,
  });

  const result = await spawnCucumber(hash, artifactDir);

  if (!result.passed && mode === 'full') {
    // In full mode, retry once on flake before self-healing
    await emitEvent(hash, { type: 'llm_log', message: 'Flake detected, retrying once…' });
    const retryResult = await spawnCucumber(hash, artifactDir);
    return { ...retryResult, mode };
  }

  return { ...result, mode };
}

async function spawnCucumber(hash: string, artifactDir: string): Promise<Pick<VerificationResult, 'passed' | 'errors'>> {
  // Install deps first if needed
  const nodeModulesExist = await fs
    .access(path.join(artifactDir, 'node_modules'))
    .then(() => true)
    .catch(() => false);

  if (!nodeModulesExist) {
    await new Promise<void>((resolve, reject) => {
      const install = spawn('bun', ['install', '--ignore-scripts'], {
        cwd: artifactDir,
        timeout: 120_000,
      });
      install.on('error', reject);
      install.on('close', (code) => (code === 0 ? resolve() : reject(new Error('bun install failed'))));
    });
  }

  return new Promise((resolve, reject) => {
    const resultPath = `/tmp/cucumber-result-${hash}.json`;
    const proc = spawn(
      'bunx',
      ['cucumber-js', '--format', `json:${resultPath}`],
      {
        cwd: artifactDir,
        env: {
          ...process.env,
          PLAYWRIGHT_BROWSERS_PATH: '0',
        },
        timeout: 300_000, // 5 min max per verification run
      }
    );

    const output: string[] = [];
    proc.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    proc.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));

    proc.on('error', reject);
    proc.on('close', (code) => {
      const passed = code === 0;
      const errors = passed ? [] : output.filter((l) => l.includes('Error') || l.includes('failed'));
      // Clean up per-job result file (best-effort)
      fs.unlink(resultPath).catch(() => undefined);
      resolve({ passed, errors });
    });
  });
}

// ─── Self-heal attempt ────────────────────────────────────────────────────────

export async function attemptSelfHeal(
  state: JobState,
  stepFiles: Array<{ filename: string; content: string }>,
  errors: string[]
): Promise<Array<{ filename: string; content: string }>> {
  const { hash } = state;

  await emitEvent(hash, { type: 'status', status: 'self_healing' });
  await emitEvent(hash, {
    type: 'llm_log',
    message: `Self-healing: attempting selector/timeout fixes (errors: ${errors.slice(0, 2).join('; ')})`,
  });

  // Build OpenAI client for self-healing LLM call
  const { default: OpenAI } = await import('openai');
  const llm = state.llm;

  if (llm.provider === 'anthropic' || llm.provider === 'gemini') {
    throw new Error(`Provider '${llm.provider}' is not supported for self-healing; use openai, openrouter, or custom`);
  }

  const client = new OpenAI({
    apiKey: llm.apiKey,
    baseURL: llm.provider === 'openrouter'
      ? (llm.baseURL ?? 'https://openrouter.ai/api/v1')
      : llm.provider === 'custom' ? llm.baseURL : undefined,
    timeout: parseInt(process.env.LLM_CALL_TIMEOUT_SEC ?? '60', 10) * 1000,
  });

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

Return the repaired files as a JSON object: { "files": [{ "filename": string, "content": string }] }`;

  const filesText = stepFiles.map((f) => `=== ${f.filename} ===\n${f.content}`).join('\n\n');

  const response = await client.chat.completions.create({
    model: llm.model,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Verification errors:\n${errors.join('\n')}\n\nStep files to repair:\n${filesText}`,
      },
    ],
    response_format: { type: 'json_object' },
  });

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
