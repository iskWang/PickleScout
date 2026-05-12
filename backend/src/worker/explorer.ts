/**
 * Explorer worker — Phase 1 of generation pipeline.
 *
 * Uses Stagehand v3 (exported as V3 class) to explore the target URL
 * and produce an ActionLog.
 *
 * Stagehand v3 API:
 * - init() returns Promise<void>
 * - act(instruction: string) — perform an action
 * - observe() — observe the current page
 * - close() — destroy the instance (MUST call on completion/failure)
 * - No .page property; navigation via act("goto URL") or navigate()
 *
 * Constraints:
 * - One Stagehand instance per job
 * - MUST call stagehand.close() on completion or failure
 * - Chromium only
 * - safeLog() before any logger call with job data
 * PRD §3.2, §4.6
 */

import path from 'path';
import fs from 'fs/promises';
import { Stagehand, type V3Options } from '@browserbasehq/stagehand';
import { nanoid } from 'nanoid';
import type {
  JobState,
  ActionLog,
  ActionLogEntry,
  LLMConfig,
} from '../types';
import { updateJobStatus } from '../redis';
import { emitEvent } from './sse';
import { safeLog } from '../utils/safeLog';

const STORAGE_DIR = process.env.STORAGE_DIR ?? '/storage';

// ─── LLM config → Stagehand V3Options ────────────────────────────────────────

function buildStagehandOptions(llm: LLMConfig): V3Options {
  const base: Partial<V3Options> = {
    verbose: 0,
  };

  // Model name + client options vary by provider
  const modelName = llm.model;

  switch (llm.provider) {
    case 'openai':
      return {
        ...base,
        modelName,
        modelClientOptions: { apiKey: llm.apiKey },
      } as V3Options;
    case 'openrouter':
    case 'custom':
      return {
        ...base,
        modelName,
        modelClientOptions: {
          apiKey: llm.apiKey,
          baseURL: llm.baseURL ?? 'https://openrouter.ai/api/v1',
        },
      } as V3Options;
    case 'anthropic':
      return {
        ...base,
        modelName,
        modelClientOptions: { apiKey: llm.apiKey },
      } as V3Options;
    case 'gemini':
      return {
        ...base,
        modelName,
        modelClientOptions: { apiKey: llm.apiKey },
      } as V3Options;
    default:
      throw new Error(`Unknown provider: ${llm.provider}`);
  }
}

// ─── Explorer ─────────────────────────────────────────────────────────────────

