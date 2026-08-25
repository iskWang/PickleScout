import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionLog, IntentSpec, JobState } from '../types';

const completionCreate = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: completionCreate } };
  },
}));

vi.mock('../redis', () => ({
  getJobState: vi.fn().mockResolvedValue(null),
  updateJobStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./sse', () => ({
  emitEvent: vi.fn().mockResolvedValue(undefined),
}));

const HASH = 'rerun-pass2-test';
let storageDir: string;

const intentSpec: IntentSpec = {
  version: '1.0.0',
  targetUrl: 'https://example.com',
  scenarios: [
    {
      name: 'Updated scenario',
      steps: [
        {
          templateId: 'navigate_to_url',
          params: { url: 'https://example.com' },
          description: 'navigate',
        },
        {
          templateId: 'assert_visible',
          params: { text: 'Updated content' },
          description: 'assert content',
        },
      ],
    },
  ],
};

const state: JobState = {
  hash: HASH,
  status: 'generating',
  url: 'https://example.com',
  llm: { provider: 'openai', apiKey: 'test-key', model: 'test-model' },
  options: {
    maxScenarios: 1,
    positiveRatio: 1,
    maxSteps: 5,
    verificationMode: 'syntax-only',
    maxRetries: 0,
  },
  progress: { currentStep: 0, maxSteps: 5, lastAction: '' },
  tokenUsage: { promptTokens: 0, completionTokens: 0, estimatedCostUSD: 0 },
  createdAt: 0,
  updatedAt: 0,
};

const actionLog: ActionLog = {
  jobHash: HASH,
  targetUrl: 'https://example.com',
  entries: [],
  inferredJourneys: [],
};

beforeEach(async () => {
  storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picklescout-rerun-'));
  vi.stubEnv('STORAGE_DIR', storageDir);
  vi.resetModules();
  completionCreate.mockReset();
  completionCreate.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify(intentSpec) } }],
    usage: undefined,
  });

  const generatedDir = path.join(storageDir, 'generated', HASH);
  await fs.mkdir(path.join(generatedDir, 'features'), { recursive: true });
  await fs.mkdir(path.join(generatedDir, 'steps'), { recursive: true });
  await fs.writeFile(path.join(generatedDir, 'features', '01_generated.feature'), 'stale feature');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(storageDir, { recursive: true, force: true });
});

describe('rerunPass2', () => {
  it('regenerates and persists feature and step files from the same IntentSpec', async () => {
    // STORAGE_DIR is captured at module load, so this test must import after stubbing the environment.
    const { rerunPass2 } = await import('./generator');

    const result = await rerunPass2(
      state,
      actionLog,
      [{ filename: '01_generated.feature', content: 'stale feature' }],
    );

    expect(result.featureFiles[0].content).toContain('Scenario: Updated scenario');
    expect(result.stepFiles[0].filename).toBe('steps.ts');

    const generatedDir = path.join(storageDir, 'generated', HASH);
    await expect(
      fs.readFile(path.join(generatedDir, 'features', '01_generated.feature'), 'utf-8'),
    ).resolves.toContain('Scenario: Updated scenario');
    await expect(
      fs.readFile(path.join(generatedDir, 'steps', 'steps.ts'), 'utf-8'),
    ).resolves.toBe(result.stepFiles[0].content);
  });
});
