# State Management

## Job State Machine
```
queued → exploring → generating → verifying → completed
                                      ↓
                                self_healing → verifying → completed
                                      ↓ (exceeds maxRetries)
                                   failed
```

## Redis Data Structures

### Job Metadata (`job:{hash}`)
- **Type**: Hash (stored as JSON string)
- **Content**: URL, options, credentials, token usage, current status.
- **TTL**: 7 days.

### SSE Events (`events:{hash}`)
- **Type**: List
- **Content**: Last 50 `StreamEvent` objects.
- **Purpose**: Enables reconnection replay via `Last-Event-ID`.

## State Consistency

Three mechanisms prevent BullMQ and Redis state from drifting:

1. **Startup reconciliation** (`src/startup.ts`): On every backend start, scans all `job:*` keys and marks non-terminal jobs as `failed` ("Service restarted. Please retry your job."). Covers crash / restart recovery.

2. **Runtime reconciler** (`src/reconciler.ts`): Runs every 60 s. For any non-terminal job whose `updatedAt` is older than 5 min, checks for a corresponding BullMQ job. If none found, marks job `failed` and emits SSE `error` + `status` events so connected frontends recover immediately.

3. **GET cross-check** (`GET /api/jobs/:hash`): For non-terminal jobs older than 5 min, verifies BullMQ still has the job on every poll and auto-repairs before returning. Gives immediate recovery without waiting for the next reconciler cycle.

**5-minute grace period**: Both the reconciler and the GET cross-check wait before acting. This avoids false positives from the `removeOnComplete: true` race (BullMQ removes completed jobs before Redis status is updated) and from freshly-queued jobs not yet picked up by the worker.

**Shared constants** (defined in `src/redis.ts`): `TERMINAL_STATUSES`, `ORPHAN_THRESHOLD_MS` (5 min), `ORPHAN_ERROR`.

## SSE Event Schema
```typescript
interface StreamEvent {
  id: number;
  ts: number;
  type: 'status' | 'step' | 'screenshot' | 'llm_log' | 'token_usage' | 'verification' | 'complete' | 'error';
  // ... payload based on type
}
```
