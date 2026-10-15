/**
 * safeLog — redacts sensitive fields before any logging.
 *
 * NEVER log apiKey, password, cookie, or authorization directly.
 * Always call safeLog() first when the data may contain job state.
 *
 * Also suppresses raw error/err/cause/stack diagnostics: only an
 * allowlist of code-owned safe messages ever reaches a log or SSE
 * event; everything else collapses to a fixed generic message so
 * exception internals (stack traces, upstream error text, secrets
 * accidentally embedded in them) never leave the process.
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

// Keys whose values are raw exception diagnostics — never log verbatim.
const DIAGNOSTIC_FIELDS = ['error', 'err', 'cause', 'stack'];

export const GENERIC_DIAGNOSTIC_MESSAGE = 'Job operation failed. Please retry.';
export const GENERIC_PROGRESS_MESSAGE = 'Worker progress update.';
export const VERIFICATION_FAILED_MESSAGE = 'Verification failed.';
const MAX_VERIFICATION_ERRORS = 5;

// Exact, static, code-owned messages that are safe to surface as-is.
// Anything not in this table — including dynamic/templated text and raw
// stdout/stderr — collapses to a generic message.
const SAFE_DIAGNOSTIC_MESSAGES: Record<string, true> = {
  'Cancelled by user': true,
  'Service restarted. Please retry your job.': true,
  'Job queue entry lost unexpectedly — please retry.': true,
  'Job exceeded maximum duration (20 min)': true,
  'Self-heal response rejected.': true,
};

const SAFE_LLM_LOG_MESSAGES: Record<string, true> = {
  'Pass 1: generating Gherkin scenarios…': true,
  'LLM output parse error, retrying Pass 1…': true,
  'Pass 2: mapping steps to templates…': true,
  'LLM output parse error, retrying Pass 2…': true,
  'Step resolution failed — regenerating Pass 2…': true,
  'Step resolution: all steps resolved after regeneration': true,
  'Packaging output zip…': true,
  'Syntax check: installing deps…': true,
  'Syntax check: compiling TypeScript…': true,
  'Flake detected, retrying once…': true,
  'Self-healing: analyzing verification failures…': true,
  'Self-heal response rejected.': true,
};

/**
 * Reduces an unknown error/diagnostic value to a safe string. Only exact
 * matches against SAFE_DIAGNOSTIC_MESSAGES pass through; everything else
 * (including Error.message, raw strings, objects) becomes the fixed
 * generic message. Never stringifies/reflects the unknown value.
 */
export function safeDiagnostic(value: unknown): string {
  const text =
    value instanceof Error
      ? value.message
      : typeof value === 'string'
        ? value
        : undefined;
  return text !== undefined && SAFE_DIAGNOSTIC_MESSAGES[text] === true
    ? text
    : GENERIC_DIAGNOSTIC_MESSAGE;
}

export function safeLog<T>(data: T): T {
  return JSON.parse(
    JSON.stringify(data, (key, value) => {
      if (REDACT_FIELDS.some((f) => key === f || key.endsWith(`.${f}`))) {
        return '[REDACTED]';
      }
      if (value !== undefined && DIAGNOSTIC_FIELDS.includes(key)) {
        return safeDiagnostic(value);
      }
      return value;
    })
  ) as T;
}

/**
 * Clones a stream/SSE event with its diagnostic payload sanitized.
 * - type 'error': message runs through safeDiagnostic.
 * - type 'verification': errors (if present) are capped at 5 and each
 *   replaced with the fixed VERIFICATION_FAILED_MESSAGE — never the
 *   underlying Cucumber/Playwright output.
 * - type 'llm_log': message must exactly match a known static stage
 *   message, else it collapses to GENERIC_PROGRESS_MESSAGE.
 * All other event fields and all other event types are left unchanged.
 */
export function sanitizeDiagnosticEvent<T extends { type: string }>(event: T): T {
  const clone: { type: string } & Record<string, unknown> = { ...event };

  if (clone.type === 'error' && 'message' in clone) {
    clone.message = safeDiagnostic(clone.message);
  } else if (clone.type === 'verification' && Array.isArray(clone.errors)) {
    clone.errors = clone.errors
      .slice(0, MAX_VERIFICATION_ERRORS)
      .map(() => VERIFICATION_FAILED_MESSAGE);
  } else if (clone.type === 'llm_log' && typeof clone.message === 'string') {
    clone.message =
      SAFE_LLM_LOG_MESSAGES[clone.message] === true
        ? clone.message
        : GENERIC_PROGRESS_MESSAGE;
  }

  return clone as T;
}
