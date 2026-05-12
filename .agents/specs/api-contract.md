# API Contract — PickleScout

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/jobs` | Create a generation job |
| `GET` | `/api/jobs/:hash` | Poll job status |
| `GET` | `/api/jobs/:hash/stream` | SSE event stream |
| `GET` | `/api/jobs/:hash/result` | Download output zip |
| `DELETE` | `/api/jobs/:hash` | Cancel or remove a job |

## Schemas

### Create Job (POST /api/jobs)
```typescript
interface CreateJobRequest {
  url: string;
  hint?: string;
  auth?: AuthConfig;
  llm: {
    provider: 'openai' | 'openrouter' | 'anthropic' | 'gemini' | 'custom';
    apiKey: string;
    model: string;
    baseURL?: string;
  };
  options: {
    maxScenarios: number;
    positiveRatio: number;
    maxSteps: number;
    verificationMode: 'syntax-only' | 'smoke' | 'full';
    maxRetries: number;
  };
}
```

### Job Status
```typescript
type JobStatus =
  | 'queued'
  | 'exploring'
  | 'generating'
  | 'verifying'
  | 'self_healing'
  | 'completed'
  | 'failed';

### SSE Events (GET /api/jobs/:hash/stream)
```typescript
interface StreamEvent {
  id: number;
  ts: number;
  type: 
    | 'status' 
    | 'step' 
    | 'screenshot' 
    | 'llm_log' 
    | 'token_usage' 
    | 'verification' 
    | 'complete' 
    | 'error';
  // ... event-specific fields
}

// Screenshot event detail
// { type: 'screenshot', url: string }
```
