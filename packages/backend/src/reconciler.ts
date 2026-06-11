/**
 * Runtime reconciler — detects BullMQ/Redis state drift and repairs it.
 *
 * Problem: startup.ts handles orphan jobs on restart, but if a BullMQ job
 * disappears at runtime (eviction, manual removal) the Redis job:{hash} key
 * keeps its non-terminal status indefinitely until the 7-day TTL expires.
 *
 * This reconciler runs every RECONCILE_INTERVAL_MS. For each non-terminal
 * Redis job older than STUCK_THRESHOLD_MS, it checks for a corresponding
 * BullMQ job. If none is found, the job is marked failed and the SSE
 * channel receives an error event so connected frontends recover immediately.
 */

import type { Queue } from 'bullmq';
import { getRedisClient, getJobState, updateJobStatus } from './redis';
import { emitEvent } from './worker/sse';
import { safeLog } from './utils/safeLog';

const RECONCILE_INTERVAL_MS = 60_000;      // check every 60 s
const STUCK_THRESHOLD_MS    = 5 * 60_000;  // ignore jobs younger than 5 min
const TERMINAL_STATUSES     = new Set(['completed', 'failed']);

export function startReconciler(queue: Queue): NodeJS.Timeout {
  return setInterval(() => reconcileOnce(queue).catch((err) => {
    console.error(safeLog({ msg: 'Reconciler iteration failed', error: err instanceof Error ? err.message : String(err) }));
  }), RECONCILE_INTERVAL_MS);
}

async function reconcileOnce(queue: Queue): Promise<void> {
  const redis = getRedisClient();

  const keys: string[] = [];
  for await (const batch of redis.scanStream({ match: 'job:*', count: 100 })) {
    keys.push(...(batch as string[]));
  }

  for (const key of keys) {
    const hash = key.replace('job:', '');
    const state = await getJobState(hash);
    if (!state || TERMINAL_STATUSES.has(state.status)) continue;

    const ageMs = Date.now() - state.updatedAt;
    if (ageMs < STUCK_THRESHOLD_MS) continue;

    const bullJob = await queue.getJob(hash);
    if (bullJob) continue; // BullMQ still has it — all good

    console.warn(safeLog({ msg: 'Reconciler: stuck job detected, marking failed', hash, status: state.status, ageMs }));

    await updateJobStatus(hash, {
      status: 'failed',
      error: 'Job queue entry lost unexpectedly — please retry.',
    });
    await emitEvent(hash, {
      type: 'error',
      message: 'Job queue entry lost unexpectedly — please retry.',
      retryable: true,
    });
    await emitEvent(hash, { type: 'status', status: 'failed' });
  }
}
