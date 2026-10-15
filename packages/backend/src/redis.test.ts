import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock('ioredis', () => ({
  default: class FakeRedis {
    async set(key: string, value: string) { store.set(key, value); return 'OK'; }
    async get(key: string) { return store.get(key) ?? null; }
    on() { return this; }
  },
}));

import { getJobState, setJobState, updateJobStatus } from './redis';
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
    const result = await updateJobStatus('terminal-test', { status: 'completed', error: 'Cancelled by user' });
    expect(result).toMatchObject({ status: 'completed', error: 'Cancelled by user' });
  });
});

describe('job error persistence boundary', () => {
  beforeEach(() => store.clear());

  const credentialState = (): JobState => ({
    ...state('exploring'),
    llm: { provider: 'openai', model: 'gpt-4', apiKey: 'sk-CANARY-7f3a' },
    auth: {
      type: 'form', loginUrl: 'https://example.com/login',
      username: 'test-user', password: 'pw-CANARY-91c2',
    },
  });

  it('sanitizes initial errors without changing worker credentials or the caller state', async () => {
    const input = { ...credentialState(), error: 'boom sk-CANARY-7f3a pw-CANARY-91c2' };
    await setJobState(input);
    const raw = JSON.parse(store.get('job:terminal-test')!);
    expect(raw.error).toBe('Job operation failed. Please retry.');
    expect(raw.llm).toEqual(input.llm);
    expect(raw.auth).toEqual(input.auth);
    expect(input.error).toBe('boom sk-CANARY-7f3a pw-CANARY-91c2');
    expect(await getJobState(input.hash)).toMatchObject({
      error: 'Job operation failed. Please retry.', llm: input.llm, auth: input.auth,
    });
  });

  it('sanitizes patched errors in the return value, stored state, and subsequent reads', async () => {
    const input = credentialState();
    await setJobState(input);
    const updated = await updateJobStatus(input.hash, { error: 'boom sk-CANARY-7f3a' });
    expect(updated?.error).toBe('Job operation failed. Please retry.');
    expect(JSON.parse(store.get('job:terminal-test')!).error).toBe('Job operation failed. Please retry.');
    expect(await getJobState(input.hash)).toMatchObject({
      error: 'Job operation failed. Please retry.', llm: input.llm, auth: input.auth,
    });
  });

  it('sanitizes legacy errors on read while preserving credentials', async () => {
    const input = { ...credentialState(), error: 'legacy pw-CANARY-91c2' };
    store.set('job:terminal-test', JSON.stringify(input));
    expect(await getJobState(input.hash)).toMatchObject({
      error: 'Job operation failed. Please retry.', llm: input.llm, auth: input.auth,
    });
  });

  it('preserves a known safe message through both write paths and read', async () => {
    await setJobState({ ...credentialState(), error: 'Cancelled by user' });
    expect((await getJobState('terminal-test'))?.error).toBe('Cancelled by user');
    await updateJobStatus('terminal-test', { error: 'Service restarted. Please retry your job.' });
    expect((await getJobState('terminal-test'))?.error).toBe('Service restarted. Please retry your job.');
  });
});

describe('redis connection error logging', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('logs a fixed literal, never the raw ioredis error message', async () => {
    vi.resetModules();
    vi.doMock('ioredis', () => ({
      default: class FakeRedis {
        private handlers: Record<string, (err: Error) => void> = {};
        on(event: string, cb: (err: Error) => void) {
          this.handlers[event] = cb;
          return this;
        }
        emitError(err: Error) {
          this.handlers.error?.(err);
        }
      },
    }));
    const { getRedisClient } = await import('./redis');
    const client = getRedisClient() as unknown as { emitError: (err: Error) => void };
    client.emitError(new Error('connect ECONNREFUSED redis://user:sk-canary@host'));

    expect(errorSpy).toHaveBeenCalledWith('[redis] connection error');
    const allArgs = errorSpy.mock.calls.flat();
    expect(allArgs.some((a) => typeof a === 'string' && a.includes('sk-canary'))).toBe(false);
  });
});
