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
import { V3, type V3Options, type Action } from '@browserbasehq/stagehand';
import { chromium } from 'playwright-core';
import { nanoid } from 'nanoid';
import type {
  JobState,
  ActionLog,
  ActionLogEntry,
  LLMConfig,
} from '../types';
import { updateJobStatus, getJobState } from '../redis';
import { emitEvent } from './sse';
import { safeLog } from '../utils/safeLog';

const STORAGE_DIR = process.env.STORAGE_DIR ?? '/storage';
const EXPLORE_MAX_TIME_MS = 15 * 60 * 1000; // 15 minutes limit for exploration

// ─── LLM config → Stagehand V3Options ────────────────────────────────────────

function buildStagehandOptions(llm: LLMConfig): V3Options {
  const base: Partial<V3Options> = {
    env: 'LOCAL',
    verbose: 0,
    localBrowserLaunchOptions: {
      executablePath: chromium.executablePath(),
      headless: true,
      chromiumSandbox: false,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    },
  };

  // V3 model config: { modelName, ...clientOptions }
  // OpenRouter/custom: prefix with 'openai/' so Stagehand routes via createOpenAI + baseURL
  switch (llm.provider) {
    case 'openai':
      return {
        ...base,
        model: { modelName: llm.model, apiKey: llm.apiKey },
      } as V3Options;
    case 'openrouter':
    case 'custom':
      return {
        ...base,
        model: {
          modelName: `openai/${llm.model}`,
          apiKey: llm.apiKey,
          baseURL: llm.baseURL ?? 'https://openrouter.ai/api/v1',
        },
      } as V3Options;
    case 'anthropic':
      return {
        ...base,
        model: { modelName: llm.model, apiKey: llm.apiKey },
      } as V3Options;
    case 'gemini':
      return {
        ...base,
        model: { modelName: llm.model, apiKey: llm.apiKey },
      } as V3Options;
    default:
      throw new Error(`Unknown provider: ${llm.provider}`);
  }
}

// ─── Explorer ─────────────────────────────────────────────────────────────────

export async function runExplorer(state: JobState, signal?: AbortSignal): Promise<ActionLog> {
  const { hash, url, auth, llm, options } = state;

  const withSignal = <T>(promise: Promise<T>): Promise<T> => {
    if (!signal) return promise;
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason ?? new Error('Aborted'));
      const onAbort = () => reject(signal.reason ?? new Error('Aborted'));
      signal.addEventListener('abort', onAbort);
      promise.then(resolve).catch(reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  };
  const screenshotDir = path.join(STORAGE_DIR, 'screenshots', hash);
  await fs.mkdir(screenshotDir, { recursive: true });

  await updateJobStatus(hash, { status: 'exploring' });
  await emitEvent(hash, { type: 'status', status: 'exploring' });

  const stagehandOpts = buildStagehandOptions(llm);
  const stagehand = new V3(stagehandOpts);

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
    await withSignal(stagehand.init());

    // ── Handle form auth ──────────────────────────────────────────────────────
    if (auth?.type === 'form') {
      await withSignal(stagehand.act(`Navigate to ${auth.loginUrl}`));
      await recordEntry({ type: 'goto', url: auth.loginUrl });

      await withSignal(stagehand.act(`Fill the username or login field with "${auth.username}"`));
      await recordEntry({ type: 'fill', selector: auth.usernameSelector ?? 'username input', value: '[REDACTED]', selectorStrategy: 'css' });

      await withSignal(stagehand.act(`Fill the password field with "${auth.password}"`));
      await recordEntry({ type: 'fill', selector: auth.passwordSelector ?? 'password input', value: '[REDACTED]', selectorStrategy: 'css' });

      await withSignal(stagehand.act('Click the login or sign in submit button'));
      await recordEntry({ type: 'click', selector: auth.submitSelector ?? 'submit button', selectorStrategy: 'css' });
    }

    // ── Navigate to target URL ─────────────────────────────────────────────
    await withSignal(stagehand.act(`Navigate to ${url}`));
    await recordEntry({ type: 'goto', url });

    // ── Exploration loop ────────────────────────────────────────────────────
    const hint = state.hint ?? 'Explore CRUD operations: create, read, update, and delete records. Look for forms, buttons, and data tables.';
    const visitedActions = new Set<string>();

    const exploreStartTime = Date.now();

    while (stepNumber < options.maxSteps) {
      // 1. Cooperative cancellation: Check time limits
      if (Date.now() - exploreStartTime > EXPLORE_MAX_TIME_MS) {
        // eslint-disable-next-line no-console
        console.warn(safeLog({ msg: 'Exploration max time reached, finishing gracefully.', hash }));
        break;
      }

      // 2. Cooperative cancellation: Check if user cancelled or system failed the job
      const currentState = await getJobState(hash);
      if (!currentState || currentState.status === 'failed') {
        // eslint-disable-next-line no-console
        console.warn(safeLog({ msg: 'Exploration aborted due to job status change.', hash, status: currentState?.status }));
        break;
      }

      // Observe current page with the goal/hint in mind
      let observations: Action[];
      try {
        observations = await withSignal(stagehand.observe(hint));
      } catch (err) {
        if (signal?.aborted) throw err;
        break;
      }

      if (observations.length === 0) {
        // Retry once with a minimal fallback hint — weak models sometimes return nothing
        // on the first pass with a verbose hint; a simpler prompt often succeeds.
        try {
          observations = await withSignal(
            stagehand.observe('Find any clickable element: button, link, input, or form.')
          );
        } catch (err) {
          if (signal?.aborted) throw err;
        }
        if (observations.length === 0) break;
      }

      // Filter out actions we've already taken on this specific page.
      // Use pathname only — querystring may vary across SPA state changes for the same view.
      const rawUrl = stagehand.context.activePage()?.url() ?? '';
      const currentPath = (() => { try { return new URL(rawUrl).pathname; } catch { return rawUrl; } })();
      const unvisitedObservations = observations.filter(
        (o) => !visitedActions.has(`${currentPath}::${o.selector}::${o.description}`)
      );

      // If we've exhausted all relevant interactive elements here, stop looping
      if (unvisitedObservations.length === 0) break;

      const unvisitedAction = unvisitedObservations[0];

      const observeEntry = await recordEntry({
        type: 'observe',
        text: unvisitedObservations.map((o) => o.description).slice(0, 5).join('; ').slice(0, 300),
      });

      // Take screenshot every 3 steps
      if (stepNumber % 3 === 0) {
        const screenshotFilename = `step-${String(stepNumber).padStart(3, '0')}.png`;
        const screenshotPath = path.join(screenshotDir, screenshotFilename);

        try {
          const page = stagehand.context.activePage() ?? stagehand.context.pages()[0];
          if (page) {
            const buf = await page.screenshot();
            await fs.writeFile(screenshotPath, buf);
            const relPath = path.join('screenshots', hash, screenshotFilename);
            observeEntry.screenshotPath = relPath;
            await emitEvent(hash, {
              type: 'screenshot',
              url: `/api/screenshots/${hash}/${screenshotFilename}`,
            });
          }
        } catch { /* best-effort */ }
      }

      // Execute the specific unvisited action
      try {
        visitedActions.add(`${currentPath}::${unvisitedAction.selector}::${unvisitedAction.description}`);
        await withSignal(stagehand.act(unvisitedAction));
        await recordEntry({ type: 'click', selector: unvisitedAction.selector, text: unvisitedAction.description });
      } catch (err) {
        if (signal?.aborted) throw err;
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
      await stagehand.close();
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
