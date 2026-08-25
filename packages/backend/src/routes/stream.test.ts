import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

type SseRaw = EventEmitter & {
  writeHead: (statusCode: number, headers: Record<string, string>) => void;
  write: (chunk: string) => void;
  end: () => void;
};

type StreamRequest = {
  params: { hash: string };
  headers: Record<string, string | string[] | undefined>;
  raw: SseRaw;
};

type StreamReply = { raw: SseRaw };

type StreamHandler = (request: StreamRequest, reply: StreamReply) => Promise<void>;

const subscribeStarted = deferred();
const allowSubscribe = deferred();
const unsubscribe = vi.fn().mockResolvedValue(undefined);
const quit = vi.fn().mockResolvedValue(undefined);
const subscriber = Object.assign(new EventEmitter(), {
  subscribe: vi.fn(async () => { subscribeStarted.resolve(); await allowSubscribe.promise; }),
  unsubscribe,
  quit,
});

vi.mock('../redis', () => ({
  getJobState: vi.fn().mockResolvedValue({ hash: 'early', status: 'generating' }),
  getSseEvents: vi.fn().mockResolvedValue([]),
  getSseSubscriber: vi.fn(() => subscriber),
  sseChannelForJob: vi.fn((hash: string) => `sse:events:${hash}`),
  TERMINAL_STATUSES: new Set(['completed', 'failed']),
}));

import { streamRoutes } from './stream';

describe('SSE early disconnect', () => {
  it('cleans subscriber when close fires while subscribe is pending', async () => {
    let handler!: StreamHandler;
    const fastify = {
      get: vi.fn((_path: string, routeHandler: StreamHandler) => { handler = routeHandler; }),
    };
    await streamRoutes(fastify as unknown as FastifyInstance);

    const raw = Object.assign(new EventEmitter(), {
      writeHead: vi.fn(), write: vi.fn(), end: vi.fn(),
    }) as SseRaw;
    const request: StreamRequest = { params: { hash: 'early' }, headers: {}, raw };
    const reply: StreamReply = { raw };
    const pending = handler(request, reply);
    await subscribeStarted.promise;
    raw.emit('close');
    allowSubscribe.resolve();
    await pending;

    expect(unsubscribe).toHaveBeenCalledWith('sse:events:early');
    expect(quit).toHaveBeenCalledOnce();
    expect(raw.end).toHaveBeenCalledOnce();
  });
});
