/**
 * Screenshot routes — serves static files from storage
 * PRD §4.3
 */

import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';

const STORAGE_DIR = process.env.STORAGE_DIR ?? '/storage';

export async function screenshotRoutes(fastify: FastifyInstance): Promise<void> {
  // Serves /storage/screenshots/:hash/:file at GET /api/screenshots/:hash/:file
  await fastify.register(fastifyStatic, {
    root: path.join(STORAGE_DIR, 'screenshots'),
    prefix: '/api/screenshots/',
    decorateReply: false,
  });
}
