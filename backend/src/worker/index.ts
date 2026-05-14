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
import { getRedisClient, getJobState, updateJobStatus } from '../redis';
import { runExplorer } from './explorer';
import { runGenerator, rerunPass2 } from './generator';
import { runVerifier, attemptSelfHeal, checkStepResolution } from './verifier';
import { runPackager } from './packager';
import { emitEvent, resetJobCounter } from './sse';
import { safeLog } from '../utils/safeLog';

const STORAGE_DIR = process.env.STORAGE_DIR ?? '/storage';
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_JOBS ?? '2', 10);
const JOB_MAX_DURATION = parseInt(process.env.JOB_MAX_DURATION_SEC ?? '1200', 10) * 1000;

// ─── Queue (exported so routes can enqueue) ───────────────────────────────────

export const generationQueue = new Queue('generation', {
  connection: getRedisClient(),
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
      connection: getRedisClient(),
      concurrency: MAX_CONCURRENT,
    }
  );

  worker.on('failed', async (job, err) => {
    if (job) {
      // eslint-disable-next-line no-console
      console.error(safeLog({ msg: 'Worker job failed', hash: job.data.hash, error: err.message }));
      await failJob(job.data.hash, err.message);
    }
  });

  // eslint-disable-next-line no-console
  console.log(`[worker] Started with concurrency=${MAX_CONCURRENT}`);
  return worker;
}

// ─── Pipeline Orchestration ───────────────────────────────────────────────────

async function processJob(hash: string, signal: AbortSignal): Promise<void> {
  resetJobCounter(hash);

  const state = await getJobState(hash);
  if (!state) {
    throw new Error(`Job ${hash} not found in Redis`);
  }

  try {
    // Phase 1: Exploration
    const actionLog = await runExplorer(state, signal);

    // Phase 2: LLM Generation
    const freshState = await getJobState(hash);
    if (!freshState) throw new Error('Job state lost after exploration');

    const artifact = await runGenerator(freshState, actionLog, signal);

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

      currentStepFiles = await rerunPass2(freshState, actionLog, artifact.featureFiles, signal);
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

    // Phase 3: Verification + self-healing loop
    let verificationResult = await runVerifier(freshState, artifactDir, signal);
    let unhealedScenarios = 0;
    let retries = 0;
    const maxRetries = freshState.options.maxRetries;

    while (!verificationResult.passed && retries < maxRetries) {
      retries++;
      await emitEvent(hash, {
        type: 'llm_log',
        message: `Verification failed, self-healing attempt ${retries}/${maxRetries}…`,
      });

      const latestState = await getJobState(hash);
      if (!latestState) throw new Error('Job state lost during self-healing');

      // Attempt self-heal
      currentStepFiles = await attemptSelfHeal(latestState, currentStepFiles, verificationResult.errors, signal);

      // Write healed files back
      for (const f of currentStepFiles) {
        await fs.writeFile(path.join(artifactDir, 'steps', f.filename), f.content, 'utf-8');
      }

      // Re-verify
      verificationResult = await runVerifier(latestState, artifactDir, signal);
    }

    if (!verificationResult.passed) {
      // Count unhealed scenarios and tag them
      unhealedScenarios = countUnhealedScenarios(verificationResult.errors);

      await emitEvent(hash, {
        type: 'verification',
        passed: false,
        errors: verificationResult.errors.slice(0, 5),
      });

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

    const updatedArtifact = { ...artifact, stepFiles: currentStepFiles };
    await runPackager(finalState, updatedArtifact, actionLog, verificationResult.passed, unhealedScenarios);

    // Update final status
    const finalStatus = verificationResult.passed ? 'completed' : 'failed';
    await updateJobStatus(hash, { status: finalStatus });
    await emitEvent(hash, { type: 'status', status: finalStatus });

    // eslint-disable-next-line no-console
    console.log(safeLog({ msg: 'Job complete', hash, status: finalStatus }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failJob(hash, message);
    throw err;
  }
}

// ─── Failure Handler ──────────────────────────────────────────────────────────

async function failJob(hash: string, message: string): Promise<void> {
  try {
    await updateJobStatus(hash, { status: 'failed', error: message });
    await emitEvent(hash, {
      type: 'error',
      message,
      retryable: false,
    });
    await emitEvent(hash, { type: 'status', status: 'failed' });
  } catch {
    // Best-effort — don't throw from error handler
  }
}

function countUnhealedScenarios(errors: string[]): number {
  // Heuristic: count unique "Scenario" references in errors
  const scenarios = new Set(errors.flatMap((e) => e.match(/Scenario: .+/g) ?? []));
  return scenarios.size || Math.ceil(errors.length / 3);
}
