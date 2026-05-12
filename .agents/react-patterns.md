# React Patterns — PickleScout

## Component Directory Structure
```
ComponentName/
├── index.tsx
├── ComponentName.css
└── ComponentName.test.tsx
```

## Custom Hooks
- Extract logic from components into custom hooks for testability.
- Example: `useJobStream(hash: string)` to encapsulate SSE logic.

## Prop Types
- Use TypeScript `interface` for all props.
- Prefer explicit types over `any`.

## Performance
- Use `useMemo` and `useCallback` sparingly, only when profiling shows a need.
- Keep components small and focused on a single responsibility.
