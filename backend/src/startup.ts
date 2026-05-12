/**
 * Startup tasks — run before accepting requests.
 *
 * 1. Mark non-terminal jobs as failed (prevent orphan credential leaks)
 * 2. Remove /storage directories with no corresponding Redis job
 *
 * PRD §5.3, §5.2
 */

import path from 'path';
import fs from 'fs/promises';
import { getRedisClient, getJobState, updateJobStatus } from './redis';
import { safeLog } from './utils/safeLog';

const STORAGE_DIR = process.env.STORAGE_DIR ?? '/storage';
const TERMINAL_STATUSES = new Set(['completed', 'failed']);

export async function runStartupTasks(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('[startup] Running startup tasks…');

  await markOrphanJobsFailed();
  await cleanOrphanStorageDirs();

  // eslint-disable-next-line no-console
  console.log('[startup] Startup tasks complete');
}

// ─── Mark non-terminal jobs as failed ─────────────────────────────────────────

async function markOrphanJobsFailed(): Promise<void> {
  const redis = getRedisClient();

  // Scan for all job:{hash} keys
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', 'job:*', 'COUNT', 100);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');

  let markedFailed = 0;
  for (const key of keys) {
    const hash = key.replace('job:', '');
    const state = await getJobState(hash);
    if (!state) continue;

    if (!TERMINAL_STATUSES.has(state.status)) {
      await updateJobStatus(hash, {
        status: 'failed',
        error: 'Service restarted. Please retry your job.',
      });
      markedFailed++;
      // eslint-disable-next-line no-console
      console.log(safeLog({ msg: 'Orphan job marked failed', hash }));
    }
  }

  if (markedFailed > 0) {
    // eslint-disable-next-line no-console
    console.log(`[startup] Marked ${markedFailed} orphan job(s) as failed`);
  }
}

// ─── Clean orphan storage directories ─────────────────────────────────────────

async function cleanOrphanStorageDirs(): Promise<void> {
  const subdirs = ['screenshots', 'generated', 'outputs'];
  let removed = 0;

  for (const subdir of subdirs) {
    const dir = path.join(STORAGE_DIR, subdir);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue; // Directory doesn't exist yet
    }

    for (const hash of entries) {
      const state = await getJobState(hash);
      if (!state) {
        // No Redis entry → orphan
        await fs.rm(path.join(dir, hash), { recursive: true, force: true });
        removed++;
        // eslint-disable-next-line no-console
        console.log({ msg: 'Removed orphan storage dir', path: `${subdir}/${hash}` });
      }
    }
  }

  if (removed > 0) {
    // eslint-disable-next-line no-console
    console.log(`[startup] Removed ${removed} orphan storage directory/ies`);
  }
}
