/**
 * Result download route
 * GET /api/jobs/:hash/result
 * GET /api/jobs/:hash/result?unverified=true
 * PRD §4.1
 */

import type { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import { getJobState } from '../redis';

const STORAGE_DIR = process.env.STORAGE_DIR ?? '/storage';

export async function resultRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{
    Params: { hash: string };
    Querystring: { unverified?: string };
  }>('/api/jobs/:hash/result', async (request, reply) => {
    const { hash } = request.params;
    const unverified = request.query.unverified === 'true';

    const state = await getJobState(hash);
    if (!state) {
      return reply.status(404).send({ error: 'Job not found or expired' });
    }

    if (state.status !== 'completed' && state.status !== 'failed') {
      return reply.status(409).send({ error: 'Job is not yet complete' });
    }

    const filename = unverified ? 'result_unverified.zip' : 'result.zip';
    const zipPath = path.join(STORAGE_DIR, 'outputs', hash, filename);

    if (!fs.existsSync(zipPath)) {
      return reply.status(404).send({ error: 'Result file not found' });
    }

    const stat = fs.statSync(zipPath);
    const fileSize = stat.size;

    reply.raw.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="picklescout-${hash.slice(0, 8)}.zip"`,
      'Content-Length': fileSize,
    });

    const stream = fs.createReadStream(zipPath);
    stream.pipe(reply.raw);
  });
}
