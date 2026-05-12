/**
 * Shared type definitions for PickleScout backend.
 * Keep in sync with frontend/src/types.ts (manually — no shared package).
 */

// ─── Job Status ───────────────────────────────────────────────────────────────

export type JobStatus =
  | 'queued'
  | 'exploring'
  | 'generating'
  | 'verifying'
  | 'self_healing'
  | 'completed'
  | 'failed';

// ─── LLM Provider ─────────────────────────────────────────────────────────────

export type LLMProvider = 'openai' | 'openrouter' | 'anthropic' | 'gemini' | 'custom';

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  model: string;
  baseURL?: string; // required when provider === 'custom'
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export interface AuthConfig {
  type: 'form';
  loginUrl: string;
  username: string;
  password: string;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
}

// ─── Job Options ──────────────────────────────────────────────────────────────

export type VerificationMode = 'syntax-only' | 'smoke' | 'full';

export interface JobOptions {
  maxScenarios: number;    // 1-10
  positiveRatio: number;   // 0.0-1.0
  maxSteps: number;        // 1-50
  verificationMode: VerificationMode;
  maxRetries: number;      // 0-5
}

// ─── API Request / Response ───────────────────────────────────────────────────

export interface CreateJobRequest {
  url: string;
  hint?: string;
  auth?: AuthConfig;
  llm: LLMConfig;
  options: JobOptions;
}

export interface CreateJobResponse {
  hash: string;
  status: JobStatus;
  createdAt: number;
}

// ─── Job State (stored in Redis as JSON) ──────────────────────────────────────

export interface JobProgress {
  currentStep: number;
  maxSteps: number;
  lastAction: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  estimatedCostUSD: number;
}

export interface JobState {
  hash: string;
  status: JobStatus;
  url: string;
  hint?: string;
  auth?: AuthConfig | null;
  llm: LLMConfig;
  options: JobOptions;
  progress: JobProgress;
  tokenUsage: TokenUsage;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

// ─── SSE Events ───────────────────────────────────────────────────────────────

export interface StreamEventBase {
  id: number;  // monotonic per job
  ts: number;  // unix ms
}

export interface JobSummary {
  scenarioCount: number;
  unhealedScenarios: number;
  featureFiles: string[];
  verificationPassed: boolean;
  totalTokens: number;
  estimatedCostUSD: number;
}

export type StreamEvent = StreamEventBase & (
  | { type: 'status'; status: JobStatus }
  | { type: 'step'; stepNumber: number; action: string; selector?: string }
  | { type: 'screenshot'; url: string }
  | { type: 'llm_log'; message: string }
  | { type: 'token_usage'; delta: TokenUsage; cumulative: TokenUsage }
  | { type: 'verification'; passed: boolean; errors?: string[] }
  | { type: 'complete'; resultUrl: string; summary: JobSummary }
  | { type: 'error'; message: string; retryable: boolean }
);

// ─── ActionLog ────────────────────────────────────────────────────────────────

export type ActionType = 'goto' | 'observe' | 'click' | 'fill' | 'select' | 'wait' | 'assert';
export type SelectorStrategy = 'data-testid' | 'aria-label' | 'role' | 'css' | 'text';

export interface ActionLogEntry {
  id: string;             // nanoid(10)
  type: ActionType;
  url?: string;           // for 'goto'
  selector?: string;
  selectorStrategy?: SelectorStrategy;
  value?: string;         // for 'fill' / 'select'
  text?: string;          // for 'observe' / 'assert'
  screenshotPath?: string;
  timestamp: number;
}

export interface ActionLog {
  jobHash: string;
  targetUrl: string;
  entries: ActionLogEntry[];
  inferredJourneys: string[];
}

// ─── Step Resolution (compile-time validation) ────────────────────────────────

export interface StepResolutionResult {
  feature: string;
  scenario: string;
  unresolvedSteps: string[];
  ambiguousSteps: string[];
}
