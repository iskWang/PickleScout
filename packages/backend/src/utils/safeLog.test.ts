import { describe, it, expect } from 'vitest';
import { safeLog, safeDiagnostic, sanitizeDiagnosticEvent } from './safeLog';

describe('sanitizeDiagnosticEvent — fixed self-heal messages', () => {
  it.each(['Self-healing: analyzing verification failures…', 'Self-heal response rejected.'])('keeps %s visible', (message) => {
    expect(sanitizeDiagnosticEvent({ type: 'llm_log', message }).message).toBe(message);
  });
});

describe('safeLog', () => {
  it('redacts top-level apiKey', () => {
    const result = safeLog({ apiKey: 'sk-secret', model: 'gpt-4' });
    expect(result.apiKey).toBe('[REDACTED]');
    expect(result.model).toBe('gpt-4');
  });

  it('redacts nested auth.password', () => {
    const result = safeLog({ auth: { username: 'josh', password: 'hunter2' }, url: 'https://example.com' });
    expect(result.auth.password).toBe('[REDACTED]');
    expect(result.auth.username).toBe('josh');
    expect(result.url).toBe('https://example.com');
  });

  it('preserves non-sensitive fields intact', () => {
    const result = safeLog({ hash: 'abc123', status: 'queued', url: 'https://demo.odoo.com' });
    expect(result).toEqual({ hash: 'abc123', status: 'queued', url: 'https://demo.odoo.com' });
  });

  it('redacts apiKey nested inside llm object', () => {
    const result = safeLog({ llm: { apiKey: 'secret', provider: 'openrouter', model: 'claude' } });
    expect(result.llm.apiKey).toBe('[REDACTED]');
    expect(result.llm.provider).toBe('openrouter');
  });

  it('redacts cookie field', () => {
    const result = safeLog({ cookie: 'session=abc', path: '/' });
    expect(result.cookie).toBe('[REDACTED]');
    expect(result.path).toBe('/');
  });

  it('suppresses unknown error field value and preserves other fields', () => {
    const result = safeLog({ error: 'password-canary', llm: { apiKey: 'key-canary' }, count: 2 });
    expect(result.error).toBe('Job operation failed. Please retry.');
    expect(JSON.stringify(result)).not.toContain('password-canary');
    expect(JSON.stringify(result)).not.toContain('key-canary');
    expect(result.llm.apiKey).toBe('[REDACTED]');
    expect(result.count).toBe(2);
  });

  it('preserves known-safe error messages', () => {
    const result = safeLog({ error: 'Cancelled by user' });
    expect(result.error).toBe('Cancelled by user');
  });
});

describe('safeDiagnostic', () => {
  it('reduces unknown Error instances to the generic message', () => {
    expect(safeDiagnostic(new Error('sk-canary'))).toBe('Job operation failed. Please retry.');
  });

  it('reduces arbitrary strings to the generic message', () => {
    expect(safeDiagnostic('some upstream stack trace sk-canary')).toBe('Job operation failed. Please retry.');
  });

  it('preserves an exact known-safe message', () => {
    expect(safeDiagnostic('Cancelled by user')).toBe('Cancelled by user');
  });
});

describe('sanitizeDiagnosticEvent', () => {
  it('sanitizes unknown error event messages', () => {
    const event = { type: 'error' as const, message: 'sk-canary leaked', retryable: true };
    const result = sanitizeDiagnosticEvent(event);
    expect(result.message).toBe('Job operation failed. Please retry.');
    expect(result.retryable).toBe(true);
  });

  it('caps and fixes verification errors', () => {
    const event = {
      type: 'verification' as const,
      passed: false,
      errors: ['sk-canary-1', 'sk-canary-2', 'c', 'd', 'e', 'f'],
    };
    const result = sanitizeDiagnosticEvent(event);
    expect(result.errors).toHaveLength(5);
    expect(result.errors.every((e) => e === 'Verification failed.')).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('collapses unknown llm_log chunks to a generic progress message', () => {
    const first = sanitizeDiagnosticEvent({ type: 'llm_log' as const, message: 'sk-ca' });
    const second = sanitizeDiagnosticEvent({ type: 'llm_log' as const, message: 'nary' });
    expect(first.message).toBe('Worker progress update.');
    expect(second.message).toBe('Worker progress update.');
  });

  it('preserves a known static llm_log stage message', () => {
    const result = sanitizeDiagnosticEvent({
      type: 'llm_log' as const,
      message: 'Pass 1: generating Gherkin scenarios…',
    });
    expect(result.message).toBe('Pass 1: generating Gherkin scenarios…');
  });

  it('leaves non-diagnostic event types unchanged', () => {
    const event = { type: 'status' as const, status: 'queued' as const };
    expect(sanitizeDiagnosticEvent(event)).toEqual(event);
  });
});
