import type * as FastifyModule from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RedisModule from './redis';

const captured = vi.hoisted(() => {
  const state: { app?: FastifyInstance } = {};
  return state;
});

vi.mock('fastify', async (importOriginal) => {
  const actual = await importOriginal<typeof FastifyModule>();
  return {
    ...actual,
    default: (options: FastifyServerOptions) => {
      const app = actual.default(options);
      captured.app = app;
      // Keep real registration/injection; replace only the network listener.
      vi.spyOn(app, 'listen').mockImplementation(async () => {
        await app.ready();
        return 'http://0.0.0.0:3000';
      });
      return app;
    },
  };
});
vi.mock('./startup', () => ({
  ensureScreenshotStorageDir: vi.fn().mockResolvedValue(undefined),
  runStartupTasks: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./worker', () => ({ startWorker: vi.fn(), generationQueue: {} }));
vi.mock('./reconciler', () => ({ startReconciler: vi.fn() }));
vi.mock('@fastify/static', () => ({ default: async () => {} }));
vi.mock('./redis', async (importOriginal) => ({
  ...await importOriginal<typeof RedisModule>(),
  getJobState: vi.fn().mockResolvedValue(null),
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('LOG_LEVEL', 'silent');
  vi.stubEnv('PORT', '3000');
});

afterEach(async () => {
  await captured.app?.close();
  captured.app = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function startBackend(origins: string | undefined): Promise<FastifyInstance> {
  vi.stubEnv('CORS_ORIGINS', origins);
  // Each case must reload the side-effectful entrypoint after changing its env.
  await import('./index');
  await vi.waitFor(() => {
    expect(captured.app?.listen).toHaveBeenCalledWith({ port: 3000, host: '0.0.0.0' });
  });
  const app = captured.app;
  if (!app) throw new Error('Entrypoint did not create a Fastify instance');
  await app.ready();
  return app;
}

describe('entrypoint CORS registration', () => {
  it.each([
    [undefined, 'http://localhost:5173', 'http://localhost:5173'],
    [undefined, 'http://frontend:5173', 'http://frontend:5173'],
    [undefined, 'http://localhost:5175', undefined],
    ['http://localhost:5175', 'http://localhost:5175', 'http://localhost:5175'],
    ['http://localhost:5175', 'https://evil.example', undefined],
    ['http://localhost:5175', 'http://localhost:5173', undefined],
    ['https://one.example,https://two.example', 'https://one.example', 'https://one.example'],
    ['https://one.example,https://two.example', 'https://two.example', 'https://two.example'],
    ['https://one.example,https://two.example', 'https://evil.example', undefined],
    ['', 'http://localhost:5173', undefined],
    ['*', 'https://evil.example', undefined],
    ['https://one.example,*', 'https://one.example', 'https://one.example'],
    ['https://one.example,*', 'https://evil.example', undefined],
    ['https://one.example', 'https://one.example.evil.example', undefined],
    ['https://one.example, https://two.example', 'https://two.example', undefined],
  ])('CORS_ORIGINS=%s, Origin=%s yields ACAO=%s', async (origins, origin, allowedOrigin) => {
    const app = await startBackend(origins);
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/jobs',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(preflight.headers['access-control-allow-methods']).toBe('GET, POST, DELETE');
    expect(preflight.headers['access-control-allow-headers']).toBe('content-type');

    const health = await app.inject({ method: 'GET', url: '/health', headers: { origin } });
    expect(health.statusCode).toBe(200);
    expect(health.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(health.json()).toEqual({ status: 'ok', ts: expect.any(Number) });
  });

  it('keeps real job validation and CORS headers on failed requests', async () => {
    const app = await startBackend('http://localhost:5175');
    const response = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { origin: 'http://localhost:5175' },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'Invalid request' });
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5175');
  });
});
