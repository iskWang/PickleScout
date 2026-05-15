# Frontend — Agent Context

## Route Map
- `/`: `JobForm`
- `/jobs/:hash`: `JobDetail`

## SSE Pattern
- Use `EventSource` with `Last-Event-ID` for reconnection.
- Replay events from state if `id` matches.

## Component Layout
- `src/components/ComponentName/index.tsx`
- CSS modules preferred.

## Syntax Highlighting
- Library: `prism-react-renderer` for feature file previews.

## localStorage
- Key: `recent_jobs` (max 20).
