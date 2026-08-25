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
  TERMINAL_STATUSES,
} from '../redis';
import type { StreamEvent } from '../types';

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

      // SSE headers — include CORS manually because reply.raw.writeHead()
      // bypasses Fastify's onSend hooks where @fastify/cors normally injects headers
      const requestOrigin = request.headers.origin;
      const allowedOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',');
      const corsOrigin = requestOrigin && allowedOrigins.includes(requestOrigin)
        ? requestOrigin
        : undefined;

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...(corsOrigin && { 'Access-Control-Allow-Origin': corsOrigin }),
      });

      const send = (event: StreamEvent): void => {
        if (closed) return;
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

      // Register before any await: a client can disconnect while Redis
      // subscribe is pending and must still release the subscriber.
      request.raw.on('close', cleanup);

      // Subscribe before replaying — ensures no live events are missed between replay and subscribe
      await subscriber.subscribe(channel);

      subscriber.on('message', (_ch: string, message: string) => {
        if (closed) return;
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

      if (closed) return;

      // Replay buffered events
      const buffered = await getSseEvents(hash, lastSeenId);
      if (closed) return;
      for (const event of buffered) {
        send(event);
      }

      // Re-check state after subscribing to catch completions that raced the subscribe
      const freshState = await getJobState(hash);
      if (!freshState || TERMINAL_STATUSES.has(freshState.status)) {
        cleanup();
        return;
      }
      if (closed) return;

      // Heartbeat every 25s to prevent proxy timeouts
      heartbeat = setInterval(() => {
        if (!closed) reply.raw.write(': heartbeat\n\n');
      }, 25_000);

    }
  );
}
