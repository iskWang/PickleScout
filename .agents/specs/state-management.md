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

## SSE Event Schema
```typescript
interface StreamEvent {
  id: number;
  ts: number;
  type: 'status' | 'step' | 'screenshot' | 'llm_log' | 'token_usage' | 'verification' | 'complete' | 'error';
  // ... payload based on type
}
```
