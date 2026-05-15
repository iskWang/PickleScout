/**
 * PickleScout Backend — Fastify entry point
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { jobRoutes } from './routes/jobs';
import { streamRoutes } from './routes/stream';
import { resultRoutes } from './routes/result';
import { screenshotRoutes } from './routes/screenshots';
import { startWorker } from './worker';
import { runStartupTasks } from './startup';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

async function main(): Promise<void> {
  const fastify = Fastify({
    logger: {
      level: LOG_LEVEL,
      transport:
        process.env.NODE_ENV !== 'production'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  });

  // CORS — allow frontend origin
  await fastify.register(cors, {
    origin: ['http://localhost:5173', 'http://frontend:5173'],
    methods: ['GET', 'POST', 'DELETE'],
  });

  // Routes
  await fastify.register(jobRoutes);
  await fastify.register(streamRoutes);
  await fastify.register(resultRoutes);
  await fastify.register(screenshotRoutes);

  // Health check
  fastify.get('/health', async () => ({ status: 'ok', ts: Date.now() }));


  // Run startup tasks before accepting traffic
  await runStartupTasks();

  // Start BullMQ worker
  startWorker();

  // Start server
  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  fastify.log.info(`PickleScout backend listening on port ${PORT}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});
