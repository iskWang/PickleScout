/**
 * BullMQ Worker — orchestrates the full generation pipeline.
 *
 * Pipeline:
 *   exploring → generating → verifying → [self_healing → verifying]* → completed | failed
 *
 * Concurrency controlled by MAX_CONCURRENT_JOBS env var (default 2).
 * PRD §3.2, §4.5
 */

import { Queue, Worker, type Job } from 'bullmq';
import path from 'path';
import fs from 'fs/promises';
import { getBullRedisClient, getJobState, updateJobStatus, TERMINAL_STATUSES } from '../redis';
import { runExplorer } from './explorer';
import { runGenerator, rerunPass2 } from './generator';
import { runVerifier, attemptSelfHeal, checkStepResolution } from './verifier';
import { runPackager, prepareVerificationDir } from './packager';
import { emitEvent, resetJobCounter } from './sse';
import { safeLog, safeDiagnostic, sanitizeDiagnosticEvent } from '../utils/safeLog';

const STORAGE_DIR = process.env.STORAGE_DIR ?? '/storage';
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_JOBS ?? '2', 10);
const JOB_MAX_DURATION = parseInt(process.env.JOB_MAX_DURATION_SEC ?? '1200', 10) * 1000;

// ─── Queue (exported so routes can enqueue) ───────────────────────────────────

export const generationQueue = new Queue('generation', {
  connection: getBullRedisClient(),
  defaultJobOptions: {
    attempts: 1,      // We handle retries ourselves
    removeOnComplete: true,
    removeOnFail: false,
  },
});

// ─── Worker ───────────────────────────────────────────────────────────────────

export function startWorker(): Worker {
  const worker = new Worker(
    'generation',
    async (job: Job<{ hash: string }>) => {
      const { hash } = job.data;

      // Setup job timeout
      const controller = new AbortController();
      const timeout = setTimeout(async () => {
        // eslint-disable-next-line no-console
        console.error(safeLog({ msg: 'Job timed out', hash }));
        await failJob(hash, 'Job exceeded maximum duration (20 min)');
        controller.abort(new Error('Job exceeded maximum duration (20 min)'));
      }, JOB_MAX_DURATION);

      try {
        await processJob(hash, controller.signal);
      } finally {
        clearTimeout(timeout);
      }
    },
    {
      connection: getBullRedisClient(),
      concurrency: MAX_CONCURRENT,
    }
  );

  worker.on('failed', async (job, err) => {
    if (job) {
      const message = safeDiagnostic(err);
      // eslint-disable-next-line no-console
      console.error(safeLog({ msg: 'Worker job failed', hash: job.data.hash, error: message }));
      await failJob(job.data.hash, message);
    }
  });

  // eslint-disable-next-line no-console
  console.log(`[worker] Started with concurrency=${MAX_CONCURRENT}`);
  return worker;
}

// ─── Pipeline Orchestration ───────────────────────────────────────────────────

