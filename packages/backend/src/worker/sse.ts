/**
 * SSE event publisher — used by workers to emit progress events.
 *
 * Appends to the Redis events:{hash} buffer and publishes to the
 * Pub/Sub channel so live SSE connections receive it immediately.
 */

import type { StreamEvent } from '../types';
import { appendSseEvent, getSsePublisher, sseChannelForJob } from '../redis';

// Pub/Sub publisher — one shared connection for all workers
let _publisher: ReturnType<typeof getSsePublisher> | null = null;

function getPublisher(): ReturnType<typeof getSsePublisher> {
  if (!_publisher) {
    _publisher = getSsePublisher();
  }
  return _publisher;
}

// Monotonic event ID per job (in-memory, good enough for single-process)
const jobEventCounters = new Map<string, number>();

/**
 * Emit an SSE event. The partial argument is cast to the discriminated union
 * after injecting id + ts — each worker is responsible for passing valid fields.
 */
export async function emitEvent(
  hash: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  partial: { type: string } & Record<string, any>
): Promise<void> {
  const current = jobEventCounters.get(hash) ?? 0;
  const nextId = current + 1;
  jobEventCounters.set(hash, nextId);

  const event = {
    id: nextId,
    ts: Date.now(),
    ...partial,
  } as StreamEvent;

  // Buffer in Redis for replay
  await appendSseEvent(hash, event);

  // Publish to live subscribers
  const publisher = getPublisher();
  await publisher.publish(sseChannelForJob(hash), JSON.stringify(event));
}

export function resetJobCounter(hash: string): void {
  jobEventCounters.delete(hash);
}
