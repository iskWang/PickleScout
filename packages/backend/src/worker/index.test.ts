import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobState } from '../types';
import type * as RedisModule from '../redis';
import type * as SseModule from './sse';

const { store, events, publish, workerHooks } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  events: new Map<string, string[]>(),
  publish: vi.fn().mockResolvedValue(1),
  workerHooks: {} as {
    processor?: (job: { data: { hash: string } }) => Promise<void>;
    failed?: (job: { data: { hash: string } }, error: Error) => Promise<void>;
  },
}));

vi.mock('ioredis', () => ({
  default: class FakeRedis {
    on() { return this; }
    async get(key: string) { return store.get(key) ?? null; }
    async set(key: string, value: string) { store.set(key, value); return 'OK'; }
    async rpush(key: string, value: string) {
      events.set(key, [...(events.get(key) ?? []), value]);
      return events.get(key)!.length;
    }
    async ltrim() { return 'OK'; }
    async expire() { return 1; }
    publish = publish;
  },
}));

vi.mock('bullmq', () => ({
  Queue: class { constructor(..._args: unknown[]) {} },
  Worker: class {
    constructor(_name: string, processor: typeof workerHooks.processor) {
      workerHooks.processor = processor;
    }
    on(_event: string, listener: typeof workerHooks.failed) {
      workerHooks.failed = listener;
      return this;
    }
  },
}));
vi.mock('../redis', async (importOriginal) => {
  const actual = await importOriginal<typeof RedisModule>();
  return {
    ...actual,
    getJobState: vi.fn(actual.getJobState),
    updateJobStatus: vi.fn(actual.updateJobStatus),
  };
});
vi.mock('./explorer', () => ({ runExplorer: vi.fn() }));
vi.mock('./generator', () => ({ runGenerator: vi.fn(), rerunPass2: vi.fn() }));
vi.mock('./verifier', () => ({ runVerifier: vi.fn(), attemptSelfHeal: vi.fn(), checkStepResolution: vi.fn() }));
vi.mock('./packager', () => ({ runPackager: vi.fn(), prepareVerificationDir: vi.fn() }));
vi.mock('./output-validator', () => ({ validateOutput: vi.fn() }));
vi.mock('./sse', async (importOriginal) => {
  const actual = await importOriginal<typeof SseModule>();
  return { ...actual, emitEvent: vi.fn(actual.emitEvent) };
});
vi.mock('../templates/steps/index', () => ({ TEMPLATE_CATALOG: {} }));

import { getJobState, setJobState, updateJobStatus } from '../redis';
import { runExplorer } from './explorer';
import { runGenerator } from './generator';
import { processJob, startWorker } from './index';
import { emitEvent } from './sse';

const jobState: Parameters<typeof runExplorer>[0] = {
  hash: 'boundary',
  status: 'exploring',
  url: 'https://example.com',
  llm: { provider: 'openai', model: 'gpt-4', apiKey: 'sk-CANARY-7f3a' },
  auth: {
    type: 'form', loginUrl: 'https://example.com/login',
    username: 'test-user', password: 'pw-CANARY-91c2',
  },
  options: { maxRetries: 0 } as JobState['options'],
  progress: { currentStep: 0, maxSteps: 1, lastAction: '' },
  tokenUsage: {} as JobState['tokenUsage'],
  createdAt: 0,
  updatedAt: 0,
};

beforeEach(async () => {
  vi.clearAllMocks();
  store.clear();
  events.clear();
  await setJobState(jobState);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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

describe('worker diagnostic boundary', () => {
  const rawError = () => new Error('upstream 401 key=sk-CANARY-7f3a password=pw-CANARY-91c2');

  async function expectSafeRejection(operation: Promise<void>): Promise<void> {
    const error = await operation.then(() => undefined, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('Expected worker rejection');
    expect(error.message).toBe('Job operation failed. Please retry.');
    expect(error.stack).not.toContain('CANARY');
    expect(error.cause).toBeUndefined();
  }

  it('rejects with a new safe Error and persists and publishes only safe diagnostics', async () => {
    const upstream = rawError();
    vi.mocked(runExplorer).mockRejectedValueOnce(upstream);
    const operation = processJob(jobState.hash, new AbortController().signal);
    await expect(operation).rejects.not.toBe(upstream);
    await expectSafeRejection(operation);

    const stored = JSON.parse(store.get('job:boundary')!);
    expect(stored.status).toBe('failed');
    expect(stored.error).toBe('Job operation failed. Please retry.');
    expect(stored.llm).toEqual(jobState.llm);
    expect(stored.auth).toEqual(jobState.auth);
    expect(emitEvent).toHaveBeenCalledWith('boundary', {
      type: 'error', message: 'Job operation failed. Please retry.', retryable: false,
    });
    expect(JSON.stringify(vi.mocked(emitEvent).mock.calls)).not.toContain('CANARY');
    expect(events.get('events:boundary')).toHaveLength(2);
    expect(JSON.stringify(events.get('events:boundary'))).not.toContain('CANARY');
    expect(publish).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(publish.mock.calls)).not.toContain('CANARY');
  });

  it('sanitizes missing-state failures before handing them to BullMQ', async () => {
    store.clear();
    await expectSafeRejection(processJob('missing', new AbortController().signal));
    expect(JSON.stringify(vi.mocked(emitEvent).mock.calls)).not.toContain('CANARY');
    expect(runExplorer).not.toHaveBeenCalled();
  });

  it('sanitizes state-read failures before handing them to BullMQ', async () => {
    vi.mocked(getJobState).mockRejectedValueOnce(rawError());
    await expectSafeRejection(processJob(jobState.hash, new AbortController().signal));
    expect((await getJobState(jobState.hash))?.status).toBe('failed');
    expect(runExplorer).not.toHaveBeenCalled();
  });

  it('does not leak a secondary persistence failure through logs or the rejected error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(runExplorer).mockRejectedValueOnce(rawError());
    vi.mocked(updateJobStatus).mockRejectedValueOnce(rawError());
    await expectSafeRejection(processJob(jobState.hash, new AbortController().signal));
    expect(log).toHaveBeenCalledWith({
      msg: 'failJob could not persist failure state', hash: 'boundary',
      error: 'Job operation failed. Please retry.',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('CANARY');
  });

  it('keeps the registered BullMQ processor rejection and failed handler safe', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    startWorker();
    vi.mocked(runExplorer).mockRejectedValueOnce(rawError());
    await expectSafeRejection(workerHooks.processor!({ data: { hash: 'boundary' } }));
    await workerHooks.failed!({ data: { hash: 'boundary' } }, rawError());
    expect(log).toHaveBeenCalledWith({
      msg: 'Worker job failed', hash: 'boundary', error: 'Job operation failed. Please retry.',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('CANARY');
    expect(JSON.stringify(publish.mock.calls)).not.toContain('CANARY');
  });

  it('uses the fixed timeout abort reason without attaching upstream errors', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    startWorker();
    vi.mocked(runExplorer).mockImplementationOnce((_state, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    }));
    const operation = workerHooks.processor!({ data: { hash: 'boundary' } });
    const rejection = operation.then(() => undefined, (reason: unknown) => reason);
    await vi.runAllTimersAsync();
    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('Expected timeout rejection');
    expect(error.message).toBe('Job exceeded maximum duration (20 min)');
    expect(error.cause).toBeUndefined();
    expect(error.stack).not.toContain('CANARY');
    expect((await getJobState('boundary'))?.error).toBe('Job exceeded maximum duration (20 min)');
    expect(JSON.stringify(publish.mock.calls)).not.toContain('CANARY');
  });
});