export async function runExplorer(state: JobState): Promise<ActionLog> {
  const { hash, url, auth, llm, options } = state;
  const screenshotDir = path.join(STORAGE_DIR, 'screenshots', hash);
  await fs.mkdir(screenshotDir, { recursive: true });

  await updateJobStatus(hash, { status: 'exploring' });
  await emitEvent(hash, { type: 'status', status: 'exploring' });

  const stagehandOpts = buildStagehandOptions(llm);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stagehand = new (Stagehand as any)(stagehandOpts);

  const entries: ActionLogEntry[] = [];
  let stepNumber = 0;

  const recordEntry = async (
    entry: Omit<ActionLogEntry, 'id' | 'timestamp'>
  ): Promise<ActionLogEntry> => {
    stepNumber++;
    const full: ActionLogEntry = {
      id: nanoid(10),
      timestamp: Date.now(),
      ...entry,
    };
    entries.push(full);

    await emitEvent(hash, {
      type: 'step',
      stepNumber,
      action: `${entry.type}${entry.selector ? ` ${entry.selector}` : ''}${entry.url ? ` ${entry.url}` : ''}`,
      selector: entry.selector,
    });

    await updateJobStatus(hash, {
      progress: {
        currentStep: stepNumber,
        maxSteps: options.maxSteps,
        lastAction: `${entry.type} ${entry.selector ?? entry.url ?? ''}`.trim(),
      },
    });

    return full;
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (stagehand as any).init();

    // ── Handle form auth ──────────────────────────────────────────────────────
    if (auth?.type === 'form') {
      await (stagehand as any).act(`Navigate to ${auth.loginUrl}`);
      await recordEntry({ type: 'goto', url: auth.loginUrl });

      await (stagehand as any).act(`Fill the username or login field with "${auth.username}"`);
      await recordEntry({ type: 'fill', selector: auth.usernameSelector ?? 'username input', value: '[REDACTED]', selectorStrategy: 'css' });

      await (stagehand as any).act(`Fill the password field with the password`);
      await recordEntry({ type: 'fill', selector: auth.passwordSelector ?? 'password input', value: '[REDACTED]', selectorStrategy: 'css' });

      await (stagehand as any).act('Click the login or sign in submit button');
      await recordEntry({ type: 'click', selector: auth.submitSelector ?? 'submit button', selectorStrategy: 'css' });
    }

    // ── Navigate to target URL ─────────────────────────────────────────────
    await (stagehand as any).act(`Navigate to ${url}`);
    await recordEntry({ type: 'goto', url });

    // ── Exploration loop ────────────────────────────────────────────────────
    const hint = state.hint ?? 'Explore CRUD operations: create, read, update, and delete records. Look for forms, buttons, and data tables.';

    for (let i = 0; i < options.maxSteps && stepNumber < options.maxSteps; i++) {
      // Observe current page
      let observations: Array<{ description: string; selector?: string }>;
      try {
        observations = await (stagehand as any).observe() as Array<{ description: string; selector?: string }>;
      } catch {
        break;
      }

      if (observations.length === 0) break;

      await recordEntry({
        type: 'observe',
        text: observations.map((o) => o.description).slice(0, 5).join('; ').slice(0, 300),
      });

      // Take screenshot every 3 steps
      if (stepNumber % 3 === 0) {
        const screenshotFilename = `step-${String(stepNumber).padStart(3, '0')}.png`;
        const screenshotPath = path.join(screenshotDir, screenshotFilename);

        try {
          await (stagehand as any).act('Take a screenshot of the current page');
        } catch { /* best-effort */ }

        const relPath = path.join('screenshots', hash, screenshotFilename);
        await emitEvent(hash, {
          type: 'screenshot',
          screenshotUrl: `/api/screenshots/${relPath}`,
        });
      }

      // Let Stagehand explore
      try {
        await (stagehand as any).act(hint);
        await recordEntry({ type: 'click', selector: 'interactive element' });
      } catch {
        // Navigation or action failed — stop exploration gracefully
        break;
      }
    }

    // ── Infer journeys ────────────────────────────────────────────────────────
    const inferredJourneys = inferJourneys(entries);

    const actionLog: ActionLog = {
      jobHash: hash,
      targetUrl: url,
      entries,
      inferredJourneys,
    };

    // Persist action log
    const logDir = path.join(STORAGE_DIR, 'action-logs');
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(
      path.join(logDir, `${hash}.json`),
      JSON.stringify(actionLog, null, 2)
    );

    // eslint-disable-next-line no-console
    console.log(safeLog({ msg: 'Exploration complete', hash, steps: entries.length }));

    return actionLog;
  } finally {
    // MUST destroy Stagehand instance (PRD constraint)
    try {
      await (stagehand as any).close();
    } catch { /* best-effort */ }
  }
}

// ─── Journey Inference ────────────────────────────────────────────────────────

function inferJourneys(entries: ActionLogEntry[]): string[] {
  const journeys: string[] = [];
  const urlPaths = entries
    .filter((e) => e.type === 'goto' && e.url)
    .map((e) => e.url!.toLowerCase());
  const texts = entries
    .filter((e) => e.text)
    .map((e) => e.text!.toLowerCase())
    .join(' ');

  if (urlPaths.some((u) => u.includes('login') || u.includes('signin')) || texts.includes('login')) {
    journeys.push('login');
  }
  if (urlPaths.some((u) => u.includes('sales') || u.includes('order')) || texts.includes('order')) {
    journeys.push('sales_order');
  }
  if (urlPaths.some((u) => u.includes('customer') || u.includes('partner')) || texts.includes('customer')) {
    journeys.push('customer_management');
  }
  if (urlPaths.some((u) => u.includes('product') || u.includes('inventory')) || texts.includes('product')) {
    journeys.push('product_management');
  }
  if (journeys.length === 0) {
    journeys.push('general_crud');
  }

  return journeys;
}
