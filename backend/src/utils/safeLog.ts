/**
 * safeLog — redacts sensitive fields before any logging.
 *
 * NEVER log apiKey, password, cookie, or authorization directly.
 * Always call safeLog() first when the data may contain job state.
 *
 * PRD §8.3
 */

const REDACT_FIELDS = [
  'apiKey',
  'password',
  'cookie',
  'authorization',
  'auth.password',
];

export function safeLog<T>(data: T): T {
  return JSON.parse(
    JSON.stringify(data, (key, value) =>
      REDACT_FIELDS.some((f) => key === f || key.endsWith(`.${f}`))
        ? '[REDACTED]'
        : value
    )
  ) as T;
}
