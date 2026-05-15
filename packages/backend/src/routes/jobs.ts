/**
 * Job routes — POST/GET/DELETE /api/jobs
 * PRD §4.1, §4.2
 */

import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { generationQueue } from '../worker';
import {
  setJobState,
  getJobState,
  updateJobStatus,
  deleteJobState,
} from '../redis';
import { emitEvent } from '../worker/sse';
import type {
  CreateJobRequest,
  CreateJobResponse,
  JobOptions,
  JobState,
} from '../types';
import { normalizeUrl } from '../utils/urlNormalize';
import { safeLog } from '../utils/safeLog';

// ─── Validation Schemas ───────────────────────────────────────────────────────

const AuthConfigSchema = z.object({
  type: z.literal('form'),
  loginUrl: z.string().url(),
  username: z.string().min(1),
  password: z.string().min(1),
  usernameSelector: z.string().optional(),
  passwordSelector: z.string().optional(),
  submitSelector: z.string().optional(),
});

const LLMConfigSchema = z.object({
  provider: z.enum(['openai', 'openrouter', 'anthropic', 'gemini', 'custom']),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  baseURL: z.string().url().optional(),
});

const JobOptionsSchema = z.object({
  maxScenarios: z.number().int().min(1).max(10).default(10),
  positiveRatio: z.number().min(0).max(1).default(0.6),
  maxSteps: z.number().int().min(1).max(50).default(30),
  verificationMode: z.enum(['syntax-only', 'smoke', 'full']).default('smoke'),
  maxRetries: z.number().int().min(0).max(5).default(2),
});

// Zod v4: .default() requires the output type — pre-parse {} to get fully-typed defaults
const DEFAULT_JOB_OPTIONS: JobOptions = JobOptionsSchema.parse({});

const CreateJobSchema = z.object({
  url: z.string().min(1),
  hint: z.string().optional(),
  auth: AuthConfigSchema.optional(),
  llm: LLMConfigSchema,
  options: JobOptionsSchema.optional().default(DEFAULT_JOB_OPTIONS),
});

// ─── Plugin ───────────────────────────────────────────────────────────────────

export async function jobRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /api/jobs
   * Create a new generation job.
   */
  fastify.post<{ Body: CreateJobRequest }>('/api/jobs', async (request, reply) => {
    const parseResult = CreateJobSchema.safeParse(request.body);
    if (!parseResult.success) {
      fastify.log.warn(safeLog({ body: request.body, zodError: parseResult.error.flatten() }), 'Validation failed');
      return reply.status(400).send({
        error: 'Invalid request',
        details: parseResult.error.flatten(),
      });
    }

    const body = parseResult.data;

    // Normalize and validate URL
    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeUrl(body.url);
    } catch (err) {
      return reply.status(400).send({
        error: (err as Error).message,
      });
    }

    const hash = nanoid(21);
    const now = Date.now();

    const options: JobOptions = body.options as JobOptions;

    const state: JobState = {
      hash,
      status: 'queued',
      url: normalizedUrl,
      hint: body.hint,
      auth: body.auth ?? null,
      llm: body.llm,
      options,
      progress: { currentStep: 0, maxSteps: options.maxSteps, lastAction: '' },
      tokenUsage: { promptTokens: 0, completionTokens: 0, estimatedCostUSD: 0 },
      createdAt: now,
      updatedAt: now,
    };

    await setJobState(state);

    // Enqueue job (BullMQ)
    await generationQueue.add('generate', { hash }, { jobId: hash });

    fastify.log.info(safeLog({ msg: 'Job created', hash, url: normalizedUrl }));

    const response: CreateJobResponse = { hash, status: 'queued', createdAt: now };
    return reply.status(201).send(response);
  });

  /**
   * GET /api/jobs/:hash
   * Poll job status (SSE fallback).
   */
  fastify.get<{ Params: { hash: string } }>('/api/jobs/:hash', async (request, reply) => {
    const { hash } = request.params;
    const state = await getJobState(hash);
    if (!state) {
      return reply.status(404).send({ error: 'Job not found or expired' });
    }
    // Never expose credentials in the response
    const { llm, auth: _auth, ...safeState } = state;
    return reply.send({
      ...safeState,
      llm: { provider: llm.provider, model: llm.model },
    });
  });

  /**
   * DELETE /api/jobs/:hash
   * Cancel or remove a job.
   */
  fastify.delete<{ Params: { hash: string } }>('/api/jobs/:hash', async (request, reply) => {
    const { hash } = request.params;
    const state = await getJobState(hash);
    if (!state) {
      return reply.status(404).send({ error: 'Job not found or expired' });
    }

    // Mark failed first — signals cooperative cancellation to the explorer phase
    await updateJobStatus(hash, { status: 'failed', error: 'Cancelled by user' });

    // Remove from queue if still pending; active jobs drain after their current phase
    const job = await generationQueue.getJob(hash);
    if (job) {
      try { await job.remove(); } catch { /* active job — Redis flag is the cancellation signal */ }
    }

    await emitEvent(hash, { type: 'error', message: 'Cancelled by user', retryable: false });
    await emitEvent(hash, { type: 'status', status: 'failed' });

    await deleteJobState(hash);
    fastify.log.info(safeLog({ msg: 'Job cancelled', hash }));

    return reply.status(204).send();
  });
}