export async function processJob(hash: string, signal: AbortSignal): Promise<void> {
  try {
    resetJobCounter(hash);
    const state = await getJobState(hash);
    if (!state) {
      throw new Error('Job state not found in Redis');
    }
    if (TERMINAL_STATUSES.has(state.status)) return;

    // Phase 1: Exploration
    const actionLog = await runExplorer(state, signal);
    const afterExploration = await getJobState(hash);
    if (!afterExploration || TERMINAL_STATUSES.has(afterExploration.status)) return;

    // Detect hallucination risk: exploration produced no interaction entries.
    // The LLM will fall back to training-data guesses about the site, so flag the
    // resulting tests as low-confidence. Self-test 'negative' mode asserts on this.
    const interactionEntries = actionLog.entries.filter(
      (e) => e.type !== 'goto' && e.type !== 'wait',
    );
    if (interactionEntries.length === 0) {
      const reason =
        actionLog.entries.length === 0
          ? 'Exploration captured zero entries — site likely blocked automation'
          : 'Exploration captured only navigation — no interactive elements observed (auth wall, captcha, or empty page)';
      await updateJobStatus(hash, { hallucinationRisk: true, hallucinationReason: reason });
      await emitEvent(hash, {
        type: 'llm_log',
        message: `⚠️ Hallucination risk: ${reason}. Generated tests are based on LLM training data, not the actual page.`,
      });
    }

    // Phase 2: LLM Generation
    const freshState = await getJobState(hash);
    if (!freshState) throw new Error('Job state lost after exploration');
    if (TERMINAL_STATUSES.has(freshState.status)) return;

    const artifact = await runGenerator(freshState, actionLog, signal);
    const afterGeneration = await getJobState(hash);
    if (!afterGeneration || TERMINAL_STATUSES.has(afterGeneration.status)) return;

    // Prepare artifact directory for verification
    const artifactDir = path.join(STORAGE_DIR, 'generated', hash);

    // Step resolution check (PRD §6.6): every feature step must resolve to exactly one definition
    let currentStepFiles = artifact.stepFiles;
    let stepResolutionIssues = await checkStepResolution(artifactDir);

    if (stepResolutionIssues.length > 0) {
      const issueCount = stepResolutionIssues.reduce(
        (n, r) => n + r.unresolvedSteps.length + r.ambiguousSteps.length,
        0,
      );
      await emitEvent(hash, {
        type: 'llm_log',
        message: `Step resolution: ${issueCount} unresolved/ambiguous step(s) detected — regenerating Pass 2…`,
      });

      const rerun = await rerunPass2(freshState, actionLog, artifact.featureFiles, signal);
      artifact.featureFiles = rerun.featureFiles;
      currentStepFiles = rerun.stepFiles;
      stepResolutionIssues = await checkStepResolution(artifactDir);

      if (stepResolutionIssues.length > 0) {
        const details = stepResolutionIssues
          .flatMap((r) => [
            ...r.unresolvedSteps.map((s) => `Unresolved in "${r.scenario}": ${s}`),
            ...r.ambiguousSteps.map((s) => `Ambiguous in "${r.scenario}": ${s}`),
          ])
          .slice(0, 5)
          .join('; ');
        await failJob(hash, `Step resolution failed after Pass 2 retry: ${details}`);
        return;
      }

      await emitEvent(hash, {
        type: 'llm_log',
        message: 'Step resolution: all steps resolved after regeneration',
      });
    }

    // Prepare artifact dir with package.json, tsconfig, cucumber.js, support/ before verifier runs
    await prepareVerificationDir(artifactDir);

    // Phase 3: Verification + self-healing loop
    let verificationResult = await runVerifier(freshState, artifactDir, signal);
    let unhealedScenarios = 0;
    let retries = 0;
    const maxRetries = freshState.options.maxRetries;

    while (!verificationResult.passed && retries < maxRetries) {
      const loopState = await getJobState(hash);
      if (!loopState) throw new Error('Job state lost during self-healing');
      if (TERMINAL_STATUSES.has(loopState.status)) return;

      retries++;
      await emitEvent(hash, {
        type: 'llm_log',
        message: `Verification failed, self-healing attempt ${retries}/${maxRetries}…`,
      });

      const latestState = await getJobState(hash);
      if (!latestState) throw new Error('Job state lost during self-healing');
      if (TERMINAL_STATUSES.has(latestState.status)) return;

      // Attempt self-heal — frozen interface returns a locator RepairPlan only
      // (never rewrites steps/features); the plan is read at runtime by
      // world.ts.template via a Proxy, so nothing else needs to change here.
      try {
        const plan = await attemptSelfHeal(latestState, artifactDir, verificationResult.errors, signal);
        await fs.writeFile(path.join(artifactDir, 'repair.json'), JSON.stringify(plan), 'utf-8');
      } catch {
        await emitEvent(hash, {
          type: 'llm_log',
          message: 'Self-heal response rejected.',
        });
        break;
      }

      // Re-verify
      verificationResult = await runVerifier(latestState, artifactDir, signal);
    }

    if (!verificationResult.passed) {
      // Count unhealed scenarios and tag them
      unhealedScenarios = countUnhealedScenarios(verificationResult.errors);

      await emitEvent(
        hash,
        sanitizeDiagnosticEvent({
          type: 'verification',
          passed: false,
          errors: verificationResult.errors.slice(0, 5),
        }),
      );

      await emitEvent(hash, {
        type: 'llm_log',
        message: `Tests could not be verified after ${maxRetries} retries. Output preserved as unverified.`,
      });
    } else {
      await emitEvent(hash, { type: 'verification', passed: true });
    }

    // Phase 4: Package output
    const finalState = await getJobState(hash);
    if (!finalState) throw new Error('Job state lost before packaging');
    if (TERMINAL_STATUSES.has(finalState.status)) return;

    const updatedArtifact = { ...artifact, stepFiles: currentStepFiles };
    await runPackager(finalState, updatedArtifact, actionLog, verificationResult.passed, unhealedScenarios);

    const beforeFinalStatus = await getJobState(hash);
    if (!beforeFinalStatus) throw new Error('Job state lost before final status');
    if (TERMINAL_STATUSES.has(beforeFinalStatus.status)) return;

    // Update final status
    const finalStatus = verificationResult.passed ? 'completed' : 'failed';
    await updateJobStatus(hash, { status: finalStatus });
    await emitEvent(hash, { type: 'status', status: finalStatus });

    // eslint-disable-next-line no-console
    console.log(safeLog({ msg: 'Job complete', hash, status: finalStatus }));
  } catch (err) {
    const message = safeDiagnostic(err);
    await failJob(hash, message);
    throw new Error(message);
  }
}

// ─── Failure Handler ──────────────────────────────────────────────────────────

async function failJob(hash: string, message: string): Promise<void> {
  try {
    const safeMessage = safeDiagnostic(message);
    await updateJobStatus(hash, { status: 'failed', error: safeMessage });
    await emitEvent(hash, {
      type: 'error',
      message: safeMessage,
      retryable: false,
    });
    await emitEvent(hash, { type: 'status', status: 'failed' });
  } catch (err) {
    // Best-effort — don't throw from error handler, but surface for ops visibility
    console.error(safeLog({ msg: 'failJob could not persist failure state', hash, error: safeDiagnostic(err) }));
  }
}

function countUnhealedScenarios(errors: string[]): number {
  // Heuristic: count unique "Scenario" references in errors
  const scenarios = new Set(errors.flatMap((e) => e.match(/Scenario: .+/g) ?? []));
  return scenarios.size || Math.ceil(errors.length / 3);
}
