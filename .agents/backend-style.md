# Backend Style Guide

## Technology Choice
- **Runtime**: Node.js 20
- **Framework**: Fastify 4 (TypeScript)
- **Database**: Redis 7
- **Queue**: BullMQ 5
- **Automation**: Stagehand v3

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
