import { describe, expect, it, vi } from 'vitest';
import type { JobState } from '../types';

vi.mock('bullmq', () => ({
  Queue: class { constructor(..._args: unknown[]) {} },
  Worker: class { constructor(..._args: unknown[]) {} },
}));
vi.mock('../redis', () => ({
  getBullRedisClient: vi.fn(() => ({})),
  getJobState: vi.fn(),
  updateJobStatus: vi.fn(),
  TERMINAL_STATUSES: new Set(['completed', 'failed']),
}));
vi.mock('./explorer', () => ({ runExplorer: vi.fn() }));
vi.mock('./generator', () => ({ runGenerator: vi.fn(), rerunPass2: vi.fn() }));
vi.mock('./verifier', () => ({ runVerifier: vi.fn(), attemptSelfHeal: vi.fn(), checkStepResolution: vi.fn() }));
vi.mock('./packager', () => ({ runPackager: vi.fn(), prepareVerificationDir: vi.fn() }));
vi.mock('./output-validator', () => ({ validateOutput: vi.fn() }));
vi.mock('./sse', () => ({ emitEvent: vi.fn(), resetJobCounter: vi.fn() }));
vi.mock('../templates/steps/index', () => ({ TEMPLATE_CATALOG: {} }));
vi.mock('../utils/safeLog', () => ({ safeLog: vi.fn((value: unknown) => value) }));

import { getJobState } from '../redis';
import { runExplorer } from './explorer';
import { runGenerator } from './generator';
import { processJob } from './index';

const jobState: Parameters<typeof runExplorer>[0] = {
  hash: 'boundary',
  status: 'exploring',
  url: 'https://example.com',
  llm: {} as JobState['llm'],
  options: { maxRetries: 0 } as JobState['options'],
  progress: { currentStep: 0, maxSteps: 1, lastAction: '' },
  tokenUsage: {} as JobState['tokenUsage'],
  createdAt: 0,
  updatedAt: 0,
};

describe('processJob terminal stage boundaries', () => {
  it('stops after exploration when cancellation has already failed the job', async () => {
    vi.mocked(getJobState)
      .mockResolvedValueOnce(jobState)
      .mockResolvedValueOnce({ ...jobState, status: 'failed' });
    vi.mocked(runExplorer).mockResolvedValue({
      jobHash: 'boundary',
      targetUrl: 'https://example.com',
      entries: [],
      inferredJourneys: [],
    });

    await processJob('boundary', new AbortController().signal);

    expect(runGenerator).not.toHaveBeenCalled();
  });
});
