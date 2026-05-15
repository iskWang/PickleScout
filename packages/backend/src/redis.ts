/**
 * Redis client singleton + job-state helpers.
 *
 * Key conventions (PRD §5.1):
 *   job:{hash}     — Job state JSON, TTL = JOB_TTL_DAYS days
 *   events:{hash}  — Redis List, last 50 SSE events, TTL = JOB_TTL_DAYS days
 *   bull:*         — BullMQ internal keys (managed by bullmq)
 */

import Redis from 'ioredis';
import type { JobState, StreamEvent } from './types';

const TTL_SECONDS = (parseInt(process.env.JOB_TTL_DAYS ?? '7', 10)) * 86_400;
const SSE_EVENT_BUFFER_MAX = 50;

// ─── Singleton ────────────────────────────────────────────────────────────────

let _client: Redis | null = null;
let _bullClient: Redis | null = null;

function makeClient(maxRetriesPerRequest: number | null): Redis {
  const client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest,
    lazyConnect: false,
  });
  client.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[redis] connection error', err.message);
  });
  return client;
}

/** General-purpose client (commands, state reads/writes) */
export function getRedisClient(): Redis {
  if (!_client) _client = makeClient(3);
  return _client;
}

/** BullMQ client — maxRetriesPerRequest must be null for blocking commands */
export function getBullRedisClient(): Redis {
  if (!_bullClient) _bullClient = makeClient(null);
  return _bullClient;
}

// ─── Job State ────────────────────────────────────────────────────────────────

export async function setJobState(state: JobState): Promise<void> {
  const redis = getRedisClient();
  const key = `job:${state.hash}`;
  // safeLog before any storage that touches credentials
  await redis.set(key, JSON.stringify(state), 'EX', TTL_SECONDS);
}

export async function getJobState(hash: string): Promise<JobState | null> {
  const redis = getRedisClient();
  const raw = await redis.get(`job:${hash}`);
  if (!raw) return null;
  return JSON.parse(raw) as JobState;
}

export async function updateJobStatus(
  hash: string,
  patch: Partial<JobState>
): Promise<JobState | null> {
  const current = await getJobState(hash);
  if (!current) return null;
  const updated: JobState = { ...current, ...patch, updatedAt: Date.now() };
  await setJobState(updated);
  return updated;
}

export async function deleteJobState(hash: string): Promise<void> {
  const redis = getRedisClient();
  await redis.del(`job:${hash}`);
}

// ─── SSE Event Buffer ─────────────────────────────────────────────────────────

export async function appendSseEvent(hash: string, event: StreamEvent): Promise<void> {
  const redis = getRedisClient();
  const key = `events:${hash}`;
  await redis.rpush(key, JSON.stringify(event));
  // Keep only the last SSE_EVENT_BUFFER_MAX events
  await redis.ltrim(key, -SSE_EVENT_BUFFER_MAX, -1);
  await redis.expire(key, TTL_SECONDS);
}

export async function getSseEvents(hash: string, afterId?: number): Promise<StreamEvent[]> {
  const redis = getRedisClient();
  const key = `events:${hash}`;
  const raws = await redis.lrange(key, 0, -1);
  const events = raws.map((r) => JSON.parse(r) as StreamEvent);
  if (afterId === undefined) return events;
  return events.filter((e) => e.id > afterId);
}

// ─── Pub/Sub for SSE live push ────────────────────────────────────────────────

const SSE_CHANNEL = 'sse:events';

export function getSsePublisher(): Redis {
  // Separate connection for publish (must not be in subscriber mode)
  return new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: 3,
  });
}

export function getSseSubscriber(): Redis {
  return new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null, // Reconnect indefinitely
  });
}

export function sseChannelForJob(hash: string): string {
  return `${SSE_CHANNEL}:${hash}`;
}
