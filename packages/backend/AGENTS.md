# Backend — Agent Context

## Stagehand Lifecycle
- One `Stagehand` instance per job.
- **MUST** call `destroy()` on job completion or failure.

## Queue & Concurrency
- `bullmq` manages the `generation` queue.
- Concurrency limited by `MAX_CONCURRENT_JOBS`.

## Redis Key Prefixes
- `job:`: Metadata.
- `events:`: SSE buffer.
- `bull:`: Internal queue.

## Security
- Always wrap logs with `safeLog()` if they contain job data.
- Redact sensitive credentials.

## Environment Variables
- `REDIS_URL`
- `MAX_CONCURRENT_JOBS`
- `STORAGE_DIR`
- `JOB_TTL_DAYS`
