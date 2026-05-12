# Backend Style Guide

## Technology Choice
- **Runtime**: Node.js 20
- **Framework**: Fastify 4 (TypeScript)
- **Database**: Redis 7
- **Queue**: BullMQ 5
- **Automation**: Stagehand v3

## Coding Conventions
- **Constants**: All constants (e.g., timeouts, directories, default limits) MUST be declared at the top of the file, outside of functions. Do not define constants deep inside functions or loops.
- **PRD Alignment**: Implementation MUST strictly follow naming conventions defined in `docs/PRD.md` (e.g., use `url` instead of `screenshotUrl` for SSE events).

## Asynchronous Abort
- **AbortSignal**: Long-running background worker tasks MUST accept an `AbortSignal`.
- **Cooperative Cancellation**: Non-blocking calls (like `stagehand.act`) MUST be wrapped in a helper that races against the `AbortSignal`.
- **Zombie Prevention**: When a signal aborts, the error MUST be thrown immediately to trigger resource cleanup.

## Browser Automation Hygiene
- **Instance Management**: Use exactly one browser instance/context per job.
- **Graceful Teardown**: Always call `stagehand.close()` in a `finally` block to ensure browser processes are killed even on timeout or error.
- **Action Deduplication**: In the exploration phase, track visited actions using a unique key: `${URL}::${Selector}::${Description}`.

## Security & Redaction
- **NEVER** log sensitive fields: `apiKey`, `password`, `cookie`, `authorization`.
- Use `safeLog()` helper before any logging that might contain job data.

```typescript
const REDACT_FIELDS = ['apiKey', 'password', 'cookie', 'authorization'];

function safeLog<T>(data: T): T {
  return JSON.parse(JSON.stringify(data, (key, value) =>
    REDACT_FIELDS.some(f => key === f || key.endsWith(`.${f}`)) ? '[REDACTED]' : value
  ));
}
```

## Redis Scan Patterns
- **Always** use `scanStream()` with `for await...of` — never use the raw `SCAN` command with a manual cursor loop.
- This avoids cursor management bugs and produces cleaner, more readable code.

```typescript
// ✅ Correct
const keys: string[] = [];
for await (const batch of redis.scanStream({ match: 'job:*', count: 100 })) {
  keys.push(...(batch as string[]));
}

// ❌ Avoid
let cursor = '0';
do {
  const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', 'job:*', 'COUNT', 100);
  cursor = nextCursor;
  keys.push(...batch);
} while (cursor !== '0');
```

## Redis Key Patterns
- `job:{hash}`: Hash containing job metadata and credentials.
- `events:{hash}`: Redis List storing the last 50 SSE events.
- `bull:generation:*`: BullMQ internal keys.

## Worker Concurrency
- Controlled via `MAX_CONCURRENT_JOBS` environment variable.
- Default: 2 (optimized for Mac Mini 16GB).

## Cleanup Policy
- Screenshots: Deleted 1 hour after job completion.
- Job Data (Redis/Storage): Expire after 7 days (`JOB_TTL_DAYS`).
- Orphan Scan: Cleanup files on startup if Redis entry is missing.
