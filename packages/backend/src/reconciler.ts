/**
 * Runtime reconciler — detects BullMQ/Redis state drift and repairs it.
 *
 * Problem: startup.ts handles orphan jobs on restart, but if a BullMQ job
 * disappears at runtime (eviction, manual removal) the Redis job:{hash} key
 * keeps its non-terminal status indefinitely until the 7-day TTL expires.
 *
 * This reconciler runs every RECONCILE_INTERVAL_MS. For each non-terminal
 * Redis job older than ORPHAN_THRESHOLD_MS, it checks for a corresponding
 * BullMQ job. If none is found, the job is marked failed and the SSE
 * channel receives an error event so connected frontends recover immediately.
 */

import type { Queue } from 'bullmq';
import { getRedisClient, getJobState, updateJobStatus, TERMINAL_STATUSES, ORPHAN_THRESHOLD_MS, ORPHAN_ERROR } from './redis';
import { emitEvent } from './worker/sse';
import { safeLog } from './utils/safeLog';

const RECONCILE_INTERVAL_MS = 60_000;

export function startReconciler(queue: Queue): NodeJS.Timeout {
  return setInterval(() => reconcileOnce(queue).catch((err) => {
    console.error(safeLog({ msg: 'Reconciler iteration failed', error: err instanceof Error ? err.message : String(err) }));
  }), RECONCILE_INTERVAL_MS);
}

async function reconcileOnce(queue: Queue): Promise<void> {
  const redis = getRedisClient();

  for await (const batch of redis.scanStream({ match: 'job:*', count: 100 })) {
    for (const key of batch as string[]) {
      const hash = key.replace('job:', '');

      const [state, bullJob] = await Promise.all([getJobState(hash), queue.getJob(hash)]);
      if (!state || TERMINAL_STATUSES.has(state.status)) continue;

      const ageMs = Date.now() - state.updatedAt;
      if (ageMs < ORPHAN_THRESHOLD_MS) continue;

      if (bullJob) continue; // BullMQ still has it — all good

      console.warn(safeLog({ msg: 'Reconciler: stuck job detected, marking failed', hash, status: state.status, ageMs }));

      await updateJobStatus(hash, { status: 'failed', error: ORPHAN_ERROR });
      await Promise.all([
        emitEvent(hash, { type: 'error', message: ORPHAN_ERROR, retryable: true }),
        emitEvent(hash, { type: 'status', status: 'failed' }),
      ]);
    }
  }
}
