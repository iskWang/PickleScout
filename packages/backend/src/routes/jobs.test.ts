import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { JobState } from '../types';

const { getJobState } = vi.hoisted(() => ({ getJobState: vi.fn() }));

vi.mock('../worker', () => ({ generationQueue: { getJob: vi.fn(), add: vi.fn() } }));
vi.mock('../worker/sse', () => ({ emitEvent: vi.fn() }));
vi.mock('../redis', () => ({
  setJobState: vi.fn(),
  getJobState,
  updateJobStatus: vi.fn(),
  TERMINAL_STATUSES: new Set(['completed', 'failed']),
  ORPHAN_THRESHOLD_MS: 5 * 60_000,
  ORPHAN_ERROR: 'Job queue entry lost unexpectedly — please retry.',
}));

import { jobRoutes } from './jobs';

type GetHandler = (
  request: { params: { hash: string } },
  reply: { status: (code: number) => { send: (body: unknown) => unknown }; send: (body: unknown) => unknown }
) => Promise<unknown>;

const baseState = (overrides: Partial<JobState>): JobState => ({
  hash: 'h1',
  status: 'failed',
  url: 'https://example.com',
  auth: null,
  llm: { provider: 'openai', model: 'gpt-4' } as JobState['llm'],
  options: {} as JobState['options'],
  progress: { currentStep: 0, maxSteps: 1, lastAction: '' },
  tokenUsage: { promptTokens: 0, completionTokens: 0, estimatedCostUSD: 0 },
  createdAt: 1,
  updatedAt: Date.now(),
  ...overrides,
});

async function getGetHandler(): Promise<GetHandler> {
  let handler!: GetHandler;
  const fastify = {
    post: vi.fn(),
    get: vi.fn((path: string, routeHandler: GetHandler) => {
      if (path === '/api/jobs/:hash') handler = routeHandler;
    }),
    delete: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn() },
  };
  await jobRoutes(fastify as unknown as FastifyInstance);
  return handler;
}

describe('GET /api/jobs/:hash error sanitization', () => {
  it('replaces a raw legacy error with the generic safe message', async () => {
    getJobState.mockResolvedValueOnce(baseState({ error: 'raw upstream sk-canary leaked text' }));
    const handler = await getGetHandler();
    const send = vi.fn();
    await handler({ params: { hash: 'h1' } }, { status: vi.fn(() => ({ send })), send });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Job operation failed. Please retry.' })
    );
  });

  it('passes a known static error through unchanged', async () => {
    getJobState.mockResolvedValueOnce(baseState({ error: 'Cancelled by user' }));
    const handler = await getGetHandler();
    const send = vi.fn();
    await handler({ params: { hash: 'h1' } }, { status: vi.fn(() => ({ send })), send });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ error: 'Cancelled by user' }));
  });

  it('passes the ORPHAN_ERROR constant through unchanged', async () => {
    getJobState.mockResolvedValueOnce(
      baseState({ error: 'Job queue entry lost unexpectedly — please retry.' })
    );
    const handler = await getGetHandler();
    const send = vi.fn();
    await handler({ params: { hash: 'h1' } }, { status: vi.fn(() => ({ send })), send });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Job queue entry lost unexpectedly — please retry.' })
    );
  });
});
