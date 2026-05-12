/**
 * Frontend shared types — manually kept in sync with backend/src/types.ts.
 * DO NOT import from backend — no shared package in this project.
 */

export type JobStatus =
  | 'queued'
  | 'exploring'
  | 'generating'
  | 'verifying'
  | 'self_healing'
  | 'completed'
  | 'failed';

export type LLMProvider = 'openai' | 'openrouter' | 'anthropic' | 'gemini' | 'custom';

export type VerificationMode = 'syntax-only' | 'smoke' | 'full';

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  model: string;
  baseURL?: string;
}

export interface AuthConfig {
  type: 'form';
  loginUrl: string;
  username: string;
  password: string;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
}

export interface JobOptions {
  maxScenarios: number;
  positiveRatio: number;
  maxSteps: number;
  verificationMode: VerificationMode;
  maxRetries: number;
}

export interface CreateJobRequest {
  url: string;
  hint?: string;
  auth?: AuthConfig;
  llm: LLMConfig;
  options: JobOptions;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  estimatedCostUSD: number;
}

export interface JobSummary {
  scenarioCount: number;
  unhealedScenarios: number;
  featureFiles: string[];
  verificationPassed: boolean;
  totalTokens: number;
  estimatedCostUSD: number;
}

// SSE Events
export interface StreamEventBase {
  id: number;
  ts: number;
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

// localStorage recent jobs
export interface RecentJob {
  hash: string;
  url: string;
  createdAt: number;
  status: JobStatus;
  scenarioCount?: number;
}
