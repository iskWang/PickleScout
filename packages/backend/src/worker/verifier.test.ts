import { vi, describe, it, expect, beforeEach } from 'vitest';
import path from 'path';

// Mock side-effecting modules before importing the module under test
vi.mock('./sse', () => ({ emitEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../redis', () => ({ updateJobStatus: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./generator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./generator')>();
  return { ...actual, buildOpenAIClient: vi.fn() };
});

import { extractCucumberErrors, attemptSelfHeal } from './verifier';
import { buildOpenAIClient } from './generator';
import type { JobState } from '../types';

const FIXTURES = path.join(__dirname, '__fixtures__');

function makeJobState(): JobState {
  return {
    hash: 'test-hash',
    url: 'https://example.com',
    status: 'self_healing',
    llm: { provider: 'openrouter', apiKey: 'test-key', model: 'test-model' },
    options: { maxScenarios: 3, positiveRatio: 0.8, maxSteps: 15, verificationMode: 'smoke', maxRetries: 2 },
    tokenUsage: { promptTokens: 0, completionTokens: 0, estimatedCostUSD: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as JobState;
}

function mockLLMResponse(content: string) {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
      },
    },
  };
}

// ─── extractCucumberErrors ────────────────────────────────────────────────────

describe('extractCucumberErrors', () => {
  it('returns error string with scenario name on failure', async () => {
    const errors = await extractCucumberErrors(path.join(FIXTURES, 'cucumber-result-failed.json'), ['fallback']);
    expect(errors[0]).toContain('Create a new sales order');
  });

  it('includes the failed step name', async () => {
    const errors = await extractCucumberErrors(path.join(FIXTURES, 'cucumber-result-failed.json'), []);
    expect(errors[0]).toContain('I click the New button');
  });

  it('includes the error_message text', async () => {
    const errors = await extractCucumberErrors(path.join(FIXTURES, 'cucumber-result-failed.json'), []);
    expect(errors[0]).toContain('TimeoutError');
  });

  it('returns fallback when all steps pass', async () => {
    const fallback = ['no real errors'];
    const errors = await extractCucumberErrors(path.join(FIXTURES, 'cucumber-result-passed.json'), fallback);
    expect(errors).toEqual(fallback);
  });

  it('treats undefined steps as errors', async () => {
    const errors = await extractCucumberErrors(path.join(FIXTURES, 'cucumber-result-undefined.json'), []);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('treats pending steps as errors', async () => {
    const errors = await extractCucumberErrors(path.join(FIXTURES, 'cucumber-result-pending.json'), []);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('does not generate errors for skipped steps — only one error for the failed step', async () => {
    const errors = await extractCucumberErrors(path.join(FIXTURES, 'cucumber-result-failed.json'), []);
    expect(errors).toHaveLength(1);
  });

  it('falls back to raw array when file does not exist', async () => {
    const fallback = ['raw stderr output'];
    const errors = await extractCucumberErrors('/nonexistent/path.json', fallback);
    expect(errors).toEqual(fallback);
  });

  it('falls back to raw array when file contains invalid JSON', async () => {
    const fallback = ['raw stderr'];
    const errors = await extractCucumberErrors(path.join(FIXTURES, 'cucumber-result-invalid.json'), fallback);
    expect(errors).toEqual(fallback);
  });
});

// ─── attemptSelfHeal — JSON parsing ──────────────────────────────────────────

describe('attemptSelfHeal — JSON parsing', () => {
  const stepFiles = [{ filename: 'common.steps.ts', content: 'Given("x", async () => {})' }];
  const errors = ['TimeoutError on selector #btn'];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handles plain JSON response', async () => {
    const payload = JSON.stringify({ files: [{ filename: 'common.steps.ts', content: 'fixed' }] });
    (buildOpenAIClient as ReturnType<typeof vi.fn>).mockReturnValue(mockLLMResponse(payload));
    const result = await attemptSelfHeal(makeJobState(), stepFiles, errors);
    expect(result[0].content).toBe('fixed');
  });

  it('handles markdown-fenced JSON response', async () => {
    const payload = '```json\n' + JSON.stringify({ files: [{ filename: 'common.steps.ts', content: 'fixed2' }] }) + '\n```';
    (buildOpenAIClient as ReturnType<typeof vi.fn>).mockReturnValue(mockLLMResponse(payload));
    const result = await attemptSelfHeal(makeJobState(), stepFiles, errors);
    expect(result[0].content).toBe('fixed2');
  });

  it('throws on non-JSON response', async () => {
    (buildOpenAIClient as ReturnType<typeof vi.fn>).mockReturnValue(mockLLMResponse('I cannot repair these files.'));
    await expect(attemptSelfHeal(makeJobState(), stepFiles, errors))
      .rejects.toThrow('Self-heal LLM returned invalid JSON');
  });

  it('throws on wrong structure (missing files key)', async () => {
    const payload = JSON.stringify({ result: [{ filename: 'x.ts', content: '...' }] });
    (buildOpenAIClient as ReturnType<typeof vi.fn>).mockReturnValue(mockLLMResponse(payload));
    await expect(attemptSelfHeal(makeJobState(), stepFiles, errors))
      .rejects.toThrow('Self-heal LLM returned unexpected structure');
  });
});
