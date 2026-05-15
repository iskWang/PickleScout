export * from '@picklescout/shared';

// ─── API Response ─────────────────────────────────────────────────────────────

export interface CreateJobResponse {
  hash: string;
  status: import('@picklescout/shared').JobStatus;
  createdAt: number;
}

// ─── Job State (stored in Redis as JSON) ──────────────────────────────────────

export interface JobProgress {
  currentStep: number;
  maxSteps: number;
  lastAction: string;
}

export interface JobState {
  hash: string;
  status: import('@picklescout/shared').JobStatus;
  url: string;
  hint?: string;
  auth?: import('@picklescout/shared').AuthConfig | null;
  llm: import('@picklescout/shared').LLMConfig;
  options: import('@picklescout/shared').JobOptions;
  progress: JobProgress;
  tokenUsage: import('@picklescout/shared').TokenUsage;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

// ─── ActionLog ────────────────────────────────────────────────────────────────

export type ActionType = 'goto' | 'observe' | 'click' | 'fill' | 'select' | 'wait' | 'assert';
export type SelectorStrategy = 'data-testid' | 'aria-label' | 'role' | 'css' | 'text';

export interface ActionLogEntry {
  id: string;
  type: ActionType;
  url?: string;
  selector?: string;
  selectorStrategy?: SelectorStrategy;
  value?: string;
  text?: string;
  screenshotPath?: string;
  timestamp: number;
}

export interface ActionLog {
  jobHash: string;
  targetUrl: string;
  entries: ActionLogEntry[];
  inferredJourneys: string[];
}

// ─── Step Resolution ──────────────────────────────────────────────────────────

export interface StepResolutionResult {
  feature: string;
  scenario: string;
  unresolvedSteps: string[];
  ambiguousSteps: string[];
}
