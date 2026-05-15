// API base URL — empty in dev (Vite proxy handles /api), absolute in Docker
// Set via VITE_API_URL env var at build time (docker-compose.yml)
export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '';
