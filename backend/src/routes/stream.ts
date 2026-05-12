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

      // Parse Last-Event-ID for replay
      const lastEventIdHeader = request.headers['last-event-id'];
      const lastSeenId = lastEventIdHeader
        ? parseInt(String(lastEventIdHeader), 10)
        : undefined;

      // SSE headers
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // Disable nginx buffering
      });

      const send = (event: StreamEvent): void => {
        const data = JSON.stringify(event);
        reply.raw.write(`id: ${event.id}\ndata: ${data}\n\n`);
      };

      // Replay buffered events
      const buffered = await getSseEvents(hash, lastSeenId);
      for (const event of buffered) {
        send(event);
      }

      // If already terminal, close
      if (TERMINAL_STATUSES.has(state.status)) {
        reply.raw.end();
        return;
      }

      // Subscribe for live events
      const subscriber = getSseSubscriber();
      const channel = sseChannelForJob(hash);

      await subscriber.subscribe(channel);

      subscriber.on('message', (_ch: string, message: string) => {
        try {
          const event = JSON.parse(message) as StreamEvent;
          send(event);

          // Close on terminal event
          if (
            (event.type === 'status' && TERMINAL_STATUSES.has(event.status)) ||
            event.type === 'complete' ||
            event.type === 'error'
          ) {
            subscriber.unsubscribe(channel).then(() => {
              subscriber.quit();
              reply.raw.end();
            });
          }
        } catch {
          // Ignore malformed messages
        }
      });

      // Heartbeat every 25s to prevent proxy timeouts
      const heartbeat = setInterval(() => {
        reply.raw.write(': heartbeat\n\n');
      }, 25_000);

      // Cleanup on client disconnect
      request.raw.on('close', () => {
        clearInterval(heartbeat);
        subscriber.unsubscribe(channel).then(() => subscriber.quit());
      });
    }
  );
}
