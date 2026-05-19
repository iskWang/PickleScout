import { describe, it, expect, vi } from 'vitest';
import type { LLMConfig } from '../types';

vi.mock('playwright-core', () => ({
  chromium: { executablePath: () => '/usr/bin/chromium-stub' },
}));

vi.mock('@browserbasehq/stagehand', () => ({
  V3: class {},
}));

vi.mock('../redis', () => ({
  updateJobStatus: vi.fn(),
  getJobState: vi.fn(),
}));

vi.mock('./sse', () => ({
  emitEvent: vi.fn(),
}));

import { buildStagehandOptions } from './explorer';

const mockLlm: LLMConfig = { provider: 'openai', model: 'gpt-4o', apiKey: 'test-key' };

describe('buildStagehandOptions — systemPrompt (ISC-41–45)', () => {
  it('returns a non-empty systemPrompt', () => {
    const opts = buildStagehandOptions(mockLlm);
    expect(opts.systemPrompt).toBeTruthy();
  });
  it('systemPrompt contains data-testid', () => {
    expect(buildStagehandOptions(mockLlm).systemPrompt).toContain('data-testid');
  });
  it('systemPrompt contains data-id', () => {
    expect(buildStagehandOptions(mockLlm).systemPrompt).toContain('data-id');
  });
  it('systemPrompt contains data-command-category', () => {
    expect(buildStagehandOptions(mockLlm).systemPrompt).toContain('data-command-category');
  });
  it('systemPrompt forbids XPath', () => {
    expect(buildStagehandOptions(mockLlm).systemPrompt).toMatch(/xpath/i);
  });
});
