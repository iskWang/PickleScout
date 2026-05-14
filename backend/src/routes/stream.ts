/**
 * SSE stream route — GET /api/jobs/:hash/stream
 * PRD §4.4, §8.2
 *
 * Protocol:
 * 1. Client connects with optional Last-Event-ID header
 * 2. Server replays events from events:{hash} where id > lastSeenId
 * 3. Server subscribes to Redis channel for live events
 * 4. If job is terminal, server pushes final state and closes
 */

import type { FastifyInstance } from 'fastify';
import {
  getJobState,
  getSseEvents,
  getSseSubscriber,
  sseChannelForJob,
} from '../redis';
import type { StreamEvent } from '../types';

const TERMINAL_STATUSES = new Set(['completed', 'failed']);

export async function streamRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { hash: string } }>(
    '/api/jobs/:hash/stream',
    async (request, reply) => {
      const { hash } = request.params;

      // Validate job exists
      const state = await getJobState(hash);
      if (!state) {
        return reply.status(404).send({ error: 'Job not found or expired' });
      }

      // Parse Last-Event-ID for replay; treat non-numeric headers as absent
      const lastEventIdHeader = request.headers['last-event-id'];
      const rawId = lastEventIdHeader ? parseInt(String(lastEventIdHeader), 10) : NaN;
      const lastSeenId = Number.isNaN(rawId) ? undefined : rawId;

      // SSE headers
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const send = (event: StreamEvent): void => {
        const data = JSON.stringify(event);
        reply.raw.write(`id: ${event.id}\ndata: ${data}\n\n`);
      };

      const subscriber = getSseSubscriber();
      const channel = sseChannelForJob(hash);

      let heartbeat: NodeJS.Timeout | null = null;
      let closed = false;

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        subscriber.unsubscribe(channel).then(() => subscriber.quit()).catch(() => undefined);
        reply.raw.end();
      };

      // Subscribe before replaying — ensures no live events are missed between replay and subscribe
      await subscriber.subscribe(channel);

      subscriber.on('message', (_ch: string, message: string) => {
        try {
          const event = JSON.parse(message) as StreamEvent;
          send(event);
          if (
            (event.type === 'status' && TERMINAL_STATUSES.has(event.status)) ||
            event.type === 'complete' ||
            event.type === 'error'
          ) {
            cleanup();
          }
        } catch {
          // Ignore malformed messages
        }
      });

      // Replay buffered events
      const buffered = await getSseEvents(hash, lastSeenId);
      for (const event of buffered) {
        send(event);
      }

      // Re-check state after subscribing to catch completions that raced the subscribe
      const freshState = await getJobState(hash);
      if (!freshState || TERMINAL_STATUSES.has(freshState.status)) {
        cleanup();
        return;
      }

      // Heartbeat every 25s to prevent proxy timeouts
      heartbeat = setInterval(() => {
        reply.raw.write(': heartbeat\n\n');
      }, 25_000);

      // Cleanup on client disconnect
      request.raw.on('close', cleanup);
    }
  );
}
