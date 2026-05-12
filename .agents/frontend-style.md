# Frontend Style Guide

## Technology Choice
- **Framework**: React 18 (TypeScript)
- **Build Tool**: Vite 5
- **Styling**: Vanilla CSS (Priority: minimal, functional, professional)

## Component Structure
- Use Functional Components with Hooks.
- Directory per component: `src/components/ComponentName/index.tsx`.
- Keep styles local to components where possible (CSS Modules or plain CSS).

## State Management
- **Local**: `useState`, `useReducer`.
- **Async**: `fetch` with `useEffect` or custom hooks.
- **SSE**: Use native `EventSource` with `Last-Event-ID` header support for reconnection.

## SSE Client Pattern
```typescript
const eventSource = new EventSource(`/api/jobs/${hash}/stream`, {
  headers: lastEventId ? { 'Last-Event-ID': lastEventId } : {}
});

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // Update state...
};
```

## Route Map
- `/`: `JobForm` (submission)
- `/jobs/:hash`: `JobDetail` (monitoring + results)

## LocalStorage
- Key: `recent_jobs`
- Schema: `Array<{ hash: string, url: string, createdAt: number, status: JobStatus }>`
- Max 20 entries.
