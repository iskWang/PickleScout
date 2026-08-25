import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

vi.mock('ioredis', () => ({
  default: class FakeRedis {
    async set(key: string, value: string) { store.set(key, value); return 'OK'; }
    async get(key: string) { return store.get(key) ?? null; }
    on() { return this; }
  },
}));

import { setJobState, updateJobStatus } from './redis';
import type { JobState } from './types';

const state = (status: JobState['status']): JobState => ({
  hash: 'terminal-test', status, url: 'https://example.com',
  options: {} as JobState['options'], llm: {} as JobState['llm'],
  progress: { currentStep: 0, maxSteps: 1, lastAction: '' },
  tokenUsage: {} as JobState['tokenUsage'], createdAt: 1, updatedAt: 1,
});

describe('updateJobStatus terminal invariant', () => {
  beforeEach(() => store.clear());

  it('does not revive a failed job into a later status', async () => {
    await setJobState(state('failed'));
    const result = await updateJobStatus('terminal-test', { status: 'completed' });
    expect(result?.status).toBe('failed');
    expect((await updateJobStatus('terminal-test', { status: 'generating' }))?.status).toBe('failed');
  });

  it('allows supplemental patches with the same terminal status', async () => {
    await setJobState(state('completed'));
    const result = await updateJobStatus('terminal-test', { status: 'completed', error: 'late detail' });
    expect(result).toMatchObject({ status: 'completed', error: 'late detail' });
  });
});
