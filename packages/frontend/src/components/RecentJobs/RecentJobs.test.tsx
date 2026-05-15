import { describe, it, expect, beforeEach } from 'vitest';
import { saveRecentJob, loadRecentJobs, removeRecentJob } from './index';

beforeEach(() => {
  localStorage.clear();
});

describe('saveRecentJob / loadRecentJobs', () => {
  it('persists a job and loads it back', () => {
    saveRecentJob({ hash: 'abc123', url: 'https://example.com', createdAt: 1000, status: 'completed' });
    const jobs = loadRecentJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].hash).toBe('abc123');
    expect(jobs[0].url).toBe('https://example.com');
    expect(jobs[0].status).toBe('completed');
  });

  it('deduplicates by hash — updates in-place (most-recent first)', () => {
    saveRecentJob({ hash: 'abc', url: 'https://a.com', createdAt: 1000, status: 'queued' });
    saveRecentJob({ hash: 'abc', url: 'https://a.com', createdAt: 2000, status: 'completed' });
    const jobs = loadRecentJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('completed');
  });

  it('stores multiple jobs newest-first', () => {
    saveRecentJob({ hash: 'a', url: 'https://a.com', createdAt: 1000, status: 'queued' });
    saveRecentJob({ hash: 'b', url: 'https://b.com', createdAt: 2000, status: 'completed' });
    const jobs = loadRecentJobs();
    expect(jobs[0].hash).toBe('b');
    expect(jobs[1].hash).toBe('a');
  });
});

describe('removeRecentJob', () => {
  it('removes a job by hash', () => {
    saveRecentJob({ hash: 'x1', url: 'https://x.com', createdAt: 1000, status: 'queued' });
    saveRecentJob({ hash: 'x2', url: 'https://y.com', createdAt: 2000, status: 'failed' });
    removeRecentJob('x1');
    const jobs = loadRecentJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].hash).toBe('x2');
  });

  it('is a no-op for a hash that does not exist', () => {
    saveRecentJob({ hash: 'keep', url: 'https://keep.com', createdAt: 1000, status: 'completed' });
    removeRecentJob('nonexistent');
    expect(loadRecentJobs()).toHaveLength(1);
  });
});
