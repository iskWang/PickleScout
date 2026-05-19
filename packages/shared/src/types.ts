// Types shared between frontend and backend.

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

// ─── PageModel — Structured observations from Explorer ────────────────────────

export interface FormField {
  label: string;
  inputType: string;
  selector: string;
}

export interface PageForm {
  fields: FormField[];
  submitLabel: string;
  submitSelector: string;
}

export interface NavItem {
  label: string;
  url: string;
  selector: string;
}

export interface PageElement {
  label: string;
  role: string;
  selector: string;
  selectorType: 'css' | 'aria' | 'text' | 'xpath';
  description: string;
}

export interface PageModel {
  url: string;
  elements: PageElement[];
  forms: PageForm[];
  navigation: NavItem[];
}

// ─── IntentSpec — LLM JSON output schema ──────────────────────────────────────

export interface IntentStep {
  templateId: string;
  params: Record<string, string>;
  description: string;
}

export interface IntentScenario {
  name: string;
  steps: IntentStep[];
}

export interface IntentSpec {
  version: string;
  targetUrl: string;
  scenarios: IntentScenario[];
}

// ─── Selector Registry — Validated Playwright locators ───────────────────────

export type LocatorExpr = string;
export type SelectorRegistry = Record<string, LocatorExpr>;

// ─── Stream Events ────────────────────────────────────────────────────────────

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

