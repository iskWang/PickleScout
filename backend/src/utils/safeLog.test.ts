import { describe, it, expect } from 'vitest';
import { safeLog } from './safeLog';

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
});
