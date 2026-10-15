import { beforeEach, describe, expect, it, vi } from 'vitest';

const { appendSseEvent, publish } = vi.hoisted(() => ({
  appendSseEvent: vi.fn().mockResolvedValue(undefined),
  publish: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../redis', () => ({
  appendSseEvent,
  getSsePublisher: vi.fn(() => ({ publish })),
  sseChannelForJob: vi.fn((hash: string) => `sse:events:${hash}`),
}));

import { emitEvent, resetJobCounter } from './sse';

describe('emitEvent sanitization chokepoint', () => {
  beforeEach(() => {
    appendSseEvent.mockClear();
    publish.mockClear();
    resetJobCounter('h1');
  });

  it('sanitizes an unknown error message before buffering and publishing', async () => {
    await emitEvent('h1', { type: 'error', message: 'raw upstream sk-canary' });

    const buffered = appendSseEvent.mock.calls[0][1];
    expect(buffered.message).toBe('Job operation failed. Please retry.');
    expect(buffered.message).not.toContain('sk-canary');

    const published = JSON.parse(publish.mock.calls[0][1]);
    expect(published.message).toBe('Job operation failed. Please retry.');
    expect(published.message).not.toContain('sk-canary');
  });

  it('passes a known static message through byte-identical', async () => {
    await emitEvent('h1', { type: 'error', message: 'Cancelled by user', retryable: false });

    const buffered = appendSseEvent.mock.calls[0][1];
    expect(buffered.message).toBe('Cancelled by user');
    expect(buffered.retryable).toBe(false);

    const published = JSON.parse(publish.mock.calls[0][1]);
    expect(published.message).toBe('Cancelled by user');
  });

  it('leaves non-diagnostic event types unchanged', async () => {
    await emitEvent('h1', { type: 'status', status: 'generating' });

    const buffered = appendSseEvent.mock.calls[0][1];
    expect(buffered.status).toBe('generating');
  });
});
